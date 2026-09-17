// src/diagnostic/snapshot.ts
import * as fs from "node:fs/promises";
import type { DepartureBoardItem } from "../api/schemas";
import { manifestPath } from "../archive/layout";
import {
	type CaptureManifest,
	CaptureManifestSchema,
} from "../archive/schemas";
import { readSnapshotBoards, readSnapshotStations } from "../archive/snapshots";
import { diffDepartureBoards } from "./board";
import { diffStationCatalogs } from "./catalog";
import type { BoardDiff, CatalogDiff } from "./types";

export interface SnapshotRef {
	version: number;
	snapshotId: number;
}

export interface SnapshotDiffResult {
	snapshotBefore: SnapshotRef;
	snapshotAfter: SnapshotRef;
	manifestBefore: CaptureManifest;
	manifestAfter: CaptureManifest;
	catalogDiff: CatalogDiff | null;
	boardDiff: BoardDiff;
	summary: string;
}

/**
 * Loads and diffs two snapshots directly from raw storage (§8.1, §9).
 */
export async function diffSnapshots(params: {
	dataDir: string;
	before: SnapshotRef;
	after: SnapshotRef;
}): Promise<SnapshotDiffResult> {
	const { dataDir, before, after } = params;

	// 1. Read manifests
	const mPathBefore = manifestPath(dataDir, before.version, before.snapshotId);
	const mPathAfter = manifestPath(dataDir, after.version, after.snapshotId);

	let manifestBefore: CaptureManifest;
	let manifestAfter: CaptureManifest;

	try {
		const raw = await fs.readFile(mPathBefore, "utf-8");
		manifestBefore = CaptureManifestSchema.parse(JSON.parse(raw));
	} catch (err) {
		throw new Error(
			`Failed to read baseline snapshot manifest at ${mPathBefore}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	try {
		const raw = await fs.readFile(mPathAfter, "utf-8");
		manifestAfter = CaptureManifestSchema.parse(JSON.parse(raw));
	} catch (err) {
		throw new Error(
			`Failed to read target snapshot manifest at ${mPathAfter}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// 2. Diff station catalogs
	const stationsBefore = await readSnapshotStations(
		dataDir,
		before.version,
		before.snapshotId,
	);
	const stationsAfter = await readSnapshotStations(
		dataDir,
		after.version,
		after.snapshotId,
	);

	let catalogDiff: CatalogDiff | null = null;
	if (stationsBefore && stationsAfter) {
		catalogDiff = diffStationCatalogs(stationsBefore.data, stationsAfter.data);
	}

	// 3. Diff departure boards
	const boardsBeforeMap = await readSnapshotBoards(
		dataDir,
		before.version,
		before.snapshotId,
	);
	const boardsAfterMap = await readSnapshotBoards(
		dataDir,
		after.version,
		after.snapshotId,
	);

	const boardsBeforeFlat = new Map<string, DepartureBoardItem[]>();
	for (const [staId, res] of boardsBeforeMap.entries()) {
		boardsBeforeFlat.set(staId, res.data);
	}

	const boardsAfterFlat = new Map<string, DepartureBoardItem[]>();
	for (const [staId, res] of boardsAfterMap.entries()) {
		boardsAfterFlat.set(staId, res.data);
	}

	const boardDiff = diffDepartureBoards({
		boardsBefore: boardsBeforeFlat,
		boardsAfter: boardsAfterFlat,
		manifestBefore,
		manifestAfter,
	});

	const summary = [
		`Diff: v${before.version}:${before.snapshotId} (${manifestBefore.day_type}) -> v${after.version}:${after.snapshotId} (${manifestAfter.day_type})`,
		catalogDiff
			? `  ${catalogDiff.summary}`
			: "  Station catalog: (not diffed)",
		`  ${boardDiff.summary}`,
	].join("\n");

	return {
		snapshotBefore: before,
		snapshotAfter: after,
		manifestBefore,
		manifestAfter,
		catalogDiff,
		boardDiff,
		summary,
	};
}
