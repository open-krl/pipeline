// src/capture/capture.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { KciClient } from "../api/client";
import type {
	DepartureBoardItem,
	DepartureBoardResponse,
	StationItem,
	StationMasterResponse,
} from "../api/schemas";
import {
	computeBoardResponseHash,
	computeStationMasterHash,
} from "../archive/hashes";
import {
	capturesDir,
	snapshotDir as snapshotDirHelper,
} from "../archive/layout";
import {
	type CaptureManifest,
	CaptureManifestSchema,
	type DayType,
} from "../archive/schemas";
import { scanSnapshots, scanTimetableVersions } from "../archive/snapshots";
import {
	DEFAULT_REGION_SCOPE,
	REGION_GROUPS,
	type RegionScope,
	resolveStationCode,
} from "../config";
import { formatDateWib, resolveDayType } from "../core/calendar";
import { type CommitResult, commitPath } from "../core/git";
import {
	generateDefaultLogPath,
	StructuredLogger,
	startTimer,
} from "../core/logger";
import { resolveSafePath } from "../core/path";
import { loadHolidays } from "../db/holidays";

export interface CaptureOptions {
	client?: KciClient;
	dataDir?: string;
	holidaysPath?: string;
	dayType?: DayType;
	region?: RegionScope;
	newVersion?: boolean;
	yes?: boolean;
	now?: Date;
	promptFn?: (question: string, defaultYes?: boolean) => Promise<boolean>;
	commit?: boolean;
	noCommit?: boolean;
	logger?: StructuredLogger;
	logFilePath?: string;
	noLog?: boolean;
}

export interface CaptureResult {
	timetable_version: number;
	snapshot_id: number;
	snapshot_dir: string;
	manifest: CaptureManifest;
	commitResult?: CommitSnapshotResult;
	logFilePath?: string;
}

export interface FailedStation {
	id: string;
	name: string;
	reason: string;
}

export interface BoardFetchResult {
	boardsMap: Map<string, DepartureBoardItem[]>;
	rawBoardsMap: Map<string, DepartureBoardResponse>;
	failedStations: FailedStation[];
	isDegraded: boolean;
	durationSecs: string;
}

/**
 * Standard CLI prompt helper using node:readline.
 */
async function defaultPrompt(
	question: string,
	defaultYes = false,
): Promise<boolean> {
	if (!process.stdin.isTTY) {
		return defaultYes;
	}
	const rl = readline.createInterface({ input, output });
	try {
		const answer = await rl.question(
			`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `,
		);
		const trimmed = answer.trim().toLowerCase();
		if (trimmed === "") return defaultYes;
		return trimmed === "y" || trimmed === "yes";
	} finally {
		rl.close();
	}
}

export { scanSnapshots, scanTimetableVersions };

/**
 * Filters the station list to operational passenger stops in the active region.
 */
export function filterOperationalStations(
	stations: readonly StationItem[],
	regionScope: RegionScope,
): StationItem[] {
	const allowedGroups = REGION_GROUPS[regionScope];
	const operational = stations.filter((s) => {
		if (s.sta_id.startsWith("WIL")) return false;
		if (!allowedGroups.includes(s.group_wil)) return false;
		return s.fg_enable === 1;
	});

	if (operational.length === 0) {
		throw new Error(
			`No operational stations found for region scope '${regionScope}'.`,
		);
	}

	return operational;
}

/**
 * Normalizes capture options into resolved operational parameters.
 */
