// tests/api/user-agent.test.ts
import { describe, expect, it } from "bun:test";
import { type FetchFunction, KciClient } from "@/api/client";
import { DEFAULT_USER_AGENT } from "@/config";

const MOCK_STATIONS_PAYLOAD = {
	status: 200,
	message: "success",
	data: [
		{
			sta_id: "MRI",
			sta_name: "MANGGARAI",
			group_wil: 0,
			fg_enable: 1,
		},
	],
};

const MOCK_SCHEDULE_PAYLOAD = {
	status: 200,
	message: "success",
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

const MOCK_ITINERARY_PAYLOAD = {
	status: 200,
	message: "success",
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
};

describe("src/api/client - User-Agent header dispatch", () => {
	it("dispatches default RFC 9110 User-Agent across all endpoints when unconfigured", async () => {
		const capturedRequests: Request[] = [];
		const mockFetch: FetchFunction = async (input) => {
			if (input instanceof Request) {
				capturedRequests.push(input);
			}
			return new Response(JSON.stringify(MOCK_STATIONS_PAYLOAD), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			retryBaseMs: 5,
			pacingMs: 0,
		});

		expect(client.userAgent).toBe(DEFAULT_USER_AGENT);

		await client.fetchStations();
		expect(capturedRequests).toHaveLength(1);
		expect(capturedRequests[0].headers.get("User-Agent")).toBe(
			DEFAULT_USER_AGENT,
		);
	});

	it("overrides User-Agent header across all endpoints when configured", async () => {
		const customUa =
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
		const capturedHeaders: Array<string | null> = [];

		const mockFetch: FetchFunction = async (input) => {
			if (input instanceof Request) {
				capturedHeaders.push(input.headers.get("User-Agent"));
				if (input.url.includes("stations")) {
					return new Response(JSON.stringify(MOCK_STATIONS_PAYLOAD), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (input.url.includes("schedules")) {
					return new Response(JSON.stringify(MOCK_SCHEDULE_PAYLOAD), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (input.url.includes("train-schedule")) {
					return new Response(JSON.stringify(MOCK_ITINERARY_PAYLOAD), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
			}
			return new Response(JSON.stringify(MOCK_STATIONS_PAYLOAD), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			userAgent: customUa,
			retryBaseMs: 5,
			pacingMs: 0,
		});

		expect(client.userAgent).toBe(customUa);

		await client.fetchStations();
		await client.fetchStationSchedule("MRI");
		await client.fetchTrainSchedule("5022D");

		expect(capturedHeaders).toHaveLength(3);
		expect(capturedHeaders[0]).toBe(customUa);
		expect(capturedHeaders[1]).toBe(customUa);
		expect(capturedHeaders[2]).toBe(customUa);
	});
});

describe("src/api/client - HTTP 403 Forbidden handling", () => {
	it("fails fast on 403 for fetchStations without retrying", async () => {
		let callCount = 0;
		const mockFetch: FetchFunction = async () => {
			callCount++;
			return new Response(
				JSON.stringify({ status: 403, message: "Forbidden" }),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		};

		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			maxRetries: 3,
			retryBaseMs: 5,
			pacingMs: 0,
		});

		await expect(client.fetchStations()).rejects.toThrow(
			"Failed to fetch stations: HTTP 403",
		);
		// 403 is non-retryable; must not burn the retry loop
		expect(callCount).toBe(1);
	});

	it("fails fast on 403 for fetchStationSchedule without retrying", async () => {
		let callCount = 0;
		const mockFetch: FetchFunction = async () => {
			callCount++;
			return new Response(
				JSON.stringify({ status: 403, message: "Forbidden" }),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		};

		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			maxRetries: 3,
			retryBaseMs: 5,
			pacingMs: 0,
		});

		await expect(client.fetchStationSchedule("MRI")).rejects.toThrow(
			"Failed to fetch schedule for station MRI: HTTP 403",
		);
		expect(callCount).toBe(1);
	});

	it("fails fast on 403 for fetchTrainSchedule rather than treating it as 404 null", async () => {
		let callCount = 0;
		const mockFetch: FetchFunction = async () => {
			callCount++;
			return new Response(
				JSON.stringify({ status: 403, message: "Forbidden" }),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		};

		const client = new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			maxRetries: 3,
			retryBaseMs: 5,
			pacingMs: 0,
		});

		// 404 resolves to null, but 403 must throw
		await expect(client.fetchTrainSchedule("5022D")).rejects.toThrow(
			"Failed to fetch itinerary for train 5022D: HTTP 403",
		);
		expect(callCount).toBe(1);
	});
});

describe("src/api/client - WAF User-Agent blocking matrix evaluation", () => {
	const TEST_CASES = [
		{
			label: "Allowed Generic Mozilla",
			ua: "Mozilla/5.0",
			shouldBlock: false,
		},
		{
			label: "Blocked Outdated Scraper",
			ua: "curl/7.68.0",
			shouldBlock: true,
		},
		{
			label: "Blocked Python Requests",
			ua: "python-requests/2.25.0",
			shouldBlock: true,
		},
		{
			label: "Allowed Real Browser",
			ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0",
			shouldBlock: false,
		},
	];

	for (const { label, ua, shouldBlock } of TEST_CASES) {
		it(`correctly handles ${label} across all endpoints (blocked=${shouldBlock})`, async () => {
			const mockFetch: FetchFunction = async (input) => {
				const req = input instanceof Request ? input : new Request(input);
				const reqUa = req.headers.get("User-Agent") ?? "";

				if (reqUa === "curl/7.68.0" || reqUa.startsWith("python-requests")) {
					return new Response(
						JSON.stringify({ status: 403, message: "Blocked by WAF" }),
						{ status: 403, headers: { "Content-Type": "application/json" } },
					);
				}

				if (req.url.includes("stations")) {
					return new Response(JSON.stringify(MOCK_STATIONS_PAYLOAD), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (req.url.includes("schedules")) {
					return new Response(JSON.stringify(MOCK_SCHEDULE_PAYLOAD), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (req.url.includes("train-schedule")) {
					return new Response(JSON.stringify(MOCK_ITINERARY_PAYLOAD), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}

				return new Response("Not Found", { status: 404 });
			};

			const client = new KciClient({
				baseUrl: "https://mock.kci.id",
				fetchFn: mockFetch,
				userAgent: ua,
				retryBaseMs: 5,
				pacingMs: 0,
				maxRetries: 1,
			});

			if (shouldBlock) {
				await expect(client.fetchStations()).rejects.toThrow("HTTP 403");
				await expect(client.fetchStationSchedule("MRI")).rejects.toThrow(
					"HTTP 403",
				);
				await expect(client.fetchTrainSchedule("5022D")).rejects.toThrow(
					"HTTP 403",
				);
			} else {
				const stations = await client.fetchStations();
				expect(stations.status).toBe(200);

				const schedule = await client.fetchStationSchedule("MRI");
				expect(schedule.status).toBe(200);

				const itinerary = await client.fetchTrainSchedule("5022D");
				expect(itinerary?.status).toBe(200);
			}
		});
	}
});
