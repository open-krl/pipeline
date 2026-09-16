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
		// Directory does not exist yet
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
 * Executes the full live capture pipeline (§8.1, §8.2).
 */
export async function executeCapture(
	options: CaptureOptions = {},
): Promise<CaptureResult> {
	const dataDir = options.dataDir ?? path.resolve(process.cwd(), "data/raw");
	const client = options.client ?? new KciClient();
	const regionScope = options.region ?? DEFAULT_REGION_SCOPE;
	const now = options.now ?? new Date();
	const prompt = options.promptFn ?? defaultPrompt;

	// Resolve Day Type & Date
	const holidays = loadHolidays(options.holidaysPath);
	const snapshotDate = formatDateWib(now);
	const resolvedDayType = options.dayType ?? resolveDayType(now, holidays);

	// 1. Fetch Station Master Catalog
	const stationsResponse: StationMasterResponse = await client.fetchStations();
	const allowedGroups = REGION_GROUPS[regionScope];
	const operationalStations = stationsResponse.data.filter((s: StationItem) => {
		if (s.sta_id.startsWith("WIL")) return false;
		if (!allowedGroups.includes(s.group_wil)) return false;
		return s.fg_enable === 1;
	});

	if (operationalStations.length === 0) {
		throw new Error(
			`No operational stations found for region scope '${regionScope}'.`,
		);
	}

	const currentStationMasterHash =
		computeStationMasterHash(operationalStations);

	// Determine active timetable version
	const existingVersions = await scanTimetableVersions(dataDir);
	const activeVersion =
		existingVersions.length > 0
			? existingVersions[existingVersions.length - 1]
			: 1;
	let versionToUse = activeVersion;
	let shouldBumpVersion = Boolean(options.newVersion);

	if (options.newVersion && existingVersions.length > 0) {
		versionToUse = activeVersion + 1;
	}

	// Gate 1: Network Station Catalog Gate (§8.1)
	if (!options.newVersion && existingVersions.length > 0) {
		const existingSnapshots = await scanSnapshots(dataDir, activeVersion);
		if (existingSnapshots.length > 0) {
			const latestManifest =
				existingSnapshots[existingSnapshots.length - 1].manifest;
			if (latestManifest.station_master_hash !== currentStationMasterHash) {
				const promptMsg = `[Gate 1 Alert] Station master hash differs from active version ${activeVersion} (${latestManifest.station_master_hash.slice(0, 8)} -> ${currentStationMasterHash.slice(0, 8)}). Network catalog mutated. Increment timetable version to ${activeVersion + 1}?`;

				if (options.yes) {
					throw new Error(
						`Capture halted by Gate 1 in non-interactive mode: station master hash mutated without --new-version flag.`,
					);
				}

				const confirmed = await prompt(promptMsg, false);
				if (!confirmed) {
					throw new Error(
						`[Gate 1 Alert] Capture aborted by operator: station master hash mismatch with active version ${activeVersion}.`,
					);
				}
				shouldBumpVersion = true;
				versionToUse = activeVersion + 1;
			}
		}
	}

	// 2. In-Memory Departure Board Fan-Out (Concurrency = 5)
	const boardsMap = new Map<string, DepartureBoardItem[]>();
	const rawBoardsMap = new Map<string, DepartureBoardResponse>();
	let failedStationsCount = 0;

	await Promise.all(
		operationalStations.map(async (station) => {
			try {
				const schedule = await client.fetchStationSchedule(station.sta_id);
				boardsMap.set(station.sta_id, schedule.data);
				rawBoardsMap.set(station.sta_id, schedule);
			} catch (err) {
				console.warn(
					`Warning: Failed to fetch board for ${station.sta_id} (${station.sta_name}):`,
					err,
				);
				failedStationsCount++;
			}
		}),
	);

	if (boardsMap.size === 0) {
		throw new Error(
			"Failed to fetch any departure boards. Upstream service unreachable.",
		);
	}

	const isDegraded = failedStationsCount > 0;
	const currentBoardResponseHash = computeBoardResponseHash(boardsMap);

	// Gate 2: Timetable Edition Gate (§8.1)
	if (!shouldBumpVersion && existingVersions.length > 0) {
		const existingSnapshots = await scanSnapshots(dataDir, versionToUse);
		const sameDayTypeSnapshot = existingSnapshots.find(
			(s) => s.manifest.day_type === resolvedDayType,
		);

		if (sameDayTypeSnapshot) {
			const existingHash = sameDayTypeSnapshot.manifest.board_response_hash;
			if (existingHash !== currentBoardResponseHash) {
				const promptMsg = `[Gate 2 Alert] Board signature differs for day type '${resolvedDayType}' compared to snapshot ${sameDayTypeSnapshot.id} (${existingHash.slice(0, 8)} -> ${currentBoardResponseHash.slice(0, 8)}). Potential timetable edition revision. Increment timetable version to ${versionToUse + 1}?`;

				if (options.yes) {
					throw new Error(
						`[Gate 2 Alert] Capture halted in non-interactive mode: board response signature differs for day type '${resolvedDayType}' without --new-version flag.`,
					);
				}

				const confirmed = await prompt(promptMsg, false);
				if (!confirmed) {
					throw new Error(
						`[Gate 2 Alert] Capture aborted by operator: board response signature differs for day type '${resolvedDayType}'.`,
					);
				}
				versionToUse = versionToUse + 1;
				shouldBumpVersion = true;
			}
		}
	}

	// Determine next snapshot ID in target version
	const targetVersionSnapshots = shouldBumpVersion
		? []
		: await scanSnapshots(dataDir, versionToUse);
	const nextSnapshotId =
		targetVersionSnapshots.length > 0
			? targetVersionSnapshots[targetVersionSnapshots.length - 1].id + 1
			: 1;

	// 3. Atomic Disk Persistence
	const snapshotDir = path.join(
		dataDir,
		String(versionToUse),
		"captures",
		String(nextSnapshotId),
	);
	const boardsDir = path.join(snapshotDir, "boards");

	await fs.mkdir(boardsDir, { recursive: true });

	// Write stations.json
	await fs.writeFile(
		path.join(snapshotDir, "stations.json"),
		JSON.stringify(stationsResponse, null, 2),
		"utf-8",
	);

	// Write each station board
	for (const [staId, boardData] of rawBoardsMap.entries()) {
		await fs.writeFile(
			path.join(boardsDir, `${staId}.json`),
			JSON.stringify(boardData, null, 2),
			"utf-8",
		);
	}

	// Write manifest.json
	const manifest: CaptureManifest = {
		timetable_version: versionToUse,
		snapshot_id: nextSnapshotId,
		snapshot_date: snapshotDate,
		day_type: resolvedDayType,
		region_scope: regionScope,
		station_master_hash: currentStationMasterHash,
		board_response_hash: currentBoardResponseHash,
		fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
		status: isDegraded ? "degraded" : "complete",
	};

	await fs.writeFile(
		path.join(snapshotDir, "manifest.json"),
		JSON.stringify(manifest, null, 2),
		"utf-8",
	);

	return {
		timetable_version: versionToUse,
		snapshot_id: nextSnapshotId,
		snapshot_dir: snapshotDir,
		manifest,
	};
}