export function resolveCaptureContext(options: CaptureOptions) {
	const dataDir = resolveSafePath(options.dataDir ?? "data/raw");
	const regionScope = options.region ?? DEFAULT_REGION_SCOPE;
	const now = options.now ?? new Date();
	const prompt = options.promptFn ?? defaultPrompt;
	const holidays = loadHolidays(options.holidaysPath);
	const snapshotDate = formatDateWib(now);
	const resolvedDayType = options.dayType ?? resolveDayType(now, holidays);

	let logger = options.logger;
	let logFilePath = options.logFilePath;
	if (!logger && !options.noLog) {
		logFilePath =
			options.logFilePath ??
			generateDefaultLogPath("capture", {
				dayType: resolvedDayType,
				now,
				baseDir: options.dataDir ? dataDir : undefined,
			});
		logger = new StructuredLogger({ logFilePath });
	} else if (!logger) {
		logger = new StructuredLogger();
	}
	logFilePath = logger.logFilePath;

	const client = options.client ?? new KciClient({ logger });

	return {
		dataDir,
		client,
		regionScope,
		now,
		prompt,
		snapshotDate,
		resolvedDayType,
		newVersion: Boolean(options.newVersion),
		yes: Boolean(options.yes),
		commit: options.commit,
		noCommit: Boolean(options.noCommit),
		logger,
		logFilePath,
	};
}

export interface Gate1Params {
	dataDir: string;
	currentStationMasterHash: string;
	newVersion: boolean;
	yes: boolean;
	prompt: (question: string, defaultYes?: boolean) => Promise<boolean>;
}

export interface Gate1Result {
	activeVersion: number;
	versionToUse: number;
	shouldBumpVersion: boolean;
}

/**
 * Gate 1: Compares active station catalog hash against existing versions (§8.1).
 */
export async function evaluateGate1(params: Gate1Params): Promise<Gate1Result> {
	const existingVersions = await scanTimetableVersions(params.dataDir);
	const activeVersion =
		existingVersions.length > 0
			? existingVersions[existingVersions.length - 1]
			: 1;

	if (params.newVersion && existingVersions.length > 0) {
		return {
			activeVersion,
			versionToUse: activeVersion + 1,
			shouldBumpVersion: true,
		};
	}

	if (existingVersions.length === 0) {
		return {
			activeVersion: 1,
			versionToUse: 1,
			shouldBumpVersion: false,
		};
	}

	const existingSnapshots = await scanSnapshots(params.dataDir, activeVersion);
	if (existingSnapshots.length === 0) {
		return {
			activeVersion,
			versionToUse: activeVersion,
			shouldBumpVersion: false,
		};
	}

	const latestManifest =
		existingSnapshots[existingSnapshots.length - 1].manifest;
	if (latestManifest.station_master_hash !== params.currentStationMasterHash) {
		const promptMsg = `[Gate 1 Alert] Station master hash differs from active version ${activeVersion} (${latestManifest.station_master_hash.slice(0, 8)} -> ${params.currentStationMasterHash.slice(0, 8)}). Network catalog mutated. Increment timetable version to ${activeVersion + 1}?`;

		if (params.yes) {
			throw new Error(
				"Capture halted by Gate 1 in non-interactive mode: station master hash mutated without --new-version flag.",
			);
		}

		const confirmed = await params.prompt(promptMsg, false);
		if (!confirmed) {
			throw new Error(
				`[Gate 1 Alert] Capture aborted by operator: station master hash mismatch with active version ${activeVersion}.`,
			);
		}

		return {
			activeVersion,
			versionToUse: activeVersion + 1,
			shouldBumpVersion: true,
		};
	}

	return {
		activeVersion,
		versionToUse: activeVersion,
		shouldBumpVersion: false,
	};
}

/**
 * Executes paced concurrent fan-out across all operational station departure boards.
 */
