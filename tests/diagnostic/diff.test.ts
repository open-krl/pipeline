// tests/diagnostic/diff.test.ts
import { describe, expect, it } from "bun:test";
import type {
	DepartureBoardItem,
	ItineraryStop,
	StationItem,
} from "../../src/api/schemas";
import { diffDepartureBoards } from "../../src/diagnostic/board";
import { diffStationCatalogs } from "../../src/diagnostic/catalog";
import { extractTripSummaries } from "../../src/diagnostic/fingerprint";
import {
	formatBoardDiff,
	formatCatalogDiff,
	formatItineraryDiff,
} from "../../src/diagnostic/format";
import { diffItineraries } from "../../src/diagnostic/itinerary";
import { diffSnapshots } from "../../src/diagnostic/snapshot";

const makeBoard = (items: DepartureBoardItem[]): DepartureBoardItem[] => items;

const boardA: Record<string, DepartureBoardItem[]> = {
	MRI: makeBoard([
		{
			train_id: "5022D",
			ka_name: "COMMUTER LINE BOGOR",
			route_name: "JAKARTA KOTA - BOGOR",
			dest: "BOGOR",
			time_est: "06:15:00",
			dest_time: "07:30:00",
			color: "#D62828",
		},
		{
			train_id: "1102",
			ka_name: "COMMUTER LINE BOGOR",
			route_name: "JAKARTA KOTA - BOGOR",
			dest: "BOGOR",
			time_est: "06:20:00",
			dest_time: "07:35:00",
			color: "#D62828",
		},
		{
			train_id: "9999",
			ka_name: "COMMUTER LINE BOGOR",
			route_name: "JAKARTA KOTA - BOGOR",
			dest: "BOGOR",
			time_est: "06:30:00",
			dest_time: "07:45:00",
			color: "#D62828",
		},
	]),
	PSM: makeBoard([
		{
			train_id: "5022D",
			ka_name: "COMMUTER LINE BOGOR",
			route_name: "JAKARTA KOTA - BOGOR",
			dest: "BOGOR",
			time_est: "06:35:00",
			dest_time: "07:30:00",
			color: "#D62828",
		},
		{
			train_id: "1102",
			ka_name: "COMMUTER LINE BOGOR",
			route_name: "JAKARTA KOTA - BOGOR",
			dest: "BOGOR",
			time_est: "06:40:00",
			dest_time: "07:35:00",
			color: "#D62828",
		},
	]),
};

describe("Semantic Diff Engine — Station Catalog", () => {
	const baselineStations: StationItem[] = [
		{ sta_id: "MRI", sta_name: "Manggarai", group_wil: 0, fg_enable: 1 },
		{ sta_id: "BKS", sta_name: "Bekasi", group_wil: 0, fg_enable: 1 },
		{ sta_id: "GGL", sta_name: "Grogol", group_wil: 0, fg_enable: 1 },
	];

	it("reports identical catalogs accurately", () => {
		const result = diffStationCatalogs(baselineStations, [...baselineStations]);
		expect(result.added.length).toBe(0);
		expect(result.removed.length).toBe(0);
		expect(result.updated.length).toBe(0);
		expect(result.identicalCount).toBe(3);
		expect(result.summary).toContain("identical");
	});

	it("detects added, removed, and field mutations", () => {
		const mutatedStations: StationItem[] = [
			{
				sta_id: "MRI",
				sta_name: "Manggarai Sentral",
				group_wil: 0,
				fg_enable: 1,
			}, // updated name
			{ sta_id: "BKS", sta_name: "Bekasi", group_wil: 0, fg_enable: 0 }, // disabled
			// GGL removed
			{ sta_id: "CKR", sta_name: "Cikarang", group_wil: 0, fg_enable: 1 }, // added
		];

		const result = diffStationCatalogs(baselineStations, mutatedStations);
		expect(result.added.map((s) => s.sta_id)).toEqual(["CKR"]);
		expect(result.removed.map((s) => s.sta_id)).toEqual(["GGL"]);
		expect(result.updated.length).toBe(2);

		const mriUpdate = result.updated.find((u) => u.sta_id === "MRI");
		expect(mriUpdate?.changedFields).toEqual(["sta_name"]);

		const bksUpdate = result.updated.find((u) => u.sta_id === "BKS");
		expect(bksUpdate?.changedFields).toEqual(["fg_enable"]);

		expect(result.summary).toContain(
			"1 added, 1 removed, 2 updated (0 unchanged)",
		);
	});
});

