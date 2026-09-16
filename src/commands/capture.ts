// src/commands/capture.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { KciClient } from "../api/client";
import {
	type CaptureManifest,
	CaptureManifestSchema,
	type DayType,
	type DepartureBoardItem,
	type DepartureBoardResponse,
	type StationItem,
	type StationMasterResponse,
} from "../api/schemas";
import {
	DEFAULT_REGION_SCOPE,
	REGION_GROUPS,
	type RegionScope,
} from "../config";
import { formatDateWib, resolveDayType } from "../core/calendar";
import {
	computeBoardResponseHash,
	computeStationMasterHash,
} from "../core/manifest";
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
}

export interface CaptureResult {
	timetable_version: number;
	snapshot_id: number;
	snapshot_dir: string;
	manifest: CaptureManifest;
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

/**
 * Scans a directory for numerical subdirectories representing version numbers.
 */
export async function scanTimetableVersions(
	dataDir: string,
): Promise<number[]> {
	try {
		const entries = await fs.readdir(dataDir, { withFileTypes: true });
		return entries
			.filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
			.map((e) => Number.parseInt(e.name, 10))
			.sort((a, b) => a - b);
	} catch {
		return [];
	}
}

/**
 * Scans captures directory for numeric snapshot IDs and their manifests.
 */
export async function scanSnapshots(
	dataDir: string,
	version: number,
): Promise<Array<{ id: number; manifest: CaptureManifest }>> {
	const capturesDir = path.join(dataDir, String(version), "captures");
	try {
		const entries = await fs.readdir(capturesDir, { withFileTypes: true });
		const snapshotIds = entries
			.filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
			.map((e) => Number.parseInt(e.name, 10))
			.sort((a, b) => a - b);

		const snapshots: Array<{ id: number; manifest: CaptureManifest }> = [];
		for (const id of snapshotIds) {
			const manifestPath = path.join(capturesDir, String(id), "manifest.json");
			try {
				const content = await fs.readFile(manifestPath, "utf-8");
				const parsed = CaptureManifestSchema.parse(JSON.parse(content));
				snapshots.push({ id, manifest: parsed });
			} catch (manifestErr) {
				console.warn(
					`Warning: Failed to parse manifest at ${manifestPath}:`,
					manifestErr,
				);
			}
		}
		return snapshots;
	} catch {
		return [];
	}
}

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
	const dataDir = options.dataDir ?? path.resolve(process.cwd(), "data/raw");
	const client = options.client ?? new KciClient();
	const regionScope = options.region ?? DEFAULT_REGION_SCOPE;
	const now = options.now ?? new Date();
	const prompt = options.promptFn ?? defaultPrompt;
	const holidays = loadHolidays(options.holidaysPath);
	const snapshotDate = formatDateWib(now);
	const resolvedDayType = options.dayType ?? resolveDayType(now, holidays);

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
): Promise<BoardFetchResult> {
	const startTime = Date.now();
	const boardsMap = new Map<string, DepartureBoardItem[]>();
	const rawBoardsMap = new Map<string, DepartureBoardResponse>();
	const failedStations: FailedStation[] = [];
	let completedCount = 0;
	const totalStations = operationalStations.length;

	await Promise.all(
		operationalStations.map(async (station) => {
			try {
				const schedule = await client.fetchStationSchedule(station.sta_id);
				boardsMap.set(station.sta_id, schedule.data);
				rawBoardsMap.set(station.sta_id, schedule);
				completedCount++;
				console.log(
					`[${String(completedCount).padStart(2, " ")}/${totalStations}] OK    ${station.sta_id.padEnd(5, " ")} (${station.sta_name}) - ${schedule.data.length} departures`,
				);
			} catch (err) {
				completedCount++;
				const reason = err instanceof Error ? err.message : String(err);
				failedStations.push({
					id: station.sta_id,
					name: station.sta_name,
					reason,
				});
				console.warn(
					`[${String(completedCount).padStart(2, " ")}/${totalStations}] FAIL  ${station.sta_id.padEnd(5, " ")} (${station.sta_name}) - ${reason}`,
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
		(s) => s.manifest.day_type === params.resolvedDayType,
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

	const snapshotDir = path.join(
		params.dataDir,
		String(params.versionToUse),
		"captures",
		String(nextSnapshotId),
	);
	const boardsDir = path.join(snapshotDir, "boards");

	await fs.mkdir(boardsDir, { recursive: true });

	await fs.writeFile(
		path.join(snapshotDir, "stations.json"),
		JSON.stringify(params.stationsResponse, null, 2),
		"utf-8",
	);

	for (const [staId, boardData] of params.rawBoardsMap.entries()) {
		await fs.writeFile(
			path.join(boardsDir, `${staId}.json`),
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

	await fs.writeFile(
		path.join(snapshotDir, "manifest.json"),
		JSON.stringify(manifest, null, 2),
		"utf-8",
	);

	return {
		timetable_version: params.versionToUse,
		snapshot_id: nextSnapshotId,
		snapshot_dir: snapshotDir,
		manifest,
	};
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
Saved to:             ${params.result.snapshot_dir}
─────────────────────────────────────────────────────────────
`);
}

/**
 * Executes the full live capture pipeline (§8.1, §8.2).
 */
export async function executeCapture(
	options: CaptureOptions = {},
): Promise<CaptureResult> {
	const ctx = resolveCaptureContext(options);

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

	// 3. Paced Concurrent Board Fan-Out
	const boardsResult = await fetchDepartureBoards(
		operationalStations,
		ctx.client,
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
		result,
		totalStations: operationalStations.length,
		successfulBoardsCount: boardsResult.boardsMap.size,
		failedStations: boardsResult.failedStations,
		durationSecs: boardsResult.durationSecs,
	});

	return result;
}
