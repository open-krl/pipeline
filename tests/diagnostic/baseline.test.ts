// tests/diagnostic/baseline.test.ts

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
	resolveDiagnosticBaseline,
	scanCompiledDatabaseVersions,
} from "@/diagnostic/baseline";

describe("Diagnostic Baseline Resolver (§9, §12)", () => {
	it("scans and numerically sorts compiled database versions in build directory", async () => {
		const scratchDir = "scratch/test_build_versions";
		await fs.mkdir(scratchDir, { recursive: true });

		try {
			// Create dummy files
			await fs.writeFile(path.join(scratchDir, "krl_v1.db"), "");
			await fs.writeFile(path.join(scratchDir, "krl_v10.db"), "");
			await fs.writeFile(path.join(scratchDir, "krl_v2.db"), "");
			await fs.writeFile(path.join(scratchDir, "other.db"), "");
			await fs.writeFile(path.join(scratchDir, "krl_v3.txt"), "");

			const versions = await scanCompiledDatabaseVersions(scratchDir);
			expect(versions).toEqual([1, 2, 10]);
		} finally {
			await fs.rm(scratchDir, { recursive: true, force: true });
		}
	});

	it("returns empty array when build directory does not exist", async () => {
		const versions = await scanCompiledDatabaseVersions(
			"scratch/non_existent_dir",
		);
		expect(versions).toEqual([]);
	});

	it("resolves explicit dbPath and throws on missing db", async () => {
		const scratchDb = "scratch/test_explicit_baseline.db";
		await fs.mkdir(path.dirname(scratchDb), { recursive: true });
		const db = new Database(scratchDb);
		db.run(`
			CREATE TABLE trips (
				timetable_version INTEGER NOT NULL,
				trip_id TEXT NOT NULL,
				PRIMARY KEY (timetable_version, trip_id)
			);
			INSERT INTO trips VALUES (3, 'T1');
		`);
		db.close();

		try {
			const resolved = await resolveDiagnosticBaseline({ dbPath: scratchDb });
			expect(resolved.source).toBe("database");
			expect(resolved.version).toBe(3);

			await expect(
				resolveDiagnosticBaseline({ dbPath: "scratch/missing_db.db" }),
			).rejects.toThrow("Baseline database file not found");
		} finally {
			await fs.unlink(scratchDb).catch(() => {});
		}
	});

	it("throws explicit error when raw dataDir does not exist", async () => {
		await expect(
			resolveDiagnosticBaseline({ dataDir: "scratch/missing_raw_dir" }),
		).rejects.toThrow("Baseline raw data directory not found");
	});

	it("resolves latest database from build directory when version is omitted", async () => {
		const scratchBuild = "scratch/data/build";
		await fs.mkdir(scratchBuild, { recursive: true });

		try {
			await fs.writeFile(path.join(scratchBuild, "krl_v1.db"), "");
			await fs.writeFile(path.join(scratchBuild, "krl_v2.db"), "");

			const resolved = await resolveDiagnosticBaseline({
				cwd: "scratch",
			});
			expect(resolved.source).toBe("database");
			expect(resolved.version).toBe(2);

			const versions = await scanCompiledDatabaseVersions(scratchBuild);
			expect(versions).toEqual([1, 2]);
		} finally {
			await fs.rm("scratch/data", { recursive: true, force: true });
		}
	});
});
