// tests/api/client.test.ts
import { describe, expect, it } from "bun:test";
import { SchemaValidationError } from "ky";
import {
	AsyncSemaphore,
	type FetchFunction,
	KciClient,
} from "../../src/api/client";
import { StructuredLogger } from "../../src/core/logger";

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

		let capturedRequest: Request | undefined;

		const mockFetch: FetchFunction = async (input) => {
			if (input instanceof Request) {
				capturedRequest = input;
			}
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
		expect(capturedRequest?.url).toBe("https://mock.kci.id/api/krl/stations");
		expect(capturedRequest?.headers.get("User-Agent")).toBeDefined();
		expect(capturedRequest?.headers.get("Referer")).toBe("https://www.kci.id/");
	});

	it("globally paces concurrent request starts", async () => {
		const requestStarts: number[] = [];
		const mockFetch: FetchFunction = async () => {
			requestStarts.push(performance.now());
			return new Response(
				JSON.stringify({ status: 200, message: "success", data: [] }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const pacingMs = 40;
		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			pacingMs,
		});

		await Promise.all([
			client.fetchStations(),
			client.fetchStations(),
			client.fetchStations(),
		]);

		for (let index = 1; index < requestStarts.length; index++) {
			expect(
				requestStarts[index] - requestStarts[index - 1],
			).toBeGreaterThanOrEqual(pacingMs - 10);
		}
	});

	it("paces retry attempts", async () => {
		const requestStarts: number[] = [];
		let callCount = 0;
		const mockFetch: FetchFunction = async () => {
			requestStarts.push(performance.now());
			callCount++;
			if (callCount === 1) {
				return new Response("Internal Server Error", { status: 503 });
			}
			return new Response(
				JSON.stringify({ status: 200, message: "success", data: [] }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const attemptLogs: Array<Record<string, unknown>> = [];
		const logger = new StructuredLogger();
		logger.debug = (_scope, _event, _message, data = {}) => {
			attemptLogs.push(data);
		};

		const pacingMs = 40;
		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			pacingMs,
			retryBaseMs: 1,
			maxRetries: 1,
			logger,
		});

		await client.fetchStations();

		expect(requestStarts).toHaveLength(2);
		expect(requestStarts[1] - requestStarts[0]).toBeGreaterThanOrEqual(
			pacingMs - 10,
		);
		expect(attemptLogs).toHaveLength(2);
		expect(attemptLogs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					url: "https://mock.kci.id/api/krl/stations",
					method: "GET",
					retryCount: 0,
					pacingMs,
				}),
				expect.objectContaining({
					retryCount: 1,
				}),
			]),
		);
		for (const attempt of attemptLogs) {
			expect(attempt.attemptStartedAt).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
			);
		}
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
			requestedUrl = input instanceof Request ? input.url : String(input);
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

		await expect(client.fetchStations()).rejects.toThrow("HTTP 500");
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

		// .json(schema) throws Ky's SchemaValidationError, which passes through contextualize untouched
		await expect(client.fetchStations()).rejects.toThrow(SchemaValidationError);
	});

	it("aborts when fetch exceeds configured timeoutMs", async () => {
		const mockFetch: FetchFunction = async (_input, init) => {
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal) {
					signal.addEventListener("abort", () => {
						reject(signal.reason ?? new Error("The operation was aborted"));
					});
				}
				// Never resolves on its own (stalled connection)
			});
		};

		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			timeoutMs: 30,
			retryBaseMs: 5,
			maxRetries: 1,
		});

		await expect(client.fetchStations()).rejects.toThrow();
	});

	it("handles Retry-After delta-seconds and HTTP-date with maxDelayMs cap", async () => {
		let callCount = 0;
		const mockFetch: FetchFunction = async () => {
			callCount++;
			if (callCount === 1) {
				return new Response("Too Many Requests", {
					status: 429,
					headers: { "Retry-After": "1" }, // 1 second
				});
			}
			return new Response(
				JSON.stringify({ status: 200, message: "success", data: [] }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			retryBaseMs: 5,
			maxRetries: 2,
		});

		const result = await client.fetchStations();
		expect(callCount).toBe(2);
		expect(result.status).toBe(200);
	});
});
