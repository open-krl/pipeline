// tests/census/census.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type FetchFunction, KciClient } from "../../src/api/client";
import type {
	CaptureManifest,
	DepartureBoardResponse,
} from "../../src/api/schemas";
import {
	type DiscoveredTrain,
	discoverTrainIds,
	executeCensus,
	readItineraryEnvelope,
	runStratifiedSpotCheck,
	selectStratifiedSample,
	writeItineraryEnvelope,
} from "../../src/census";
import { payloadHash } from "../../src/core/canonical";

const TEST_SCRATCH_DIR = path.resolve(process.cwd(), "scratch/test_census_env");

describe("src/census/census", () => {
	beforeEach(async () => {
		await fs.rm(TEST_SCRATCH_DIR, { recursive: true, force: true });
		await fs.mkdir(TEST_SCRATCH_DIR, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(TEST_SCRATCH_DIR, { recursive: true, force: true });
	});

	async function setupMockSnapshot(
		version = 1,
		snapshotId = 1,
		dayType: "weekday" | "saturday" = "weekday",
		boards: Record<string, DepartureBoardResponse> = {},
	) {
		const capturesDir = path.join(
			TEST_SCRATCH_DIR,
			String(version),
			"captures",
			String(snapshotId),
		);
		const boardsDir = path.join(capturesDir, "boards");
		await fs.mkdir(boardsDir, { recursive: true });

		const manifest: CaptureManifest = {
			timetable_version: version,
			snapshot_id: snapshotId,
			snapshot_date: "2026-09-17",
			day_type: dayType,
			region_scope: "jabodetabek",
			station_master_hash: "a".repeat(64),
			board_response_hash: "b".repeat(64),
			fetched_at: "2026-09-17T03:00:00Z",
			status: "complete",
		};

		await fs.writeFile(
			path.join(capturesDir, "manifest.json"),
			JSON.stringify(manifest),
			"utf-8",
		);

		for (const [staId, data] of Object.entries(boards)) {
			await fs.writeFile(
				path.join(boardsDir, `${staId}.json`),
				JSON.stringify(data),
				"utf-8",
			);
		}
	}

	it("discoverTrainIds aggregates unique train IDs from board captures", async () => {
		await setupMockSnapshot(1, 1, "weekday", {
			MRI: {
				status: 200,
				data: [
					{
						train_id: "2200",
						ka_name: "Commuter Line Bogor",
						route_name: "JAKARTA KOTA-BOGOR",
						dest: "BOGOR",
						time_est: "05:00:00",
						color: "#FF0000",
						dest_time: "06:15:00",
					},
					{
						train_id: "5552A",
						ka_name: "Commuter Line Cikarang",
						route_name: "KAMPUNG BANDAN-CIKARANG",
						dest: "CIKARANG",
						time_est: "05:10:00",
						color: "#0000FF",
						dest_time: "06:30:00",
					},
				],
			},
			BKS: {
				status: 200,
				data: [
					{
						train_id: "5552A",
						ka_name: "Commuter Line Cikarang",
						route_name: "KAMPUNG BANDAN-CIKARANG",
						dest: "CIKARANG",
						time_est: "05:45:00",
						color: "#0000FF",
						dest_time: "06:30:00",
					},
				],
			},
		});

		const discovered = await discoverTrainIds(TEST_SCRATCH_DIR, 1);
		expect(discovered.size).toBe(2);
		expect(discovered.has("2200")).toBe(true);
		expect(discovered.has("5552A")).toBe(true);

		const train5552 = discovered.get("5552A");
		expect(train5552).toBeDefined();
		expect(train5552?.stations).toContain("MRI");
		expect(train5552?.stations).toContain("BKS");
		expect(train5552?.dest).toBe("CIKARANG");
	});

	function mockDiscovered(
		trainId: string,
		kaName: string,
		dest: string,
		stations: string[],
		routeName?: string,
	): [string, DiscoveredTrain] {
		return [
			trainId,
			{
				trainId,
				kaName,
				routeName,
				dest,
				stations,
				dayTypes: new Set(["weekday" as const]),
			},
		];
	}

	it("selectStratifiedSample extracts the 5 representative corridor services", async () => {
		const trains = new Map<string, DiscoveredTrain>([
			mockDiscovered(
				"2200",
				"Commuter Line Bogor",
				"BOGOR",
				["JAKK", "MRI", "BOO"],
				"JAKARTA KOTA-BOGOR",
			),
			mockDiscovered(
				"5001",
				"Commuter Line Cikarang",
				"BEKASI",
				["PSE", "BKS"],
				"PASAR SENEN-BEKASI",
			),
			mockDiscovered(
				"4001",
				"Commuter Line Loop",
				"KAMPUNG BANDAN",
				["KMO", "JNG"],
				"CIKARANG-KAMPUNG BANDAN LOOP",
			),
			mockDiscovered(
				"1901",
				"Commuter Line Rangkasbitung",
				"RANGKASBITUNG",
				["THB", "RK"],
				"TANAH ABANG-RANGKASBITUNG",
			),
			mockDiscovered("9002F", "Commuter Line Fakultatif", "MANGGARAI", ["MRI"]),
		]);

		const sample = selectStratifiedSample(trains);
		expect(sample.bogor?.trainId).toBe("2200");
		expect(sample.cikarang?.trainId).toBe("5001");
		expect(sample.loop?.trainId).toBe("4001");
		expect(sample.branch?.trainId).toBe("1901");
		expect(sample.fakultatif?.trainId).toBe("9002F");
	});

	it("readItineraryEnvelope and writeItineraryEnvelope operate atomically", async () => {
		const envelopePath = path.join(TEST_SCRATCH_DIR, "2200.json");
		const initial = await readItineraryEnvelope(envelopePath);
		expect(initial).toBeNull();

		const envelope = {
			train_id: "2200",
			observations: {
				weekday: {
					fetched_at: "2026-09-17T03:00:00Z",
					payload_hash: "a".repeat(64),
					stops: [
						{
							train_id: "2200",
							ka_name: "Commuter Line Bogor",
							station_id: "MRI",
							station_name: "MANGGARAI",
							time_est: "05:00:00",
							transit_station: true,
							color: "#FF0000",
							transit: "",
						},
					],
				},
			},
		};

		await writeItineraryEnvelope(envelopePath, envelope);
		const readBack = await readItineraryEnvelope(envelopePath);
		expect(readBack).not.toBeNull();
		expect(readBack?.train_id).toBe("2200");
		expect(readBack?.observations.weekday?.stops.length).toBe(1);

		// Corrupted JSON should throw instead of returning null
		await fs.writeFile(envelopePath, "not valid json {", "utf-8");
		await expect(readItineraryEnvelope(envelopePath)).rejects.toThrow();
	});

	it("runStratifiedSpotCheck detects hash divergence and permits fakultatif suspension", async () => {
		const itinerariesDir = path.join(TEST_SCRATCH_DIR, "1", "itineraries");
		await fs.mkdir(itinerariesDir, { recursive: true });

		const weekdayStops = [
			{
				train_id: "2200",
				ka_name: "Commuter Line Bogor",
				station_id: "MRI",
				station_name: "MANGGARAI",
				time_est: "05:00:00",
				transit_station: true,
				color: "#FF0000",
				transit: "",
			},
		];
		const baselineHash = payloadHash(weekdayStops);

		await writeItineraryEnvelope(path.join(itinerariesDir, "2200.json"), {
			train_id: "2200",
			observations: {
				weekday: {
					fetched_at: "2026-09-17T03:00:00Z",
					payload_hash: baselineHash,
					stops: weekdayStops,
				},
			},
		});

		await writeItineraryEnvelope(path.join(itinerariesDir, "9002F.json"), {
			train_id: "9002F",
			observations: {
				weekday: {
					fetched_at: "2026-09-17T03:00:00Z",
					payload_hash: payloadHash([]),
					stops: [],
				},
			},
		});

		// Mock client where 2200 has diverged timetable on weekend, and 9002F is suspended (404)
		const mockFetch: FetchFunction = async (input) => {
			const urlStr = input instanceof Request ? input.url : String(input);
			if (urlStr.includes("trainid=2200")) {
				return new Response(
					JSON.stringify({
						status: 200,
						data: [
							{
								...weekdayStops[0],
								time_est: "05:05:00", // Diverged time!
							},
						],
					}),
					{ status: 200 },
				);
			}
			if (urlStr.includes("trainid=9002F")) {
				return new Response(null, { status: 404 });
			}
			throw new Error(`Unhandled mock request in spot check: ${urlStr}`);
		};

		const client = new KciClient({
			fetchFn: mockFetch,
			pacingMs: 0,
			retryBaseMs: 1,
		});
		const sample = {
			bogor: {
				trainId: "2200",
				stations: ["MRI"],
				dayTypes: new Set(["weekday" as const]),
			},
			fakultatif: {
				trainId: "9002F",
				stations: ["MRI"],
				dayTypes: new Set(["weekday" as const]),
			},
			cikarang: null,
			loop: null,
			branch: null,
		};

		const check = await runStratifiedSpotCheck({
			client,
			itinerariesDir,
			sample,
			currentDayType: "saturday",
		});

		// 2200 diverged
		expect(check.passed).toBe(false);
		expect(check.divergences.length).toBe(1);
		expect(check.divergences[0].trainId).toBe("2200");
		// 9002F (fakultatif) 404 did not count as divergence
	});

	it("executeCensus executes incremental, resumable crawl and enriches existing envelopes", async () => {
		await setupMockSnapshot(1, 1, "weekday", {
			MRI: {
				status: 200,
				data: [
					{
						train_id: "2200",
						ka_name: "Commuter Line Bogor",
						route_name: "JAKARTA KOTA-BOGOR",
						dest: "BOGOR",
						time_est: "05:00:00",
						color: "#FF0000",
						dest_time: "06:15:00",
					},
					{
						train_id: "2202",
						ka_name: "Commuter Line Bogor",
						route_name: "JAKARTA KOTA-BOGOR",
						dest: "BOGOR",
						time_est: "05:15:00",
						color: "#FF0000",
						dest_time: "06:30:00",
					},
				],
			},
		});

		let fetchCalls = 0;
		const mockFetch: FetchFunction = async (input) => {
			fetchCalls++;
			const urlStr = input instanceof Request ? input.url : String(input);
			if (urlStr.includes("trainid=2200")) {
				return new Response(
					JSON.stringify({
						status: 200,
						data: [
							{
								train_id: "2200",
								ka_name: "Commuter Line Bogor",
								station_id: "MRI",
								station_name: "MANGGARAI",
								time_est: "05:00:00",
								transit_station: false,
								color: "#FF0000",
								transit: "",
							},
						],
					}),
					{ status: 200 },
				);
			}
			// 2202 returns 404 (simulating suspended service under test)
			if (urlStr.includes("trainid=2202")) {
				return new Response(null, { status: 404 });
			}
			throw new Error(`Unhandled mock request in crawl: ${urlStr}`);
		};

		const client = new KciClient({
			fetchFn: mockFetch,
			pacingMs: 0,
			retryBaseMs: 1,
		});

		// First pass: crawl both trains
		const result1 = await executeCensus({
			client,
			dataDir: TEST_SCRATCH_DIR,
			version: 1,
			dayType: "weekday",
		});

		expect(result1.totalDiscovered).toBe(2);
		expect(result1.totalProbed).toBe(2);
		expect(result1.successCount).toBe(1);
		expect(result1.notFoundCount).toBe(1);
		expect(result1.cachedCount).toBe(0);
		expect(fetchCalls).toBe(2);

		// Second pass (resumability): both trains are now cached, so zero network calls should occur
		fetchCalls = 0;
		const result2 = await executeCensus({
			client,
			dataDir: TEST_SCRATCH_DIR,
			version: 1,
			dayType: "weekday",
		});

		expect(result2.totalDiscovered).toBe(2);
		expect(result2.totalProbed).toBe(0);
		expect(result2.cachedCount).toBe(2);
		expect(fetchCalls).toBe(0);

		// Verify written envelope for 2200
		const env2200 = await readItineraryEnvelope(
			path.join(TEST_SCRATCH_DIR, "1", "itineraries", "2200.json"),
		);
		expect(env2200?.train_id).toBe("2200");
		expect(env2200?.observations.weekday).toBeDefined();
		expect(env2200?.observations.weekday?.stops.length).toBe(1);

		// Verify written envelope for 2202 (404 empty stops)
		const env2202 = await readItineraryEnvelope(
			path.join(TEST_SCRATCH_DIR, "1", "itineraries", "2202.json"),
		);
		expect(env2202?.train_id).toBe("2202");
		expect(env2202?.observations.weekday?.stops.length).toBe(0);
		expect(env2202?.observations.weekday?.payload_hash).toBe(payloadHash([]));
	});

	it("executeCensus enriches existing envelopes across multiple day types", async () => {
		await setupMockSnapshot(1, 1, "weekday", {
			MRI: {
				status: 200,
				data: [
					{
						train_id: "2200",
						ka_name: "Commuter Line Bogor",
						route_name: "JAKARTA KOTA-BOGOR",
						dest: "BOGOR",
						time_est: "05:00:00",
						color: "#FF0000",
						dest_time: "06:15:00",
					},
				],
			},
		});

		await setupMockSnapshot(1, 2, "saturday", {
			MRI: {
				status: 200,
				data: [
					{
						train_id: "2200",
						ka_name: "Commuter Line Bogor",
						route_name: "JAKARTA KOTA-BOGOR",
						dest: "BOGOR",
						time_est: "05:00:00",
						color: "#FF0000",
						dest_time: "06:15:00",
					},
				],
			},
		});

		const mockFetch: FetchFunction = async () =>
			new Response(
				JSON.stringify({
					status: 200,
					data: [
						{
							train_id: "2200",
							ka_name: "Commuter Line Bogor",
							station_id: "MRI",
							station_name: "MANGGARAI",
							time_est: "05:00:00",
							transit_station: false,
							color: "#FF0000",
							transit: "",
						},
					],
				}),
				{ status: 200 },
			);

		const client = new KciClient({
			fetchFn: mockFetch,
			pacingMs: 0,
			retryBaseMs: 1,
		});

		await executeCensus({
			client,
			dataDir: TEST_SCRATCH_DIR,
			version: 1,
			dayType: "weekday",
		});

		await executeCensus({
			client,
			dataDir: TEST_SCRATCH_DIR,
			version: 1,
			dayType: "saturday",
		});

		const env = await readItineraryEnvelope(
			path.join(TEST_SCRATCH_DIR, "1", "itineraries", "2200.json"),
		);
		expect(env?.observations.weekday).toBeDefined();
		expect(env?.observations.saturday).toBeDefined();
	});

	it("executeCensus fails release gate when target day type lacks a completed snapshot", async () => {
		await setupMockSnapshot(1, 1, "weekday");

		const client = new KciClient({ pacingMs: 0 });
		await expect(
			executeCensus({
				client,
				dataDir: TEST_SCRATCH_DIR,
				version: 1,
				dayType: "saturday", // No Saturday capture exists yet!
			}),
		).rejects.toThrow(
			/No completed capture snapshot found for day type 'saturday'/,
		);
	});
});