export async function fetchDepartureBoards(
	operationalStations: readonly StationItem[],
	client: KciClient,
	logger?: StructuredLogger,
): Promise<BoardFetchResult> {
	const startTime = Date.now();
	const boardsMap = new Map<string, DepartureBoardItem[]>();
	const rawBoardsMap = new Map<string, DepartureBoardResponse>();
	const failedStations: FailedStation[] = [];
	let completedCount = 0;
	const totalStations = operationalStations.length;

	await Promise.all(
		operationalStations.map(async (station) => {
			const stationTimer = startTimer();
			const resolvedId = resolveStationCode(station.sta_id);
			try {
				const schedule = await client.fetchStationSchedule(resolvedId);
				boardsMap.set(resolvedId, schedule.data);
				rawBoardsMap.set(resolvedId, schedule);
				completedCount++;
				const aliasInfo =
					resolvedId !== station.sta_id ? ` -> ${resolvedId}` : "";
				console.log(
					`[${String(completedCount).padStart(2, " ")}/${totalStations}] OK    ${(station.sta_id + aliasInfo).padEnd(10, " ")} (${station.sta_name}) - ${schedule.data.length} departures`,
				);
				logger?.info(
					"capture",
					"station_fetched",
					`Station ${station.sta_id} departures fetched`,
					{
						stationId: resolvedId,
						originalStationId: station.sta_id,
						stationName: station.sta_name,
						departures: schedule.data.length,
						durationMs: stationTimer.elapsedMs,
					},
				);
			} catch (err) {
				completedCount++;
				const reason = err instanceof Error ? err.message : String(err);
				failedStations.push({
					id: resolvedId,
					name: station.sta_name,
					reason,
				});
				console.warn(
					`[${String(completedCount).padStart(2, " ")}/${totalStations}] FAIL  ${station.sta_id.padEnd(5, " ")} (${station.sta_name}) - ${reason}`,
				);
				logger?.error(
					"capture",
					"station_failed",
					`Station ${station.sta_id} failed: ${reason}`,
					{
						stationId: resolvedId,
						originalStationId: station.sta_id,
						stationName: station.sta_name,
						reason,
						durationMs: stationTimer.elapsedMs,
					},
				);
			}
		}),
	);

	if (boardsMap.size === 0) {
		throw new Error(
			"Failed to fetch any departure boards. Upstream service unreachable.",
		);
	}

	const durationSecs = ((Date.now() - startTime) / 1000).toFixed(1);
	return {
		boardsMap,
		rawBoardsMap,
		failedStations,
		isDegraded: failedStations.length > 0,
		durationSecs,
	};
}

export interface Gate2Params {
	dataDir: string;
	versionToUse: number;
	shouldBumpVersion: boolean;
	resolvedDayType: DayType;
	currentBoardResponseHash: string;
	yes: boolean;
	prompt: (question: string, defaultYes?: boolean) => Promise<boolean>;
}

export interface Gate2Result {
	versionToUse: number;
	shouldBumpVersion: boolean;
}

/**
 * Gate 2: Compares board signature against existing same-day-type snapshots (§8.1).
 */
export async function evaluateGate2(params: Gate2Params): Promise<Gate2Result> {
	if (params.shouldBumpVersion) {
		return {
			versionToUse: params.versionToUse,
			shouldBumpVersion: true,
		};
	}

	const existingSnapshots = await scanSnapshots(
		params.dataDir,
		params.versionToUse,
	);
	const sameDayTypeSnapshot = existingSnapshots.find(
		(s) =>
			s.manifest.day_type === params.resolvedDayType &&
			s.manifest.status === "complete",
	);

	if (sameDayTypeSnapshot) {
		const existingHash = sameDayTypeSnapshot.manifest.board_response_hash;
		if (existingHash !== params.currentBoardResponseHash) {
			const promptMsg = `[Gate 2 Alert] Board signature differs for day type '${params.resolvedDayType}' compared to snapshot ${sameDayTypeSnapshot.id} (${existingHash.slice(0, 8)} -> ${params.currentBoardResponseHash.slice(0, 8)}). Potential timetable edition revision. Increment timetable version to ${params.versionToUse + 1}?`;

			if (params.yes) {
				throw new Error(
					`[Gate 2 Alert] Capture halted in non-interactive mode: board response signature differs for day type '${params.resolvedDayType}' without --new-version flag.`,
				);
			}

			const confirmed = await params.prompt(promptMsg, false);
			if (!confirmed) {
				throw new Error(
					`[Gate 2 Alert] Capture aborted by operator: board response signature differs for day type '${params.resolvedDayType}'.`,
				);
			}

			return {
				versionToUse: params.versionToUse + 1,
				shouldBumpVersion: true,
			};
		}
	}

	return {
		versionToUse: params.versionToUse,
		shouldBumpVersion: false,
	};
}

