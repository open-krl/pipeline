// tests/build/reconstruct.test.ts
import { describe, expect, it } from "bun:test";
import type { BoardOccurrence } from "@/build/invariants";
import { reconstructFromBoards } from "@/build/reconstruct";

describe("Topological Reconstruction Suite", () => {
	it("reconstructs stop sequence chronologically from board departures and appends terminus", () => {
		const occurrences: BoardOccurrence[] = [
			{
				station_id: "KRI",
				train_id: "5552A",
				route_name: "KAMPUNGBANDAN-CIKARANG",
				dest: "CIKARANG",
				dest_time: "15:45:00",
				color: "#E30A16",
				time_est: "14:40:00", // 2nd
			},
			{
				station_id: "KPB",
				train_id: "5552A",
				route_name: "KAMPUNGBANDAN-CIKARANG",
				dest: "CIKARANG",
				dest_time: "15:45:00",
				color: "#E30A16",
				time_est: "14:10:00", // 1st (origin)
			},
			{
				station_id: "BKS",
				train_id: "5552A",
				route_name: "KAMPUNGBANDAN-CIKARANG",
				dest: "CIKARANG",
				dest_time: "15:45:00",
				color: "#E30A16",
				time_est: "14:50:00", // 3rd
			},
		];

		const result = reconstructFromBoards(occurrences, "CKR");
		expect(result).not.toBeNull();
		if (!result) return;

		expect(result.origin_station_id).toBe("KPB");
		expect(result.dest_station_id).toBe("CKR");
		expect(result.origin_time).toBe("14:10:00");
		expect(result.dest_time).toBe("15:45:00");
		expect(result.total_stops).toBe(4); // 3 boards + 1 terminus

		// Check sequence
		expect(result.stops.map((s) => s.station_id)).toEqual([
			"KPB",
			"KRI",
			"BKS",
			"CKR",
		]);

		// Origin has null arrival, departure populated
		expect(result.stops[0].arrival_secs).toBeNull();
		expect(result.stops[0].departure_secs).toBe(14 * 3600 + 10 * 60);

		// Intermediate has both populated
		expect(result.stops[1].arrival_secs).toBe(14 * 3600 + 40 * 60);
		expect(result.stops[1].departure_secs).toBe(14 * 3600 + 40 * 60);

		// Terminus has arrival populated, null departure
		expect(result.stops[3].arrival_secs).toBe(15 * 3600 + 45 * 60);
		expect(result.stops[3].departure_secs).toBeNull();
	});

	it("returns null on empty occurrences array", () => {
		expect(reconstructFromBoards([], "CKR")).toBeNull();
	});
});
