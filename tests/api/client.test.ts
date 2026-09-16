// tests/api/client.test.ts
import { describe, expect, it } from "bun:test";
import {
	AsyncSemaphore,
	type FetchFunction,
	KciClient,
} from "../../src/api/client";

describe("src/api/client - AsyncSemaphore", () => {
	it("enforces max concurrency limit under concurrent load", async () => {
		const semaphore = new AsyncSemaphore(2);
		let inFlight = 0;
		let maxObservedInFlight = 0;

		const task = async () => {
			return semaphore.run(async () => {
				inFlight++;
				maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 20));
				inFlight--;
			});
		};

		await Promise.all(Array.from({ length: 8 }, () => task()));

		expect(maxObservedInFlight).toBe(2);
		expect(semaphore.activeCount).toBe(0);
		expect(semaphore.pendingCount).toBe(0);
	});

	it("throws if maxConcurrency is less than 1", () => {
		expect(() => new AsyncSemaphore(0)).toThrow();
		expect(() => new AsyncSemaphore(-1)).toThrow();
	});
});

describe("src/api/client - KciClient", () => {
	it("successfully fetches and validates stations list", async () => {
		const mockStationsData = {
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
			],
		};

		let requestedUrl = "";
		let requestedHeaders: HeadersInit | undefined;

		const mockFetch: FetchFunction = async (input, init) => {
			requestedUrl = String(input);
			requestedHeaders = init?.headers;
			return new Response(JSON.stringify(mockStationsData), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			retryBaseMs: 5,
		});

		const result = await client.fetchStations();

		expect(result.status).toBe(200);
		expect(result.data.length).toBe(2);
		expect(result.data[0].sta_id).toBe("MRI");
		expect(requestedUrl).toBe("https://mock.kci.id/api/krl/stations");

		const headers = requestedHeaders as Record<string, string>;
		expect(headers["User-Agent"]).toBeDefined();
		expect(headers.Referer).toBe("https://www.kci.id/");
	});

	it("fetches station schedule with default time window", async () => {
		const mockScheduleData = {
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

		let requestedUrl = "";
		const mockFetch: FetchFunction = async (input) => {
			requestedUrl = String(input);
			return new Response(JSON.stringify(mockScheduleData), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			retryBaseMs: 5,
		});

		const result = await client.fetchStationSchedule("MRI");

		expect(result.status).toBe(200);
		expect(result.data.length).toBe(1);
		expect(result.data[0].train_id).toBe("5022D");
		expect(requestedUrl).toBe(
			"https://mock.kci.id/api/krl/schedules?stationid=MRI&timefrom=00%3A00&timeto=23%3A59",
		);
	});

	it("returns null for train schedule when HTTP 404 is returned", async () => {
		const mockFetch: FetchFunction = async () => {
			return new Response(
				JSON.stringify({ status: 404, message: "Not Found" }),
				{
					status: 404,
				},
			);
		};

		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			retryBaseMs: 5,
		});

		const result = await client.fetchTrainSchedule("9999");
		expect(result).toBeNull();
	});

	it("returns null for train schedule when data array is empty", async () => {
		const mockFetch: FetchFunction = async () => {
			return new Response(JSON.stringify({ status: 200, data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			retryBaseMs: 5,
		});

		const result = await client.fetchTrainSchedule("9999");
		expect(result).toBeNull();
	});

	it("retries on transient 5xx errors and recovers", async () => {
		let callCount = 0;
		const mockFetch: FetchFunction = async () => {
			callCount++;
			if (callCount < 3) {
				return new Response("Internal Server Error", { status: 503 });
			}
			return new Response(
				JSON.stringify({
					status: 200,
					data: [
						{
							train_id: "5022D",
							ka_name: "COMMUTER LINE BOGOR",
							station_id: "MRI",
							station_name: "MANGGARAI",
							time_est: "07:15:00",
							transit_station: true,
							color: "#ED1B24",
							transit: "",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			retryBaseMs: 5, // fast backoff for tests
			maxRetries: 3,
		});

		const result = await client.fetchTrainSchedule("5022D");

		expect(callCount).toBe(3);
		expect(result).not.toBeNull();
		expect(result?.data[0].station_id).toBe("MRI");
	});

	it("fails after exceeding maxRetries on persistent 5xx errors", async () => {
		let callCount = 0;
		const mockFetch: FetchFunction = async () => {
			callCount++;
			return new Response("Internal Server Error", { status: 500 });
		};

		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			retryBaseMs: 5,
			maxRetries: 2,
		});

		await expect(client.fetchStations()).rejects.toThrow("after 2 retries");
		// initial attempt (0) + 2 retries = 3 calls
		expect(callCount).toBe(3);
	});

	it("rejects corrupted payload failing Zod validation", async () => {
		const mockCorruptData = {
			status: 200,
			data: [
				{
					// Missing required fields
					sta_id: "MRI",
				},
			],
		};

		const mockFetch: FetchFunction = async () => {
			return new Response(JSON.stringify(mockCorruptData), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			retryBaseMs: 5,
		});

		await expect(client.fetchStations()).rejects.toThrow();
	});
});
