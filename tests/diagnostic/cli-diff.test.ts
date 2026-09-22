// tests/diagnostic/cli-diff.test.ts
import { describe, expect, it } from "bun:test";
import { executeDiff, parseSnapshotRef } from "@/diagnostic/cli-diff";

describe("CLI Diff Tool — parseSnapshotRef", () => {
	it("parses combined <version>:<snapshotId> tokens", () => {
		expect(parseSnapshotRef("1:3", 99)).toEqual({ version: 1, snapshotId: 3 });
		expect(parseSnapshotRef("2:10", 99)).toEqual({
			version: 2,
			snapshotId: 10,
		});
	});

	it("falls back to defaultVersion when only snapshotId is given", () => {
		expect(parseSnapshotRef("4", 2)).toEqual({ version: 2, snapshotId: 4 });
	});

	it("throws on invalid tokens", () => {
		expect(() => parseSnapshotRef("abc", 1)).toThrow("Invalid snapshot ID");
		expect(() => parseSnapshotRef("1:abc", 1)).toThrow(
			"Invalid snapshot reference",
		);
		expect(() => parseSnapshotRef("0:1", 1)).toThrow(
			"Invalid snapshot reference",
		);
		expect(() => parseSnapshotRef("1:-1", 1)).toThrow(
			"Invalid snapshot reference",
		);
		expect(() => parseSnapshotRef("1:3:5", 1)).toThrow(
			"Invalid snapshot reference",
		);
	});
});

describe("CLI Diff Tool — executeDiff integration", () => {
	it("runs diff between snapshots 1 and 3 without errors", async () => {
		let output = "";
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			output += `${String(msg)}\n`;
		};

		try {
			await executeDiff(["1:1", "1:3"], {
				dataDir: "data/raw",
			});
		} finally {
			console.log = originalLog;
		}

		expect(output).toContain(
			"KRL Snapshot Diff: v1:1 (weekday) -> v1:3 (weekday)",
		);
		expect(output).toContain("Evaluation: STABLE (Identical Timetable)");
		expect(output).toContain("identical (114 stations)");
		expect(output).toContain("New in target capture: GRG");
	});

	it("runs diff on train itineraries without errors", async () => {
		let output = "";
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			output += `${String(msg)}\n`;
		};

		try {
			await executeDiff([], {
				dataDir: "data/raw",
				train: ["1000", "1000"],
				detail: true,
			});
		} finally {
			console.log = originalLog;
		}

		expect(output).toContain("Train Itinerary Diff: v1 1000 vs 1000 (weekday)");
		expect(output).toContain("Itinerary: Trip 1000: Identical (17 stops)");
		expect(output).toContain("[BOO] BOGOR");
	});

	it("throws when only one snapshot reference is provided", async () => {
		await expect(executeDiff(["1:1"], { dataDir: "data/raw" })).rejects.toThrow(
			"Expected two snapshot references",
		);
	});

	it("runs diff between snapshots with --git without errors", async () => {
		let output = "";
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			output += `${String(msg)}\n`;
		};

		try {
			await executeDiff(["1:1", "1:3"], {
				dataDir: "data/raw",
				git: true,
			});
		} finally {
			console.log = originalLog;
		}

		expect(output).toContain("--- Raw Git Diff (no-index) ---");
	});

	it("throws when invalid day type is provided for itinerary diff", async () => {
		await expect(
			executeDiff([], {
				dataDir: "data/raw",
				train: ["1000", "1000"],
				dayType: "invalid_day",
			}),
		).rejects.toThrow("Invalid day type 'invalid_day'");
	});
});