export interface WriteSnapshotParams {
	dataDir: string;
	versionToUse: number;
	shouldBumpVersion: boolean;
	snapshotDate: string;
	resolvedDayType: DayType;
	regionScope: RegionScope;
	currentStationMasterHash: string;
	currentBoardResponseHash: string;
	isDegraded: boolean;
	stationsResponse: StationMasterResponse;
	rawBoardsMap: Map<string, DepartureBoardResponse>;
}

/**
 * Persists station catalog, boards, and manifest atomically to disk.
 */
export async function writeSnapshotToDisk(
	params: WriteSnapshotParams,
): Promise<CaptureResult> {
	const targetVersionSnapshots = params.shouldBumpVersion
		? []
		: await scanSnapshots(params.dataDir, params.versionToUse);
	const nextSnapshotId =
		targetVersionSnapshots.length > 0
			? targetVersionSnapshots[targetVersionSnapshots.length - 1].id + 1
			: 1;

	const safeDataDir = resolveSafePath(params.dataDir ?? "data/raw");
	const capturesParent = capturesDir(safeDataDir, params.versionToUse);
	const snapshotDir = snapshotDirHelper(
		safeDataDir,
		params.versionToUse,
		nextSnapshotId,
	);
	const tmpDir = resolveSafePath(
		path.join(capturesParent, `.tmp_${nextSnapshotId}_${Date.now()}`),
		capturesParent,
	);
	const tmpBoardsDir = resolveSafePath(path.join(tmpDir, "boards"), tmpDir);

	await fs.mkdir(tmpBoardsDir, { recursive: true });

	try {
		const stationsPath = resolveSafePath(
			path.join(tmpDir, "stations.json"),
			tmpDir,
		);
		await fs.writeFile(
			stationsPath,
			JSON.stringify(params.stationsResponse, null, 2),
			"utf-8",
		);

		for (const [staId, boardData] of params.rawBoardsMap.entries()) {
			const safeStaId = path.basename(staId);
			const boardPath = resolveSafePath(
				path.join(tmpBoardsDir, `${safeStaId}.json`),
				tmpBoardsDir,
			);
			await fs.writeFile(
				boardPath,
				JSON.stringify(boardData, null, 2),
				"utf-8",
			);
		}

		const manifest: CaptureManifest = {
			timetable_version: params.versionToUse,
			snapshot_id: nextSnapshotId,
			snapshot_date: params.snapshotDate,
			day_type: params.resolvedDayType,
			region_scope: params.regionScope,
			station_master_hash: params.currentStationMasterHash,
			board_response_hash: params.currentBoardResponseHash,
			fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
			status: params.isDegraded ? "degraded" : "complete",
		};

		// Validate manifest schema before promoting to disk
		CaptureManifestSchema.parse(manifest);

		const manifestPath = resolveSafePath(
			path.join(tmpDir, "manifest.json"),
			tmpDir,
		);
		await fs.writeFile(
			manifestPath,
			JSON.stringify(manifest, null, 2),
			"utf-8",
		);

		// Atomically promote temporary directory to destination snapshotDir
		await fs.rename(tmpDir, snapshotDir);

		return {
			timetable_version: params.versionToUse,
			snapshot_id: nextSnapshotId,
			snapshot_dir: snapshotDir,
			manifest,
		};
	} catch (err) {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		throw err;
	}
}

/**
 * Formats and displays the end-of-run capture summary box.
 */