describe("Semantic Diff Engine — Trip Fingerprinting & Departure Boards", () => {
	it("extracts trip summaries with correct origin and service seconds", () => {
		const trips = extractTripSummaries(boardA);
		expect(trips.size).toBe(3);

		const trip5022D = trips.get("5022D");
		expect(trip5022D).toBeDefined();
		expect(trip5022D?.baseTrainNo).toBe(5022);
		expect(trip5022D?.originStation).toBe("MRI");
		expect(trip5022D?.departures.size).toBe(2);
	});

	it("differentiates re-lettered trips from genuinely added/withdrawn trips", () => {
		// In boardB:
		// - 5022D re-lettered to 5022E (identical path & times)
		// - 1102 retimed by +2 mins at all stations (06:22:00, 06:42:00, arr 07:37:00)
		// - 9999 withdrawn
		// - 8888 added
		const boardB: Record<string, DepartureBoardItem[]> = {
			MRI: makeBoard([
				{
					train_id: "5022E", // Re-lettered from 5022D
					ka_name: "COMMUTER LINE BOGOR",
					route_name: "JAKARTA KOTA - BOGOR",
					dest: "BOGOR",
					time_est: "06:15:00",
					dest_time: "07:30:00",
					color: "#D62828",
				},
				{
					train_id: "1102", // Retimed +2m
					ka_name: "COMMUTER LINE BOGOR",
					route_name: "JAKARTA KOTA - BOGOR",
					dest: "BOGOR",
					time_est: "06:22:00",
					dest_time: "07:37:00",
					color: "#D62828",
				},
				{
					train_id: "8888", // Added
					ka_name: "COMMUTER LINE BOGOR",
					route_name: "JAKARTA KOTA - BOGOR",
					dest: "BOGOR",
					time_est: "06:50:00",
					dest_time: "08:05:00",
					color: "#D62828",
				},
			]),
			PSM: makeBoard([
				{
					train_id: "5022E",
					ka_name: "COMMUTER LINE BOGOR",
					route_name: "JAKARTA KOTA - BOGOR",
					dest: "BOGOR",
					time_est: "06:35:00",
					dest_time: "07:30:00",
					color: "#D62828",
				},
				{
					train_id: "1102",
					ka_name: "COMMUTER LINE BOGOR",
					route_name: "JAKARTA KOTA - BOGOR",
					dest: "BOGOR",
					time_est: "06:42:00",
					dest_time: "07:37:00",
					color: "#D62828",
				},
				{
					train_id: "8888",
					ka_name: "COMMUTER LINE BOGOR",
					route_name: "JAKARTA KOTA - BOGOR",
					dest: "BOGOR",
					time_est: "07:05:00",
					dest_time: "08:05:00",
					color: "#D62828",
				},
			]),
		};

		const diff = diffDepartureBoards({
			boardsBefore: boardA,
			boardsAfter: boardB,
			manifestBefore: { day_type: "weekday" },
			manifestAfter: { day_type: "weekday" },
		});

		expect(diff.dayTypeContext).toBe("potential_edition_drift");
		expect(diff.relettered.length).toBe(1);
		expect(diff.relettered[0].trainIdBefore).toBe("5022D");
		expect(diff.relettered[0].trainIdAfter).toBe("5022E");

		expect(diff.retimed.length).toBe(1);
		expect(diff.retimed[0].trainIdBefore).toBe("1102");
		expect(diff.retimed[0].timeDeltaSecs).toBe(120);

		expect(diff.added.length).toBe(1);
		expect(diff.added[0].trainIdAfter).toBe("8888");

		expect(diff.withdrawn.length).toBe(1);
		expect(diff.withdrawn[0].trainIdBefore).toBe("9999");

		expect(diff.summary).toContain(
			"1 re-lettered, 1 retimed, 1 added, 1 withdrawn",
		);
	});

	it("classifies cross-day-type comparisons as calendar variance", () => {
		const diff = diffDepartureBoards({
			boardsBefore: boardA,
			boardsAfter: boardA,
			manifestBefore: { day_type: "weekday" },
			manifestAfter: { day_type: "saturday" },
		});

		expect(diff.dayTypeContext).toBe("calendar_variance");
		expect(diff.summary).toContain("[Calendar Variance: weekday -> saturday]");
	});

	it("detects station coverage gap caused by degraded captures", () => {
		const boardMissingPSM: Record<string, DepartureBoardItem[]> = {
			MRI: boardA.MRI,
		};

		const diff = diffDepartureBoards({
			boardsBefore: boardA,
			boardsAfter: boardMissingPSM,
		});

		expect(diff.stationCoverage.stationsOnlyInBefore).toEqual(["PSM"]);
		expect(diff.summary).toContain("[Coverage: -1 station (missing: PSM)]");
	});

	it("treats reused train_id with divergent destination or zero common stops as withdrawn and added", () => {
		const boardBefore: Record<string, DepartureBoardItem[]> = {
			MRI: [
				{
					train_id: "5000",
					ka_name: "COMMUTER LINE BOGOR",
					route_name: "JAKK-BOO",
					dest: "BOGOR",
					time_est: "06:00:00",
					color: "#ED1B24",
					dest_time: "07:00:00",
				},
			],
		};
		const boardAfterDivergentDest: Record<string, DepartureBoardItem[]> = {
			MRI: [
				{
					train_id: "5000",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "JAKK-CKR",
					dest: "CIKARANG",
					time_est: "06:00:00",
					color: "#0072C6",
					dest_time: "07:00:00",
				},
			],
		};

		const diff = diffDepartureBoards({
			boardsBefore: boardBefore,
			boardsAfter: boardAfterDivergentDest,
		});

		expect(diff.identicalCount).toBe(0);
		expect(diff.withdrawn.length).toBe(1);
		expect(diff.withdrawn[0].trainIdBefore).toBe("5000");
		expect(diff.withdrawn[0].dest).toBe("BOGOR");
		expect(diff.added.length).toBe(1);
		expect(diff.added[0].trainIdAfter).toBe("5000");
		expect(diff.added[0].dest).toBe("CIKARANG");
	});
});

