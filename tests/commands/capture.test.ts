// tests/commands/capture.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { KciClient } from "../../src/api/client";
import type {
	DepartureBoardResponse,
	StationMasterResponse,
} from "../../src/api/schemas";
import { executeCapture } from "../../src/commands/capture";

const TEST_SCRATCH_DIR = path.resolve(
	process.cwd(),
	"scratch/test_capture_env",
);

describe("src/commands/capture", () => {
	beforeEach(async () => {
		await fs.rm(TEST_SCRATCH_DIR, { recursive: true, force: true });
		await fs.mkdir(TEST_SCRATCH_DIR, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(TEST_SCRATCH_DIR, { recursive: true, force: true });
	});

	const mockStationsData: StationMasterResponse = {
		status: 200,
		message: "success",
		data: [
			{
				sta_id: "MRI",
				sta_name: "MANGGARAI",
				group_wil: 0,
				fg_enable: 1,
			},
			{
				sta_id: "BKS",
				sta_name: "BEKASI",
				group_wil: 0,
				fg_enable: 1,
			},
			{
				sta_id: "WIL1",
				sta_name: "WIL. 1 JAKARTA",
				group_wil: 0,
				fg_enable: 0, // Separator header
			},
		],
	};

	const mockMriBoard: DepartureBoardResponse = {
		status: 200,
		data: [
			{
				train_id: "5022D",
				ka_name: "COMMUTER LINE BOGOR",
				route_name: "JAKARTAKOTA-BOGOR",
				dest: "BOGOR",
				time_est: "07:15:00",
				color: "#ED1B24",
				dest_time: "08:45:00",
			},
		],
	};

	const mockBksBoard: DepartureBoardResponse = {
		status: 200,
		data: [
			{
				train_id: "5198C",
				ka_name: "COMMUTER LINE CIKARANG",
				route_name: "ANGKE-CIKARANG",
				dest: "CIKARANG",
				time_est: "00:01:00",
				color: "#0084D8",
				dest_time: "01:04:00",
			},
		],
	};

	function createMockClient(
		overrides?: Partial<{
			stations: StationMasterResponse;
			mriBoard: DepartureBoardResponse;
			bksBoard: DepartureBoardResponse;
			booBoard: DepartureBoardResponse;
			failStation?: string;
		}>,
	) {
		const stations = overrides?.stations ?? mockStationsData;
		const mriBoard = overrides?.mriBoard ?? mockMriBoard;
		const bksBoard = overrides?.bksBoard ?? mockBksBoard;
		const booBoard = overrides?.booBoard ?? mockMriBoard;

		const mockFetch = async (input: RequestInfo | URL) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.includes("/api/krl/stations")) {
				return new Response(JSON.stringify(stations), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("stationid=MRI")) {
				if (overrides?.failStation === "MRI") {
					return new Response("Internal Server Error", { status: 500 });
				}
				return new Response(JSON.stringify(mriBoard), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("stationid=BKS")) {
				return new Response(JSON.stringify(bksBoard), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("stationid=BOO")) {
				return new Response(JSON.stringify(booBoard), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unhandled mock request in capture.test.ts: ${url}`);
		};

		return new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			retryBaseMs: 5,
			pacingMs: 0,
		});
	}

	it("bootstraps initial version 1, snapshot 1 on empty directory", async () => {
		const client = createMockClient();
		const result = await executeCapture({
			client,
			dataDir: TEST_SCRATCH_DIR,
			dayType: "weekday",
		});

		expect(result.timetable_version).toBe(1);
		expect(result.snapshot_id).toBe(1);
		expect(result.manifest.status).toBe("complete");
		expect(result.manifest.day_type).toBe("weekday");

		// Verify files on disk
		const manifestFile = await fs.readFile(
			path.join(result.snapshot_dir, "manifest.json"),
			"utf-8",
		);
		const stationsFile = await fs.readFile(
			path.join(result.snapshot_dir, "stations.json"),
			"utf-8",
		);
		const mriBoardFile = await fs.readFile(
			path.join(result.snapshot_dir, "boards/MRI.json"),
			"utf-8",
		);
		const bksBoardFile = await fs.readFile(
			path.join(result.snapshot_dir, "boards/BKS.json"),
			"utf-8",
		);

		expect(JSON.parse(manifestFile).timetable_version).toBe(1);
		expect(JSON.parse(stationsFile).status).toBe(200);
		expect(JSON.parse(mriBoardFile).data[0].train_id).toBe("5022D");
		expect(JSON.parse(bksBoardFile).data[0].train_id).toBe("5198C");
	});

	it("creates snapshot 2 under version 1 when same day type has identical signature", async () => {
		const client = createMockClient();
		await executeCapture({
			client,
			dataDir: TEST_SCRATCH_DIR,
			dayType: "weekday",
		});

		const result2 = await executeCapture({
			client,
			dataDir: TEST_SCRATCH_DIR,
			dayType: "weekday",
		});

		expect(result2.timetable_version).toBe(1);
		expect(result2.snapshot_id).toBe(2);
	});

	it("Gate 1 halts capture when station catalog mutates without operator consent", async () => {
		const client1 = createMockClient();
		await executeCapture({
			client: client1,
			dataDir: TEST_SCRATCH_DIR,
			dayType: "weekday",
		});

		// Mutate station catalog (add a new station)
		const mutatedStations: StationMasterResponse = {
			status: 200,
			data: [
				...mockStationsData.data,
				{
					sta_id: "BOO",
					sta_name: "BOGOR",
					group_wil: 0,
					fg_enable: 1,
				},
			],
		};
		const client2 = createMockClient({ stations: mutatedStations });

		// Operator declines bump
		await expect(
			executeCapture({
				client: client2,
				dataDir: TEST_SCRATCH_DIR,
				dayType: "weekday",
				promptFn: async () => false,
			}),
		).rejects.toThrow("Gate 1 Alert");
	});

	it("Gate 1 increments timetable version when operator confirms station catalog mutation", async () => {
		const client1 = createMockClient();
		await executeCapture({
			client: client1,
			dataDir: TEST_SCRATCH_DIR,
			dayType: "weekday",
		});

		const mutatedStations: StationMasterResponse = {
			status: 200,
			data: [
				...mockStationsData.data,
				{
					sta_id: "BOO",
					sta_name: "BOGOR",
					group_wil: 0,
					fg_enable: 1,
				},
			],
		};
		const client2 = createMockClient({ stations: mutatedStations });

		// Operator confirms bump
		const result = await executeCapture({
			client: client2,
			dataDir: TEST_SCRATCH_DIR,
			dayType: "weekday",
			promptFn: async () => true,
		});

		expect(result.timetable_version).toBe(2);
		expect(result.snapshot_id).toBe(1);
	});

	it("Gate 2 halts capture when board signatures diverge for same day type without consent", async () => {
		const client1 = createMockClient();
		await executeCapture({
			client: client1,
			dataDir: TEST_SCRATCH_DIR,
			dayType: "weekday",
		});

		// Mutate schedule (different departure time)
		const mutatedMriBoard: DepartureBoardResponse = {
			status: 200,
			data: [
				{
					train_id: "5022D",
					ka_name: "COMMUTER LINE BOGOR",
					route_name: "JAKARTAKOTA-BOGOR",
					dest: "BOGOR",
					time_est: "07:20:00", // Changed from 07:15:00
					color: "#ED1B24",
					dest_time: "08:50:00",
				},
			],
		};
		const client2 = createMockClient({ mriBoard: mutatedMriBoard });

		// Operator declines bump
		await expect(
			executeCapture({
				client: client2,
				dataDir: TEST_SCRATCH_DIR,
				dayType: "weekday",
				promptFn: async () => false,
			}),
		).rejects.toThrow("Gate 2 Alert");
	});

	it("Gate 2 increments version when operator confirms timetable edition revision", async () => {
		const client1 = createMockClient();
		await executeCapture({
			client: client1,
			dataDir: TEST_SCRATCH_DIR,
			dayType: "weekday",
		});

		const mutatedMriBoard: DepartureBoardResponse = {
			status: 200,
			data: [
				{
					train_id: "5022D",
					ka_name: "COMMUTER LINE BOGOR",
					route_name: "JAKARTAKOTA-BOGOR",
					dest: "BOGOR",
					time_est: "07:20:00",
					color: "#ED1B24",
					dest_time: "08:50:00",
				},
			],
		};
		const client2 = createMockClient({ mriBoard: mutatedMriBoard });

		const result = await executeCapture({
			client: client2,
			dataDir: TEST_SCRATCH_DIR,
			dayType: "weekday",
			promptFn: async () => true,
		});

		expect(result.timetable_version).toBe(2);
		expect(result.snapshot_id).toBe(1);
	});

	it("marks snapshot as degraded if a station fails to fetch but others succeed", async () => {
		const client = createMockClient({ failStation: "MRI" });
		const result = await executeCapture({
			client,
			dataDir: TEST_SCRATCH_DIR,
			dayType: "weekday",
		});

		expect(result.manifest.status).toBe("degraded");
		// BKS was saved
		const bksBoardFile = await fs.readFile(
			path.join(result.snapshot_dir, "boards/BKS.json"),
			"utf-8",
		);
		expect(JSON.parse(bksBoardFile).data[0].train_id).toBe("5198C");
	});
});
