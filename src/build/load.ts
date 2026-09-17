// src/build/load.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readItineraryEnvelope } from "../archive/itineraries";
import { itinerariesDir, snapshotDir } from "../archive/layout";
import type {
	HolidayItem,
	MultiObservationItinerary,
} from "../archive/schemas";
import {
	readSnapshotBoards,
	readSnapshotStations,
	scanSnapshots,
	scanTimetableVersions,
} from "../archive/snapshots";
import { HolidayFileSchema } from "../core/calendar";
import { getGitCommitForPath, getGitCommitHash } from "../core/git";
import { resolveSafePath } from "../core/path";
import type { RawArchive, RawSnapshot } from "./types";

export interface LoadArchiveOptions {
	dataDir?: string;
	version?: number;
	holidaysPath?: string;
	coordinatesPath?: string;
	cwd?: string;
}

/**
 * Parses data/station_coordinates.csv into a Map of sta_id -> { lat, lon }.
 */
export async function loadStationCoordinates(
	csvPath: string,
): Promise<Map<string, { lat: number; lon: number }>> {
	const map = new Map<string, { lat: number; lon: number }>();
	try {
		const content = await fs.readFile(csvPath, "utf-8");
		const lines = content.split("\n");
		// Skip header line
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) continue;
			const parts = line.split(",");
			if (parts.length >= 4) {
				const staId = parts[0].trim();
				const lat = Number.parseFloat(parts[2].trim());
				const lon = Number.parseFloat(parts[3].trim());
				if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
					map.set(staId, { lat, lon });
				}
			}
		}
	} catch {
		// File missing or unreadable; proceed with empty coordinates
	}
	return map;
}

/**
 * Parses data/holidays.json into an array of HolidayItem.
 */
export async function loadHolidays(
	holidaysPath: string,
): Promise<HolidayItem[]> {
	try {
		const content = await fs.readFile(holidaysPath, "utf-8");
		const parsed = JSON.parse(content);
		return HolidayFileSchema.parse(parsed);
	} catch {
		return [];
	}
}

/**
 * Pure I/O Boundary: Loads all disk artifacts for a given timetable version into RawArchive.
 */
export async function loadRawArchive(
	options: LoadArchiveOptions = {},
): Promise<RawArchive> {
	const cwd = options.cwd ?? process.cwd();
	const dataDir = options.dataDir ?? "data/raw";
	const resolvedDataDir = resolveSafePath(dataDir, cwd);

	let version = options.version;
	if (version === undefined) {
		const versions = await scanTimetableVersions(resolvedDataDir);
		if (versions.length === 0) {
			throw new Error(
				`No timetable versions found under data directory: ${resolvedDataDir}`,
			);
		}
		version = versions[versions.length - 1];
	}

	const holidaysPath =
		options.holidaysPath ?? path.join(cwd, "data/holidays.json");
	const coordinatesPath =
		options.coordinatesPath ?? path.join(cwd, "data/station_coordinates.csv");

	// 1. Load coordinates & holidays
	const [stationCoordinates, holidays] = await Promise.all([
		loadStationCoordinates(coordinatesPath),
		loadHolidays(holidaysPath),
	]);

	// 2. Scan and load complete snapshots
	const snapshotMetas = await scanSnapshots(resolvedDataDir, version);
	const completeMetas = snapshotMetas.filter(
		(s) => s.manifest.status === "complete",
	);

	if (completeMetas.length === 0) {
		throw new Error(
			`No complete snapshots found for timetable version ${version} in ${resolvedDataDir} (${snapshotMetas.length} total snapshot(s) scanned)`,
		);
	}

	const defaultCommit =
		(await getGitCommitHash("HEAD", cwd)) ??
		"0000000000000000000000000000000000000000";

	const snapshots: RawSnapshot[] = [];
	for (const meta of completeMetas) {
		const sDir = snapshotDir(resolvedDataDir, version, meta.id);
		const commitHash = (await getGitCommitForPath(sDir, cwd)) ?? defaultCommit;

		const stations = await readSnapshotStations(
			resolvedDataDir,
			version,
			meta.id,
		);
		if (!stations) {
			throw new Error(
				`Missing or invalid stations.json in snapshot ${meta.id} at ${sDir}`,
			);
		}

		const boards = await readSnapshotBoards(resolvedDataDir, version, meta.id);

		snapshots.push({
			id: meta.id,
			manifest: meta.manifest,
			archiveCommit: commitHash,
			stations,
			boards,
		});
	}

	// 3. Load itineraries
	const itineraries = new Map<string, MultiObservationItinerary>();
	const iDir = itinerariesDir(resolvedDataDir, version);

	try {
		const entries = await fs.readdir(iDir, { withFileTypes: true });
		const jsonFiles = entries
			.filter((e) => e.isFile() && e.name.endsWith(".json"))
			.map((e) => e.name)
			.sort((a, b) => a.localeCompare(b));

		for (const filename of jsonFiles) {
			const filePath = path.join(iDir, filename);
			try {
				const envelope = await readItineraryEnvelope(filePath);
				if (envelope) {
					itineraries.set(envelope.train_id, envelope);
				}
			} catch (err) {
				console.warn(
					`Warning: Failed to read itinerary envelope at ${filePath}:`,
					err,
				);
			}
		}
	} catch {
		// itineraries directory might not exist yet if census hasn't run; that's fine
	}

	return {
		timetableVersion: version,
		snapshots,
		itineraries,
		stationCoordinates,
		holidays,
	};
}