export function printCaptureSummary(params: {
	result: CaptureResult;
	totalStations: number;
	successfulBoardsCount: number;
	failedStations: FailedStation[];
	durationSecs: string;
}): void {
	const failedStr =
		params.failedStations.length > 0
			? ` (${params.failedStations.map((f) => `${f.id}: ${f.reason}`).join(", ")})`
			: "";
	const logStr = params.result.logFilePath
		? `\nLog File:             ${params.result.logFilePath}`
		: "";

	console.log(`
── Capture Summary ──────────────────────────────────────────
Timetable Version:    ${params.result.timetable_version}
Snapshot ID:          ${params.result.snapshot_id} (${params.result.manifest.day_type}, ${params.result.manifest.status})
Operational Stations: ${params.totalStations}
Successful Boards:    ${params.successfulBoardsCount}
Failed Stations:      ${params.failedStations.length}${failedStr}
Duration:             ${params.durationSecs}s
Station Master Hash:  ${params.result.manifest.station_master_hash.slice(0, 16)}...
Board Response Hash:  ${params.result.manifest.board_response_hash.slice(0, 16)}...
Saved to:             ${params.result.snapshot_dir}${logStr}
─────────────────────────────────────────────────────────────
`);
}

/**
 * Executes the full live capture pipeline (§8.1, §8.2).
 */
export async function executeCapture(
	options: CaptureOptions = {},
): Promise<CaptureResult> {
	const timer = startTimer();
	const ctx = resolveCaptureContext(options);

	ctx.logger.info(
		"capture",
		"capture_started",
		"Starting departure board capture pipeline",
		{
			regionScope: ctx.regionScope,
			dayType: ctx.resolvedDayType,
			newVersion: ctx.newVersion,
			logFilePath: ctx.logFilePath,
		},
	);

	// 1. Fetch Station Master Catalog & Extract Operational Roster
	const stationsResponse = await ctx.client.fetchStations();
	const operationalStations = filterOperationalStations(
		stationsResponse.data,
		ctx.regionScope,
	);
	const currentStationMasterHash =
		computeStationMasterHash(operationalStations);

	// 2. Gate 1: Network Station Catalog Gate
	const gate1 = await evaluateGate1({
		dataDir: ctx.dataDir,
		currentStationMasterHash,
		newVersion: ctx.newVersion,
		yes: ctx.yes,
		prompt: ctx.prompt,
	});

	ctx.logger.info(
		"capture",
		"gate1_evaluated",
		`Gate 1 evaluated: version ${gate1.versionToUse}`,
		{
			activeVersion: gate1.activeVersion,
			versionToUse: gate1.versionToUse,
			shouldBumpVersion: gate1.shouldBumpVersion,
			stationMasterHash: currentStationMasterHash,
		},
	);

	// 3. Paced Concurrent Board Fan-Out
	const boardsResult = await fetchDepartureBoards(
		operationalStations,
		ctx.client,
		ctx.logger,
	);
	const currentBoardResponseHash = computeBoardResponseHash(
		boardsResult.boardsMap,
	);

	// 4. Gate 2: Timetable Edition Gate
	const gate2 = await evaluateGate2({
		dataDir: ctx.dataDir,
		versionToUse: gate1.versionToUse,
		shouldBumpVersion: gate1.shouldBumpVersion,
		resolvedDayType: ctx.resolvedDayType,
		currentBoardResponseHash,
		yes: ctx.yes,
		prompt: ctx.prompt,
	});

	ctx.logger.info(
		"capture",
		"gate2_evaluated",
		`Gate 2 evaluated: version ${gate2.versionToUse}`,
		{
			versionToUse: gate2.versionToUse,
			shouldBumpVersion: gate2.shouldBumpVersion,
			boardResponseHash: currentBoardResponseHash,
		},
	);

	// 5. Atomic Disk Persistence
	const result = await writeSnapshotToDisk({
		dataDir: ctx.dataDir,
		versionToUse: gate2.versionToUse,
		shouldBumpVersion: gate2.shouldBumpVersion,
		snapshotDate: ctx.snapshotDate,
		resolvedDayType: ctx.resolvedDayType,
		regionScope: ctx.regionScope,
		currentStationMasterHash,
		currentBoardResponseHash,
		isDegraded: boardsResult.isDegraded,
		stationsResponse,
		rawBoardsMap: boardsResult.rawBoardsMap,
	});

	// 6. Report Summary
	printCaptureSummary({
		result: { ...result, logFilePath: ctx.logFilePath },
		totalStations: operationalStations.length,
		successfulBoardsCount: boardsResult.boardsMap.size,
		failedStations: boardsResult.failedStations,
		durationSecs: timer.elapsedSecs,
	});

	// 7. Optional Git Auto-Commit Integration
	let commitResult: CommitSnapshotResult | undefined;
	if (ctx.commit && !ctx.noCommit) {
		commitResult = await commitCaptureSnapshot({
			snapshotDir: result.snapshot_dir,
			manifest: result.manifest,
		});

		if (commitResult.committed) {
			console.log(
				`[Git] Committed snapshot to git: ${commitResult.commitHash?.slice(0, 7)}`,
			);
		} else {
			console.warn(
				`[Git] Notice: Snapshot not committed: ${commitResult.reason}`,
			);
		}
	}

	ctx.logger.info(
		"capture",
		"capture_completed",
		"Departure board capture completed successfully",
		{
			timetableVersion: result.timetable_version,
			snapshotId: result.snapshot_id,
			status: result.manifest.status,
			totalStations: operationalStations.length,
			successfulBoardsCount: boardsResult.boardsMap.size,
			failedCount: boardsResult.failedStations.length,
			durationSecs: timer.elapsedSecs,
			durationMs: timer.elapsedMs,
			stationMasterHash: result.manifest.station_master_hash,
			boardResponseHash: result.manifest.board_response_hash,
		},
	);

	await ctx.logger.flush();

	return {
		...result,
		commitResult,
		logFilePath: ctx.logFilePath,
	};
}

