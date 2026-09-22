// tests/archive/layout.test.ts
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	boardFilePath,
	boardsDir,
	capturesDir,
	itinerariesDir,
	itineraryPath,
	logsDir,
	manifestPath,
	snapshotDir,
	stationsPath,
	versionDir,
} from "@/archive/layout";

describe("src/archive/layout", () => {
	const baseDir = path.resolve(process.cwd(), "scratch/test_layout");

	it("resolves version directory path", () => {
		expect(versionDir(baseDir, 1)).toBe(path.resolve(baseDir, "1"));
	});

	it("resolves captures root directory path", () => {
		expect(capturesDir(baseDir, 2)).toBe(path.resolve(baseDir, "2/captures"));
	});

	it("resolves snapshot directory path", () => {
		expect(snapshotDir(baseDir, 1, 3)).toBe(
			path.resolve(baseDir, "1/captures/3"),
		);
	});

	it("resolves boards directory path", () => {
		expect(boardsDir(baseDir, 1, 3)).toBe(
			path.resolve(baseDir, "1/captures/3/boards"),
		);
	});

	it("resolves board file path for station", () => {
		expect(boardFilePath(baseDir, 1, 3, "MRI")).toBe(
			path.resolve(baseDir, "1/captures/3/boards/MRI.json"),
		);
	});

	it("resolves stations path", () => {
		expect(stationsPath(baseDir, 1, 3)).toBe(
			path.resolve(baseDir, "1/captures/3/stations.json"),
		);
	});

	it("resolves manifest path", () => {
		expect(manifestPath(baseDir, 1, 3)).toBe(
			path.resolve(baseDir, "1/captures/3/manifest.json"),
		);
	});

	it("resolves itineraries root directory", () => {
		expect(itinerariesDir(baseDir, 1)).toBe(
			path.resolve(baseDir, "1/itineraries"),
		);
	});

	it("resolves itinerary file path and URL-encodes special characters in train IDs", () => {
		const itinDir = itinerariesDir(baseDir, 1);
		expect(itineraryPath(itinDir, "2200")).toBe(
			path.resolve(itinDir, "2200.json"),
		);
		expect(itineraryPath(itinDir, "2200/2201")).toBe(
			path.resolve(itinDir, "2200%2F2201.json"),
		);
	});

	it("resolves logs directory", () => {
		expect(logsDir(baseDir)).toBe(path.resolve(baseDir, "logs"));
	});
});