describe("Semantic Diff Engine — Train Itinerary", () => {
	const baselineStops: ItineraryStop[] = [
		{
			train_id: "1022",
			ka_name: "COMMUTER LINE BOGOR",
			station_id: "JAKK",
			station_name: "Jakarta Kota",
			time_est: "06:00:00",
			transit_station: true,
			color: "#D62828",
			transit: [],
		},
		{
			train_id: "1022",
			ka_name: "COMMUTER LINE BOGOR",
			station_id: "MRI",
			station_name: "Manggarai",
			time_est: "06:20:00",
			transit_station: true,
			color: "#D62828",
			transit: [],
		},
		{
			train_id: "1022",
			ka_name: "COMMUTER LINE BOGOR",
			station_id: "BKS",
			station_name: "Bekasi",
			time_est: "06:50:00",
			transit_station: false,
			color: "#D62828",
			transit: [],
		},
	];

	it("reports identical itineraries accurately", () => {
		const diff = diffItineraries("1022", baselineStops, "1022", baselineStops);
		expect(diff.retimedCount).toBe(0);
		expect(diff.addedCount).toBe(0);
		expect(diff.removedCount).toBe(0);
		expect(diff.unchangedCount).toBe(3);
		expect(diff.summary).toBe("Trip 1022: Identical (3 stops)");
	});

	it("detects retimed stops and stop insertions/deletions", () => {
		const modifiedStops: ItineraryStop[] = [
			baselineStops[0], // JAKK unchanged
			{
				...baselineStops[1], // MRI retimed +2m (06:22:00)
				time_est: "06:22:00",
			},
			{
				train_id: "1022",
				ka_name: "COMMUTER LINE BOGOR",
				station_id: "JNG",
				station_name: "Jatinegara",
				time_est: "06:35:00",
				transit_station: true,
				color: "#D62828",
				transit: [],
			}, // JNG added
			// BKS removed
		];

		const diff = diffItineraries("1022", baselineStops, "1022", modifiedStops);
		expect(diff.retimedCount).toBe(1);
		expect(diff.addedCount).toBe(1);
		expect(diff.removedCount).toBe(1);
		expect(diff.unchangedCount).toBe(1);

		const mriStop = diff.stops.find((s) => s.stationId === "MRI");
		expect(mriStop?.status).toBe("retimed");
		expect(mriStop?.deltaSecs).toBe(120);

		expect(diff.summary).toBe(
			"Trip 1022: 1 retimed, 1 added, 1 removed (1 unchanged)",
		);
	});

	it("detects stop sequence inversions and reroutings", () => {
		// Swapped MRI and BKS order
		const invertedStops: ItineraryStop[] = [
			baselineStops[0], // JAKK
			baselineStops[2], // BKS
			baselineStops[1], // MRI
		];

		const diff = diffItineraries("1022", baselineStops, "1022", invertedStops);
		expect(diff.sequenceChanged).toBe(true);
		expect(diff.summary).toContain("sequence changed");

		const jakk = diff.stops.find((s) => s.stationId === "JAKK");
		const mri = diff.stops.find((s) => s.stationId === "MRI");
		const bks = diff.stops.find((s) => s.stationId === "BKS");

		expect(jakk?.reordered).toBe(false);
		expect(mri?.reordered).toBe(true);
		expect(mri?.sequenceBefore).toBe(2);
		expect(mri?.sequenceAfter).toBe(3);

		expect(bks?.reordered).toBe(true);
		expect(bks?.sequenceBefore).toBe(3);
		expect(bks?.sequenceAfter).toBe(2);

		const formatted = formatItineraryDiff(diff);
		expect(formatted).toContain("sequence changed");
		expect(formatted).toContain("[order: #2 -> #3]");
		expect(formatted).toContain("[order: #3 -> #2]");
	});
});

