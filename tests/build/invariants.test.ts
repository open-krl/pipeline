// tests/build/invariants.test.ts
import { describe, expect, it } from "bun:test";
import {
	checkBoardItineraryStopCountCongruence,
	checkBoardItineraryTimeCongruence,
	checkCrossCaptureTripConsistency,
	checkDeadBand,
	checkEditionConsistency,
	checkIdentifierGrammar,
	checkIntraTripConsistency,
	checkMinBoardOccurrence,
	checkStationReferentialIntegrity,
	checkStopMonotonicity,
	checkSuffixTransition,
	checkTerminusAlignment,
} from "../../src/build/invariants";
import type { RawSnapshot } from "../../src/build/types";

describe("Build Invariants Suite", () => {
	it("Inv 1: checkIntraTripConsistency passes on matching attributes and catches mismatch", () => {
		const validOccurrences = [
			{
				station_id: "BKS",
				train_id: "5552A",
				route_name: "KAMPUNGBANDAN-CIKARANG",
				dest: "CIKARANG",
				dest_time: "15:45:00",
				color: "#E30A16",
				time_est: "14:30:00",
			},
			{
				station_id: "KRI",
				train_id: "5552A",
				route_name: "KAMPUNGBANDAN-CIKARANG",
				dest: "CIKARANG",
				dest_time: "15:45:00",
				color: "#E30A16",
				time_est: "14:36:00",
			},
		];
		expect(checkIntraTripConsistency(validOccurrences).valid).toBe(true);

		const invalidOccurrences = [
			...validOccurrences,
			{
				station_id: "CIT",
				train_id: "5552A",
				route_name: "KAMPUNGBANDAN-BEKASI", // mismatch!
				dest: "CIKARANG",
				dest_time: "15:45:00",
				color: "#E30A16",
				time_est: "14:50:00",
			},
		];
		const res = checkIntraTripConsistency(invalidOccurrences);
		expect(res.valid).toBe(false);
		expect(res.reason).toContain("route_name mismatch");
	});

	it("Inv 2: checkMinBoardOccurrence enforces at least 2 appearances", () => {
		expect(checkMinBoardOccurrence(1)).toBe(false);
		expect(checkMinBoardOccurrence(2)).toBe(true);
		expect(checkMinBoardOccurrence(10)).toBe(true);
	});

	it("Inv 3: checkDeadBand flags departures between 01:30 and 03:30", () => {
		const resPass = checkDeadBand(["01:15:00", "03:45:00", "05:00:00"]);
		expect(resPass.valid).toBe(true);
		expect(resPass.violations.length).toBe(0);

		const resFail = checkDeadBand(["01:15:00", "02:30:00", "03:45:00"]);
		expect(resFail.valid).toBe(false);
		expect(resFail.violations).toEqual(["02:30:00"]);
	});

	it("Inv 4: checkBoardItineraryTimeCongruence tolerates minute rounding (±60s)", () => {
		expect(checkBoardItineraryTimeCongruence("14:30:00", "14:30:25")).toBe(
			true,
		);
		expect(checkBoardItineraryTimeCongruence("14:30:00", "14:31:00")).toBe(
			true,
		);
		expect(checkBoardItineraryTimeCongruence("14:30:00", "14:32:01")).toBe(
			false,
		);
	});

	it("Inv 5: checkTerminusAlignment checks destination ID and dest_time", () => {
		expect(checkTerminusAlignment("CKR", "15:45:00", "CKR", "15:45:30")).toBe(
			true,
		);
		expect(checkTerminusAlignment("CKR", "15:45:00", "BKS", "15:45:00")).toBe(
			false,
		);
		expect(checkTerminusAlignment("CKR", "15:45:00", "CKR", "16:00:00")).toBe(
			false,
		);
	});

	it("Inv 6: checkStopMonotonicity verifies non-decreasing service seconds", () => {
		expect(
			checkStopMonotonicity([
				{ arrival_secs: null, departure_secs: 1000 },
				{ arrival_secs: 1050, departure_secs: 1050 },
				{ arrival_secs: 1100, departure_secs: null },
			]),
		).toBe(true);

		// Negative delta fails
		expect(
			checkStopMonotonicity([
				{ arrival_secs: null, departure_secs: 1000 },
				{ arrival_secs: 900, departure_secs: 900 },
			]),
		).toBe(false);
	});

	it("Inv 7: checkIdentifierGrammar validates canonical train ID pattern", () => {
		expect(checkIdentifierGrammar("5552A")).toBe(true);
		expect(checkIdentifierGrammar("1163F")).toBe(true);
		expect(checkIdentifierGrammar("5022")).toBe(true);
		expect(checkIdentifierGrammar("D1/R1173-2")).toBe(false);
		expect(checkIdentifierGrammar("R1181-2")).toBe(false);
	});

	it("Inv 8: checkSuffixTransition allows <= +1 progression within same day-type", () => {
		expect(checkSuffixTransition(null, "A")).toBe(true);
		expect(checkSuffixTransition("A", "A")).toBe(true);
		expect(checkSuffixTransition("A", "B")).toBe(true);
		expect(checkSuffixTransition("A", "C")).toBe(false); // +2 jump
		expect(checkSuffixTransition("B", "A")).toBe(false); // regression
	});

	it("Inv 9: checkStationReferentialIntegrity rejects unknown and WIL% station codes", () => {
		const valid = new Set(["BKS", "MRI", "THB"]);
		expect(checkStationReferentialIntegrity("BKS", valid)).toBe(true);
		expect(checkStationReferentialIntegrity("XYZ", valid)).toBe(false);
		expect(checkStationReferentialIntegrity("WIL1", valid)).toBe(false);
	});

	it("Inv 11: checkEditionConsistency validates station master and board hashes", () => {
		const mockSnaps: RawSnapshot[] = [
			{
				id: 1,
				manifest: {
					timetable_version: 1,
					snapshot_id: 1,
					snapshot_date: "2026-09-16",
					day_type: "weekday",
					region_scope: "jabodetabek",
					station_master_hash: "hashA",
					board_response_hash: "boardHash1",
					fetched_at: "2026-09-16T10:00:00Z",
					status: "complete",
				},
				archiveCommit: "commit1",
				stations: { status: 200, message: "OK", data: [] },
				boards: new Map(),
			},
			{
				id: 2,
				manifest: {
					timetable_version: 1,
					snapshot_id: 2,
					snapshot_date: "2026-09-17",
					day_type: "weekday",
					region_scope: "jabodetabek",
					station_master_hash: "hashA",
					board_response_hash: "boardHash1",
					fetched_at: "2026-09-17T10:00:00Z",
					status: "complete",
				},
				archiveCommit: "commit2",
				stations: { status: 200, message: "OK", data: [] },
				boards: new Map(),
			},
		];

		expect(checkEditionConsistency(mockSnaps).valid).toBe(true);

		// Station master divergence
		mockSnaps[1].manifest.station_master_hash = "hashB";
		const resStnMismatch = checkEditionConsistency(mockSnaps);
		expect(resStnMismatch.valid).toBe(false);
		expect(resStnMismatch.reason).toContain("Station master hash divergence");

		// Board hash divergence in same day-type
		mockSnaps[1].manifest.station_master_hash = "hashA";
		mockSnaps[1].manifest.board_response_hash = "boardHash2";
		const resBoardMismatch = checkEditionConsistency(mockSnaps);
		expect(resBoardMismatch.valid).toBe(false);
		expect(resBoardMismatch.reason).toContain(
			"Board response hash divergence between snapshot 1 and 2",
		);

		// Board hash difference between DIFFERENT day-types is allowed (evidence, not divergence)
		mockSnaps[1].manifest.day_type = "saturday";
		expect(checkEditionConsistency(mockSnaps).valid).toBe(true);
	});

	it("Inv 12: checkCrossCaptureTripConsistency catches field mismatches across captures", () => {
		const trip1 = {
			route_name_raw: "KAMPUNGBANDAN-CIKARANG",
			headsign: "CIKARANG",
			dest_station_id: "CKR",
			dest_time: "15:45:00",
			color: "#E30A16",
		};
		const trip2 = { ...trip1 };
		expect(checkCrossCaptureTripConsistency(trip1, trip2).valid).toBe(true);

		const tripConflict = { ...trip1, dest_station_id: "BKS" };
		const res = checkCrossCaptureTripConsistency(trip1, tripConflict);
		expect(res.valid).toBe(false);
		expect(res.fieldMismatch).toBe("dest_station_id");
	});

	it("Inv 13: checkBoardItineraryStopCountCongruence asserts appearances == total_stops - 1", () => {
		expect(checkBoardItineraryStopCountCongruence(17, 18)).toBe(true);
		expect(checkBoardItineraryStopCountCongruence(18, 18)).toBe(false);
		expect(checkBoardItineraryStopCountCongruence(16, 18)).toBe(false);
	});
});
