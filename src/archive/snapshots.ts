import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type DepartureBoardResponse,
	DepartureBoardResponseSchema,
	type StationMasterResponse,
	StationMasterResponseSchema,
} from "../api/schemas";
import { resolveSafePath } from "../core/path";
import { boardsDir, capturesDir, manifestPath, stationsPath } from "./layout";
import { type CaptureManifest, CaptureManifestSchema } from "./schemas";

export interface SnapshotMetadata {
	id: number;
	manifest: CaptureManifest;
}

/**
 * Scans a data directory for numerical subdirectories representing version numbers.
 * Results are sorted in ascending numeric order.
 */
export async function scanTimetableVersions(
	dataDir: string,
): Promise<number[]> {
	try {
		const safeDataDir = resolveSafePath(dataDir);
		const entries = await fs.readdir(safeDataDir, { withFileTypes: true });
		return entries
			.filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
			.map((e) => Number.parseInt(e.name, 10))
			.sort((a, b) => a - b);
	} catch {
		return [];
	}
}

/**
 * Scans captures directory for numeric snapshot IDs and parses their manifests.
 * Results are sorted in ascending numeric order by snapshot ID.
 */
export async function scanSnapshots(
	dataDir: string,
	version: number,
): Promise<SnapshotMetadata[]> {
	try {
		const cDir = capturesDir(dataDir, version);
		const entries = await fs.readdir(cDir, { withFileTypes: true });
		const snapshotIds = entries
			.filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
			.map((e) => Number.parseInt(e.name, 10))
			.sort((a, b) => a - b);

		const snapshots: SnapshotMetadata[] = [];
		for (const id of snapshotIds) {
			const mPath = manifestPath(dataDir, version, id);
			try {
				const content = await fs.readFile(mPath, "utf-8");
				const parsed = CaptureManifestSchema.parse(JSON.parse(content));
				snapshots.push({ id, manifest: parsed });
			} catch (manifestErr) {
				console.warn(
					`Warning: Failed to parse manifest at ${mPath}:`,
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
 * Reads and parses the station master catalog for a snapshot.
 */
export async function readSnapshotStations(
	dataDir: string,
	version: number,
	snapshotId: number,
): Promise<StationMasterResponse | null> {
	const sPath = stationsPath(dataDir, version, snapshotId);
	try {
		const content = await fs.readFile(sPath, "utf-8");
		return StationMasterResponseSchema.parse(JSON.parse(content));
	} catch {
		return null;
	}
}

/**
 * Reads all departure boards for a given snapshot.
 * Deterministically sorts station files alphabetically.
 */
export async function readSnapshotBoards(
	dataDir: string,
	version: number,
	snapshotId: number,
): Promise<Map<string, DepartureBoardResponse>> {
	const bDir = boardsDir(dataDir, version, snapshotId);
	const boards = new Map<string, DepartureBoardResponse>();

	let entries: Dirent[];
	try {
		entries = await fs.readdir(bDir, { withFileTypes: true });
	} catch {
		return boards;
	}

	const files = entries
		.filter((e) => e.isFile() && e.name.endsWith(".json"))
		.map((e) => e.name)
		.sort((a, b) => a.localeCompare(b));

	for (const filename of files) {
		const stationId = filename.replace(/\.json$/, "");
		const filePath = resolveSafePath(path.join(bDir, filename), bDir);
		try {
			const content = await fs.readFile(filePath, "utf-8");
			const parsed = DepartureBoardResponseSchema.parse(JSON.parse(content));
			boards.set(stationId, parsed);
		} catch (err) {
			console.warn(`Warning: Failed to parse board file at ${filePath}:`, err);
		}
	}

	return boards;
}
