// tests/export/export.test.ts

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { executeBuild } from "../../src/build/build";
import { executeExport, normalizeDateToGtfs } from "../../src/export/export";

describe("Stage 4 GTFS Export Integration Suite", () => {
	const testOutDir = path.join(process.cwd(), "scratch/test_gtfs_export");
	const testCsvDir = path.join(testOutDir, "csv_dump");
	const dbPath = path.join(process.cwd(), "data/build/krl_v1.db");

	it("normalizeDateToGtfs: validates real calendar dates and rejects impossible dates", () => {
		expect(normalizeDateToGtfs("2026-09-16")).toBe("20260916");
		expect(normalizeDateToGtfs("20261231")).toBe("20261231");
		expect(() => normalizeDateToGtfs("2026-02-30")).toThrow(
			"impossible date components",
		);
		expect(() => normalizeDateToGtfs("20261301")).toThrow(
			"impossible date components",
		);
		expect(() => normalizeDateToGtfs("invalid-date")).toThrow(
			"Invalid date format",
		);
	});

	beforeAll(async () => {
		await fs.mkdir(testOutDir, { recursive: true });
		try {
			await fs.access(dbPath);
		} catch {
			await executeBuild({ version: 1, dbPath });
		}
	});

	afterAll(async () => {
		await fs.rm(testOutDir, { recursive: true, force: true });
	});

	it("compiles GTFS archive and sha256 digest from SQLite database", async () => {
		const result = await executeExport({
			dbPath,
			outDir: testOutDir,
			dumpCsvDir: testCsvDir,
			startDate: "2026-09-16",
			endDate: "2026-12-25", // Within covered holidays
		});

		expect(result.timetableVersion).toBe(1);
		expect(result.startDate).toBe("20260916");
		expect(result.endDate).toBe("20261225");
		expect(result.stats.agencyCount).toBe(1);
		expect(result.stats.stopsCount).toBe(94);
		expect(result.stats.routesCount).toBe(6);
		expect(result.stats.tripsCount).toBe(1139);
		expect(result.stats.stopTimesCount).toBeGreaterThan(15000);
		expect(result.stats.calendarCount).toBeGreaterThanOrEqual(1);
		expect(result.stats.calendarDatesCount).toBeGreaterThanOrEqual(1);
		expect(result.zipSizeBytes).toBeGreaterThan(100000); // > 100 KB
		expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

		// Verify files on disk
		const zipBuffer = await fs.readFile(result.zipPath);
		const shaFileContent = await fs.readFile(
			`${result.zipPath}.sha256`,
			"utf-8",
		);

		const computedHash = crypto
			.createHash("sha256")
			.update(zipBuffer)
			.digest("hex");
		expect(computedHash).toBe(result.sha256);
		expect(shaFileContent).toContain(result.sha256);

		// Verify unzipped contents using fflate
		const unzipped = unzipSync(new Uint8Array(zipBuffer));
		const expectedFiles = [
			"agency.txt",
			"stops.txt",
			"routes.txt",
			"trips.txt",
			"stop_times.txt",
			"calendar.txt",
			"calendar_dates.txt",
		];

		for (const expected of expectedFiles) {
			expect(unzipped[expected]).toBeDefined();
		}

		// Verify CSV dumps on disk
		for (const expected of expectedFiles) {
			const dumpContent = await fs.readFile(
				path.join(testCsvDir, expected),
				"utf-8",
			);
			expect(dumpContent.length).toBeGreaterThan(0);
		}

		// Referential integrity verification
		const stopsCsv = strFromU8(unzipped["stops.txt"]);
		const routesCsv = strFromU8(unzipped["routes.txt"]);
		const tripsCsv = strFromU8(unzipped["trips.txt"]);
		const stopTimesCsv = strFromU8(unzipped["stop_times.txt"]);
		const calendarCsv = strFromU8(unzipped["calendar.txt"]);

		const validStopIds = new Set<string>();
		for (const line of stopsCsv.trim().split("\r\n").slice(1)) {
			const [stopId, , lat, lon] = line.split(",");
			validStopIds.add(stopId);
			expect(Number.parseFloat(lat)).not.toBeNaN();
			expect(Number.parseFloat(lon)).not.toBeNaN();
		}

		const validRouteIds = new Set<string>();
		for (const line of routesCsv.trim().split("\r\n").slice(1)) {
			const [routeId] = line.split(",");
			validRouteIds.add(routeId);
		}

		const validServiceIds = new Set<string>();
		for (const line of calendarCsv.trim().split("\r\n").slice(1)) {
			const [serviceId] = line.split(",");
			validServiceIds.add(serviceId);
		}

		const validTripIds = new Set<string>();
		for (const line of tripsCsv.trim().split("\r\n").slice(1)) {
			const [routeId, serviceId, tripId] = line.split(",");
			expect(validRouteIds.has(routeId)).toBe(true);
			expect(validServiceIds.has(serviceId)).toBe(true);
			validTripIds.add(tripId);
		}

		// Check stop_times foreign keys
		for (const line of stopTimesCsv.trim().split("\r\n").slice(1)) {
			const [tripId, arrTime, depTime, stopId] = line.split(",");
			expect(validTripIds.has(tripId)).toBe(true);
			expect(validStopIds.has(stopId)).toBe(true);
			expect(arrTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
			expect(depTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
		}
	});

	it("release gate: halts on --require-resolved-calendar when calendar is provisional", async () => {
		await expect(
			executeExport({
				dbPath,
				outDir: testOutDir,
				requireResolvedCalendar: true,
			}),
		).rejects.toThrow("Release Gate Failed (--require-resolved-calendar)");
	});

	it("release gate: passes on --require-census-complete when all trips are probed", async () => {
		const result = await executeExport({
			dbPath,
			outDir: testOutDir,
			requireCensusComplete: true,
			endDate: "2026-12-25",
		});
		expect(result.stats.tripsCount).toBe(1139);
	});
});