export type CommitSnapshotResult = CommitResult;

export interface CommitSnapshotOptions {
	snapshotDir: string;
	manifest?: CaptureManifest;
	cwd?: string;
}

/**
 * Formats standard Conventional Commit message for a captured raw snapshot.
 */
export function formatSnapshotCommitMessage(
	manifest: CaptureManifest,
	options: { coAuthor?: boolean } = {},
): string {
	const coAuthor = options.coAuthor ?? true;
	const footer = coAuthor
		? "\n\nGenerated with Antigravity\nCo-authored-by: gemini-code-assist[bot] <176961590+gemini-code-assist[bot]@users.noreply.github.com>"
		: "";

	return `chore(capture): record v${manifest.timetable_version} snapshot ${manifest.snapshot_id} (${manifest.day_type}, ${manifest.status})

Snapshot Date: ${manifest.snapshot_date}
Region Scope:  ${manifest.region_scope}
Station Hash:  ${manifest.station_master_hash.slice(0, 16)}...
Board Hash:    ${manifest.board_response_hash.slice(0, 16)}...
Status:        ${manifest.status}${footer}`;
}

/**
 * Atomically commits a raw capture snapshot directory.
 */
export async function commitCaptureSnapshot(
	options: CommitSnapshotOptions,
): Promise<CommitSnapshotResult> {
	const cwd = options.cwd ?? process.cwd();
	let resolvedSnapshotDir: string;
	try {
		resolvedSnapshotDir = resolveSafePath(options.snapshotDir, cwd);
	} catch (err) {
		return {
			committed: false,
			reason: `Invalid snapshot directory: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	let manifest = options.manifest;
	if (!manifest) {
		const manifestPath = resolveSafePath(
			path.join(resolvedSnapshotDir, "manifest.json"),
			resolvedSnapshotDir,
		);
		try {
			const content = await fs.readFile(manifestPath, "utf-8");
			manifest = CaptureManifestSchema.parse(JSON.parse(content));
		} catch (err) {
			return {
				committed: false,
				reason: `Failed to read snapshot manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	const commitMessage = formatSnapshotCommitMessage(manifest);
	return commitPath({
		path: resolvedSnapshotDir,
		message: commitMessage,
		cwd,
	});
}
