// tests/capture/snapshots.test.ts

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CaptureManifest } from "../../src/archive/schemas";
import { formatSnapshotTable, getSnapshotList } from "../../src/capture";

const TEST_DATA_DIR = path.resolve(
	process.cwd(),
	"scratch/test_snapshots_list_env",
);

describe("src/capture/snapshots", () => {
	beforeEach(async () => {
		await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
		await fs.mkdir(TEST_DATA_DIR, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
	});

	const sampleManifest1: CaptureManifest = {
		timetable_version: 1,
		snapshot_id: 1,
		snapshot_date: "2026-09-16",
		day_type: "weekday",
		region_scope: "jabodetabek",
		station_master_hash: "1".repeat(64),
		board_response_hash: "a".repeat(64),
		fetched_at: "2026-09-16T10:00:00Z",
		status: "complete",
	};

	const sampleManifest2: CaptureManifest = {
		timetable_version: 1,
		snapshot_id: 2,
		snapshot_date: "2026-09-19",
		day_type: "saturday",
		region_scope: "jabodetabek",
		station_master_hash: "1".repeat(64),
		board_response_hash: "b".repeat(64),
		fetched_at: "2026-09-19T10:00:00Z",
		status: "complete",
	};

	it("returns empty list when no timetable versions exist", async () => {
		const list = await getSnapshotList({ dataDir: TEST_DATA_DIR });
		expect(list).toEqual([]);
		expect(formatSnapshotTable(list)).toBe("No timetable snapshots found.");
	});

	it("discovers and lists snapshots across versions", async () => {
		const snap1Dir = path.join(TEST_DATA_DIR, "1/captures/1");
		const snap2Dir = path.join(TEST_DATA_DIR, "1/captures/2");
		await fs.mkdir(snap1Dir, { recursive: true });
		await fs.mkdir(snap2Dir, { recursive: true });
		await fs.writeFile(
			path.join(snap1Dir, "manifest.json"),
			JSON.stringify(sampleManifest1, null, 2),
		);
		await fs.writeFile(
			path.join(snap2Dir, "manifest.json"),
			JSON.stringify(sampleManifest2, null, 2),
		);

		const list = await getSnapshotList({ dataDir: TEST_DATA_DIR });
		expect(list).toHaveLength(2);

		expect(list[0].version).toBe(1);
		expect(list[0].snapshotId).toBe(1);
		expect(list[0].manifest.day_type).toBe("weekday");

		expect(list[1].version).toBe(1);
		expect(list[1].snapshotId).toBe(2);
		expect(list[1].manifest.day_type).toBe("saturday");

		const table = formatSnapshotTable(list);
		expect(table).toContain("Snapshot");
		expect(table).toContain("Date");
		expect(table).toContain("Day Type");
		expect(table).toContain("v1/1");
		expect(table).toContain("v1/2");
		expect(table).toContain("weekday");
		expect(table).toContain("aaaaaaaa...");
		expect(table).toContain("bbbbbbbb...");
	});

	it("filters snapshots by specific version", async () => {
		const snapV1 = path.join(TEST_DATA_DIR, "1/captures/1");
		const snapV2 = path.join(TEST_DATA_DIR, "2/captures/1");
		await fs.mkdir(snapV1, { recursive: true });
		await fs.mkdir(snapV2, { recursive: true });
		await fs.writeFile(
			path.join(snapV1, "manifest.json"),
			JSON.stringify(sampleManifest1, null, 2),
		);
		await fs.writeFile(
			path.join(snapV2, "manifest.json"),
			JSON.stringify({ ...sampleManifest1, timetable_version: 2 }, null, 2),
		);

		const listV2 = await getSnapshotList({
			dataDir: TEST_DATA_DIR,
			version: 2,
		});
		expect(listV2).toHaveLength(1);
		expect(listV2[0].version).toBe(2);
	});
});
