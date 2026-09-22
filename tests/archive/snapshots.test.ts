// tests/archive/snapshots.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { manifestPath, snapshotDir, stationsPath } from "@/archive/layout";
import type { CaptureManifest } from "@/archive/schemas";
import {
	readSnapshotBoards,
	readSnapshotStations,
	scanSnapshots,
	scanTimetableVersions,
} from "@/archive/snapshots";

const TEST_DATA_DIR = path.resolve(
	process.cwd(),
	"scratch/test_archive_snapshots_env",
);

describe("src/archive/snapshots", () => {
	beforeEach(async () => {
		await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
		await fs.mkdir(TEST_DATA_DIR, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
	});

	const sampleManifest: CaptureManifest = {
		timetable_version: 1,
		snapshot_id: 1,
		snapshot_date: "2026-09-17",
		day_type: "weekday",
		region_scope: "jabodetabek",
		station_master_hash: "1".repeat(64),
		board_response_hash: "a".repeat(64),
		fetched_at: "2026-09-17T02:00:00Z",
		status: "complete",
	};

	it("returns empty arrays when directory has no versions or snapshots", async () => {
		expect(await scanTimetableVersions(TEST_DATA_DIR)).toEqual([]);
		expect(await scanSnapshots(TEST_DATA_DIR, 1)).toEqual([]);
	});

	it("discovers versions and snapshots with manifests", async () => {
		const snap1 = snapshotDir(TEST_DATA_DIR, 1, 1);
		const snap2 = snapshotDir(TEST_DATA_DIR, 1, 2);
		const snapV2 = snapshotDir(TEST_DATA_DIR, 2, 1);
		await fs.mkdir(snap1, { recursive: true });
		await fs.mkdir(snap2, { recursive: true });
		await fs.mkdir(snapV2, { recursive: true });

		await fs.writeFile(
			manifestPath(TEST_DATA_DIR, 1, 1),
			JSON.stringify(sampleManifest, null, 2),
		);
		await fs.writeFile(
			manifestPath(TEST_DATA_DIR, 1, 2),
			JSON.stringify({ ...sampleManifest, snapshot_id: 2 }, null, 2),
		);
		await fs.writeFile(
			manifestPath(TEST_DATA_DIR, 2, 1),
			JSON.stringify(
				{ ...sampleManifest, timetable_version: 2, snapshot_id: 1 },
				null,
				2,
			),
		);

		const versions = await scanTimetableVersions(TEST_DATA_DIR);
		expect(versions).toEqual([1, 2]);

		const snapshotsV1 = await scanSnapshots(TEST_DATA_DIR, 1);
		expect(snapshotsV1).toHaveLength(2);
		expect(snapshotsV1[0].id).toBe(1);
		expect(snapshotsV1[1].id).toBe(2);
	});

	it("reads stations and boards deterministically", async () => {
		const snap = snapshotDir(TEST_DATA_DIR, 1, 1);
		const boardsPath = path.join(snap, "boards");
		await fs.mkdir(boardsPath, { recursive: true });

		await fs.writeFile(
			stationsPath(TEST_DATA_DIR, 1, 1),
			JSON.stringify({
				status: 200,
				data: [
					{ sta_id: "MRI", sta_name: "Manggarai", group_wil: 1, fg_enable: 1 },
				],
			}),
		);

		await fs.writeFile(
			path.join(boardsPath, "MRI.json"),
			JSON.stringify({ status: 200, data: [] }),
		);
		await fs.writeFile(
			path.join(boardsPath, "BKS.json"),
			JSON.stringify({ status: 200, data: [] }),
		);

		const stations = await readSnapshotStations(TEST_DATA_DIR, 1, 1);
		expect(stations).not.toBeNull();
		expect(stations?.data).toHaveLength(1);
		expect(stations?.data[0].sta_id).toBe("MRI");

		const boards = await readSnapshotBoards(TEST_DATA_DIR, 1, 1);
		expect(boards.size).toBe(2);
		expect(Array.from(boards.keys())).toEqual(["BKS", "MRI"]);
	});
});