describe("Semantic Diff Engine — Formatters & Snapshot Diffing", () => {
	it("formats catalog, board, and itinerary diff reports cleanly", () => {
		const catDiff = diffStationCatalogs(
			[{ sta_id: "MRI", sta_name: "Manggarai", group_wil: 0, fg_enable: 1 }],
			[
				{
					sta_id: "MRI",
					sta_name: "Manggarai Baru",
					group_wil: 0,
					fg_enable: 1,
				},
				{ sta_id: "BKS", sta_name: "Bekasi", group_wil: 0, fg_enable: 1 },
			],
		);

		const text = formatCatalogDiff(catDiff);
		expect(text).toContain("Station Catalog:");
		expect(text).toContain("Added (1):");
		expect(text).toContain("+ [BKS] Bekasi");
		expect(text).toContain("Updated (1):");
		expect(text).toContain("~ [MRI] name: 'Manggarai' -> 'Manggarai Baru'");

		const itinDiff = diffItineraries(
			"1022",
			[
				{
					train_id: "1022",
					ka_name: "BOGOR",
					station_id: "MRI",
					station_name: "Manggarai",
					time_est: "06:00:00",
					transit_station: false,
					color: "#red",
					transit: [],
				},
			],
			"1022",
			[
				{
					train_id: "1022",
					ka_name: "BOGOR",
					station_id: "MRI",
					station_name: "Manggarai",
					time_est: "06:02:00",
					transit_station: false,
					color: "#red",
					transit: [],
				},
			],
		);

		const itinText = formatItineraryDiff(itinDiff, { detail: true });
		expect(itinText).toContain("Trip 1022: 1 retimed (0 unchanged)");
		expect(itinText).toContain(
			"~ [MRI] Manggarai: 06:00:00 -> 06:02:00 (+2m / +120s)",
		);

		const bDiff = diffDepartureBoards({
			boardsBefore: boardA,
			boardsAfter: boardA,
			manifestBefore: { day_type: "weekday" },
			manifestAfter: { day_type: "weekday" },
		});
		const boardText = formatBoardDiff(bDiff);
		expect(boardText).toContain("Departure Boards:");
		expect(boardText).toContain("Boards identical (3 trips, 2 stations)");
	});

	it("diffs snapshots on disk (data/raw/1/captures/1 vs data/raw/1/captures/3)", async () => {
		const result = await diffSnapshots({
			dataDir: "data/raw",
			before: { version: 1, snapshotId: 1 },
			after: { version: 1, snapshotId: 3 },
		});

		expect(result.snapshotBefore.snapshotId).toBe(1);
		expect(result.snapshotAfter.snapshotId).toBe(3);
		expect(result.catalogDiff).toBeDefined();
		expect(result.boardDiff).toBeDefined();
		expect(result.boardDiff.dayTypeContext).toBe("potential_edition_drift");
		expect(result.summary).toContain("Diff: v1:1 (weekday) -> v1:3 (weekday)");
	});
});
