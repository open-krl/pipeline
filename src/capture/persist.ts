import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	DepartureBoardResponse,
	StationMasterResponse,
} from "../api/schemas";
import {
	capturesDir,
	snapshotDir as snapshotDirHelper,
} from "../archive/layout";
import {
	type CaptureManifest,
	CaptureManifestSchema,
	type DayType,
} from "../archive/schemas";
import { scanSnapshots } from "../archive/snapshots";
import type { RegionScope } from "../config";
import { resolveSafePath } from "../core/path";
import type { CaptureResult } from "./types";

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
	/** Explicit status override. When omitted, falls back to "degraded" or "complete" based on isDegraded. */
	status?: CaptureManifest["status"];
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
			status: params.status ?? (params.isDegraded ? "degraded" : "complete"),
		};

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
