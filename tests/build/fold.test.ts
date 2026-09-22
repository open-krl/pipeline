// tests/build/fold.test.ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type DepartureBoardResponse,
	DepartureBoardResponseSchema,
	StationMasterResponseSchema,
} from "@/api/schemas";
import { foldArchive } from "@/build/fold";
import type { RawArchive, RawSnapshot } from "@/build/types";

const FIXTURES_DIR = join(import.meta.dir, "../fixtures");

describe("Pure Functional Fold Suite", () => {
	const stationsRaw = JSON.parse(
		readFileSync(join(FIXTURES_DIR, "stations.json"), "utf8"),
	);
	const stationsPayload = StationMasterResponseSchema.parse(stationsRaw);

	const bksBoardRaw = JSON.parse(
		readFileSync(join(FIXTURES_DIR, "schedule_id_bekasi.json"), "utf8"),
	);
	const bksBoard = DepartureBoardResponseSchema.parse(bksBoardRaw);

	const mriBoardRaw = JSON.parse(
		readFileSync(join(FIXTURES_DIR, "schedule_id_manggarai.json"), "utf8"),
	);
	const mriBoard = DepartureBoardResponseSchema.parse(mriBoardRaw);

	const train5552ARaw = JSON.parse(
		readFileSync(join(FIXTURES_DIR, "train_id_5552A.json"), "utf8"),
	);

	it("folds archive with itinerary into clean relational models and provisional calendar", () => {
		const kpbBoard: DepartureBoardResponse = {
			status: 200,
			data: [
				{
					train_id: "5552A",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "KAMPUNGBANDAN-CIKARANG",
					dest: "CIKARANG",
					time_est: "15:39:00",
					color: "#0084D8",
					dest_time: "16:45:00",
				},
			],
		};

		const boardsMap = new Map<string, DepartureBoardResponse>();
		boardsMap.set("BKS", bksBoard);
		boardsMap.set("MRI", mriBoard);
		boardsMap.set("KPB", kpbBoard);

		const mockSnapshot: RawSnapshot = {
			id: 1,
			manifest: {
				timetable_version: 1,
				snapshot_id: 1,
				snapshot_date: "2026-09-17",
				day_type: "weekday",
				region_scope: "jabodetabek",
				station_master_hash: "mockhash",
				board_response_hash: "mockboardhash",
				fetched_at: "2026-09-17T03:00:00Z",
				status: "complete",
			},
			archiveCommit: "abcdef1234567890",
			stations: stationsPayload,
			boards: boardsMap,
		};

		const itinerariesMap = new Map();
		itinerariesMap.set("5552A", {
			train_id: "5552A",
			observations: {
				weekday: {
					fetched_at: "2026-09-17T03:15:00Z",
					payload_hash: "hash5552A",
					stops: train5552ARaw.data,
				},
			},
		});

		const stationCoordinates = new Map<string, { lat: number; lon: number }>();
		stationCoordinates.set("BKS", { lat: -6.2361, lon: 106.9995 });
		stationCoordinates.set("MRI", { lat: -6.2098, lon: 106.8501 });

		const rawArchive: RawArchive = {
			timetableVersion: 1,
			snapshots: [mockSnapshot],
			itineraries: itinerariesMap,
			stationCoordinates,
			holidays: [
				{
					holiday_date: "2026-01-01",
					name: "New Year",
					is_collective_leave: false,
				},
			],
		};

		const result = foldArchive(rawArchive);

		// Verify Stations
		expect(result.stations.length).toBeGreaterThan(50);
		const bksStation = result.stations.find((s) => s.sta_id === "BKS");
		expect(bksStation).toBeDefined();
		expect(bksStation?.lat).toBe(-6.2361);
		expect(bksStation?.lon).toBe(106.9995);

		// Verify Snapshot
		expect(result.snapshots.length).toBe(1);
		expect(result.snapshots[0].archive_commit).toBe("abcdef1234567890");

		// Verify Trip 5552A
		const trip5552A = result.trips.find((t) => t.trip_id === "5552A");
		expect(trip5552A).toBeDefined();
		expect(trip5552A?.source).toBe("itinerary");
		expect(trip5552A?.itinerary_status).toBe("200");
		expect(trip5552A?.total_stops).toBe(18);

		// Verify Trip Calendar (1 day type observed -> provisional)
		const cal5552A = result.tripCalendar.find((c) => c.trip_id === "5552A");
		expect(cal5552A).toBeDefined();
		expect(cal5552A?.runs_weekday).toBe(1);
		expect(cal5552A?.runs_saturday).toBe(0);
		expect(cal5552A?.runs_sunday).toBe(0);
		expect(cal5552A?.calendar_state).toBe("provisional");

		// Verify Trip Stops
		const stops5552A = result.tripStops.filter((s) => s.trip_id === "5552A");
		expect(stops5552A.length).toBe(18);
		expect(stops5552A[0].stop_sequence).toBe(1);
		expect(stops5552A[0].arrival_secs).toBeNull();
		expect(stops5552A[17].departure_secs).toBeNull();
		expect(trip5552A?.origin_secs).toBe(stops5552A[0].departure_secs!);
		expect(trip5552A?.dest_secs).toBe(stops5552A[17].arrival_secs!);

		// Verify Holidays
		expect(result.holidays.length).toBe(1);
		expect(result.holidays[0].holiday_date).toBe("2026-01-01");
		expect(result.holidays[0].is_collective_leave).toBe(0);

		// Stats
		expect(result.stats.totalTrips).toBeGreaterThan(0);
		expect(result.stats.calendarResolved).toBe(false);
	});

	it("promotes calendar_state to 'resolved' when weekday, saturday, and sunday are present", () => {
		const makeSnap = (
			id: number,
			day_type: "weekday" | "saturday" | "sunday",
		): RawSnapshot => {
			const boardsMap = new Map<string, DepartureBoardResponse>();
			boardsMap.set("BKS", bksBoard);
			boardsMap.set("MRI", mriBoard);
			return {
				id,
				manifest: {
					timetable_version: 1,
					snapshot_id: id,
					snapshot_date: `2026-09-${17 + id}`,
					day_type,
					region_scope: "jabodetabek",
					station_master_hash: "hash",
					board_response_hash: `board_${day_type}`,
					fetched_at: "2026-09-17T03:00:00Z",
					status: "complete",
				},
				archiveCommit: `commit_${id}`,
				stations: stationsPayload,
				boards: boardsMap,
			};
		};

		const archive: RawArchive = {
			timetableVersion: 1,
			snapshots: [
				makeSnap(1, "weekday"),
				makeSnap(2, "saturday"),
				makeSnap(3, "sunday"),
			],
			itineraries: new Map(),
			stationCoordinates: new Map(),
			holidays: [],
		};

		const result = foldArchive(archive);
		expect(result.stats.calendarResolved).toBe(true);
		expect(result.stats.dayTypesCaptured).toBe(3);

		for (const cal of result.tripCalendar) {
			expect(cal.calendar_state).toBe("resolved");
		}
	});

	it("quarantines malformed train IDs without failing the fold", () => {
		const boardWithMalformed: DepartureBoardResponse = {
			status: 200,
			data: [
				{
					train_id: "D1/R1173-2", // malformed identifier!
					ka_name: "DINAS RANGKAIAN KRL",
					route_name: "DEPOK-BOGOR",
					dest: "BOGOR",
					time_est: "04:11:00",
					dest_time: "04:37:00",
					color: "#E30A16",
				},
			],
		};

		const boardsMap = new Map<string, DepartureBoardResponse>();
		boardsMap.set("DP", boardWithMalformed);

		const archive: RawArchive = {
			timetableVersion: 1,
			snapshots: [
				{
					id: 1,
					manifest: {
						timetable_version: 1,
						snapshot_id: 1,
						snapshot_date: "2026-09-17",
						day_type: "weekday",
						region_scope: "jabodetabek",
						station_master_hash: "hash",
						board_response_hash: "board",
						fetched_at: "2026-09-17T03:00:00Z",
						status: "complete",
					},
					archiveCommit: "commit1",
					stations: stationsPayload,
					boards: boardsMap,
				},
			],
			itineraries: new Map(),
			stationCoordinates: new Map(),
			holidays: [],
		};

		const result = foldArchive(archive);
		expect(result.trips.length).toBe(0);
		expect(result.quarantinedTrips.length).toBe(1);
		expect(result.quarantinedTrips[0].trip_id).toBe("D1/R1173-2");
		expect(result.quarantinedTrips[0].reason).toBe("malformed_identifier");
	});

	it("falls back to topological reconstruction when itinerary is missing", () => {
		const kpbBoard: DepartureBoardResponse = {
			status: 200,
			data: [
				{
					train_id: "5999A",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "KAMPUNGBANDAN-CIKARANG",
					dest: "CIKARANG",
					time_est: "10:00:00",
					color: "#0084D8",
					dest_time: "11:15:00",
				},
			],
		};
		const bksBoard2: DepartureBoardResponse = {
			status: 200,
			data: [
				{
					train_id: "5999A",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "KAMPUNGBANDAN-CIKARANG",
					dest: "CIKARANG",
					time_est: "10:45:00",
					color: "#0084D8",
					dest_time: "11:15:00",
				},
			],
		};

		const boardsMap = new Map<string, DepartureBoardResponse>();
		boardsMap.set("KPB", kpbBoard);
		boardsMap.set("BKS", bksBoard2);

		const archive: RawArchive = {
			timetableVersion: 1,
			snapshots: [
				{
					id: 1,
					manifest: {
						timetable_version: 1,
						snapshot_id: 1,
						snapshot_date: "2026-09-17",
						day_type: "weekday",
						region_scope: "jabodetabek",
						station_master_hash: "hash",
						board_response_hash: "board",
						fetched_at: "2026-09-17T03:00:00Z",
						status: "complete",
					},
					archiveCommit: "commit1",
					stations: stationsPayload,
					boards: boardsMap,
				},
			],
			itineraries: new Map(), // No itinerary!
			stationCoordinates: new Map(),
			holidays: [],
		};

		const result = foldArchive(archive);
		expect(result.trips.length).toBe(1);
		const trip = result.trips[0];
		expect(trip.trip_id).toBe("5999A");
		expect(trip.source).toBe("reconstructed");
		expect(trip.itinerary_status).toBe("unprobed");
		expect(trip.total_stops).toBe(3); // KPB, BKS, CKR (terminus)

		const stops = result.tripStops.filter((s) => s.trip_id === "5999A");
		expect(stops.length).toBe(3);
		expect(stops[0].station_id).toBe("KPB");
		expect(stops[1].station_id).toBe("BKS");
		expect(stops[2].station_id).toBe("CKR");
		expect(stops[2].departure_secs).toBeNull();
	});

	it("selects the snapshot with the largest occurrence count when reconstructing", () => {
		const snap1Boards = new Map<string, DepartureBoardResponse>();
		snap1Boards.set("KPB", {
			status: 200,
			data: [
				{
					train_id: "5998A",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "KAMPUNGBANDAN-CIKARANG",
					dest: "CIKARANG",
					time_est: "10:00:00",
					color: "#0084D8",
					dest_time: "11:15:00",
				},
			],
		});
		snap1Boards.set("BKS", {
			status: 200,
			data: [
				{
					train_id: "5998A",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "KAMPUNGBANDAN-CIKARANG",
					dest: "CIKARANG",
					time_est: "10:45:00",
					color: "#0084D8",
					dest_time: "11:15:00",
				},
			],
		});

		// Snapshot 2 has 3 boards (more complete than Snapshot 1)
		const snap2Boards = new Map<string, DepartureBoardResponse>();
		snap2Boards.set("KPB", snap1Boards.get("KPB")!);
		snap2Boards.set("MRI", {
			status: 200,
			data: [
				{
					train_id: "5998A",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "KAMPUNGBANDAN-CIKARANG",
					dest: "CIKARANG",
					time_est: "10:20:00",
					color: "#0084D8",
					dest_time: "11:15:00",
				},
			],
		});
		snap2Boards.set("BKS", snap1Boards.get("BKS")!);

		const archive: RawArchive = {
			timetableVersion: 1,
			snapshots: [
				{
					id: 1,
					manifest: {
						timetable_version: 1,
						snapshot_id: 1,
						snapshot_date: "2026-09-17",
						day_type: "weekday",
						region_scope: "jabodetabek",
						station_master_hash: "hash",
						board_response_hash: "board1",
						fetched_at: "2026-09-17T03:00:00Z",
						status: "complete",
					},
					archiveCommit: "commit1",
					stations: stationsPayload,
					boards: snap1Boards,
				},
				{
					id: 2,
					manifest: {
						timetable_version: 1,
						snapshot_id: 2,
						snapshot_date: "2026-09-18",
						day_type: "weekday",
						region_scope: "jabodetabek",
						station_master_hash: "hash",
						board_response_hash: "board2",
						fetched_at: "2026-09-18T03:00:00Z",
						status: "complete",
					},
					archiveCommit: "commit2",
					stations: stationsPayload,
					boards: snap2Boards,
				},
			],
			itineraries: new Map(),
			stationCoordinates: new Map(),
			holidays: [],
		};

		const result = foldArchive(archive);
		const trip = result.trips.find((t) => t.trip_id === "5998A");
		expect(trip?.total_stops).toBe(4); // KPB, MRI, BKS + CKR terminus
		const stops = result.tripStops.filter((s) => s.trip_id === "5998A");
		expect(stops.map((s) => s.station_id)).toEqual([
			"KPB",
			"MRI",
			"BKS",
			"CKR",
		]);
	});

	it("quarantines trips with cross-capture attribute conflict (Inv 12)", () => {
		const snap1Boards = new Map<string, DepartureBoardResponse>();
		snap1Boards.set("KPB", {
			status: 200,
			data: [
				{
					train_id: "5022D",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "KAMPUNGBANDAN-CIKARANG",
					dest: "CIKARANG",
					time_est: "10:00:00",
					color: "#0084D8",
					dest_time: "11:15:00",
				},
			],
		});
		snap1Boards.set("BKS", {
			status: 200,
			data: [
				{
					train_id: "5022D",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "KAMPUNGBANDAN-CIKARANG",
					dest: "CIKARANG",
					time_est: "10:45:00",
					color: "#0084D8",
					dest_time: "11:15:00",
				},
			],
		});

		const snap2Boards = new Map<string, DepartureBoardResponse>();
		snap2Boards.set("KPB", {
			status: 200,
			data: [
				{
					train_id: "5022D",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "KAMPUNGBANDAN-BEKASI", // conflict!
					dest: "BEKASI", // conflict!
					time_est: "10:00:00",
					color: "#0084D8",
					dest_time: "10:50:00",
				},
			],
		});
		snap2Boards.set("BKS", {
			status: 200,
			data: [
				{
					train_id: "5022D",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "KAMPUNGBANDAN-BEKASI",
					dest: "BEKASI",
					time_est: "10:45:00",
					color: "#0084D8",
					dest_time: "10:50:00",
				},
			],
		});

		const archive: RawArchive = {
			timetableVersion: 1,
			snapshots: [
				{
					id: 1,
					manifest: {
						timetable_version: 1,
						snapshot_id: 1,
						snapshot_date: "2026-09-17",
						day_type: "weekday",
						region_scope: "jabodetabek",
						station_master_hash: "hash",
						board_response_hash: "board1",
						fetched_at: "2026-09-17T03:00:00Z",
						status: "complete",
					},
					archiveCommit: "commit1",
					stations: stationsPayload,
					boards: snap1Boards,
				},
				{
					id: 2,
					manifest: {
						timetable_version: 1,
						snapshot_id: 2,
						snapshot_date: "2026-09-18",
						day_type: "saturday",
						region_scope: "jabodetabek",
						station_master_hash: "hash",
						board_response_hash: "board2",
						fetched_at: "2026-09-18T03:00:00Z",
						status: "complete",
					},
					archiveCommit: "commit2",
					stations: stationsPayload,
					boards: snap2Boards,
				},
			],
			itineraries: new Map(),
			stationCoordinates: new Map(),
			holidays: [],
		};

		const result = foldArchive(archive);
		expect(result.trips.length).toBe(0);
		expect(result.quarantinedTrips.length).toBe(1);
		expect(result.quarantinedTrips[0].trip_id).toBe("5022D");
		expect(result.quarantinedTrips[0].reason).toBe("attribute_conflict");
	});

	it("applies trip-scoped station override for 5169D (KAT -> SUDB) but leaves untargeted trains to topological fallback", () => {
		const sudbBoard: DepartureBoardResponse = {
			status: 200,
			data: [
				{
					train_id: "5169D",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "ANGKE-BEKASI",
					dest: "BEKASI",
					time_est: "10:15:00",
					color: "#0084D8",
					dest_time: "11:00:00",
				},
				{
					train_id: "5022D",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "ANGKE-BEKASI",
					dest: "BEKASI",
					time_est: "10:15:00",
					color: "#0084D8",
					dest_time: "11:00:00",
				},
			],
		};

		const mriBoard2: DepartureBoardResponse = {
			status: 200,
			data: [
				{
					train_id: "5169D",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "ANGKE-BEKASI",
					dest: "BEKASI",
					time_est: "10:25:00",
					color: "#0084D8",
					dest_time: "11:00:00",
				},
				{
					train_id: "5022D",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "ANGKE-BEKASI",
					dest: "BEKASI",
					time_est: "10:25:00",
					color: "#0084D8",
					dest_time: "11:00:00",
				},
			],
		};

		const boardsMap = new Map<string, DepartureBoardResponse>();
		boardsMap.set("SUDB", sudbBoard);
		boardsMap.set("MRI", mriBoard2);

		const itinerariesMap = new Map();
		itinerariesMap.set("5169D", {
			train_id: "5169D",
			observations: {
				weekday: {
					fetched_at: "2026-09-17T03:15:00Z",
					payload_hash: "hash5169D",
					stops: [
						{ station_id: "KAT", time_est: "10:15:00", transit_station: false },
						{ station_id: "MRI", time_est: "10:25:00", transit_station: false },
						{ station_id: "BKS", time_est: "11:00:00", transit_station: false },
					],
				},
			},
		});

		// 5022D has the same KAT stop in its itinerary, but is NOT in TRIP_STATION_OVERRIDES
		itinerariesMap.set("5022D", {
			train_id: "5022D",
			observations: {
				weekday: {
					fetched_at: "2026-09-17T03:15:00Z",
					payload_hash: "hash5022D",
					stops: [
						{ station_id: "KAT", time_est: "10:15:00", transit_station: false },
						{ station_id: "MRI", time_est: "10:25:00", transit_station: false },
						{ station_id: "BKS", time_est: "11:00:00", transit_station: false },
					],
				},
			},
		});

		const archive: RawArchive = {
			timetableVersion: 1,
			snapshots: [
				{
					id: 1,
					manifest: {
						timetable_version: 1,
						snapshot_id: 1,
						snapshot_date: "2026-09-17",
						day_type: "weekday",
						region_scope: "jabodetabek",
						station_master_hash: "hash",
						board_response_hash: "board",
						fetched_at: "2026-09-17T03:00:00Z",
						status: "complete",
					},
					archiveCommit: "commit1",
					stations: stationsPayload,
					boards: boardsMap,
				},
			],
			itineraries: itinerariesMap,
			stationCoordinates: new Map(),
			holidays: [],
		};

		const result = foldArchive(archive);

		// 1. Target train 5169D: KAT is resolved to SUDB via TRIP_STATION_OVERRIDES
		const trip5169D = result.trips.find((t) => t.trip_id === "5169D");
		expect(trip5169D).toBeDefined();
		expect(trip5169D?.source).toBe("itinerary");
		expect(trip5169D?.origin_station_id).toBe("SUDB");
		expect(trip5169D?.dest_station_id).toBe("BKS");

		const stops5169D = result.tripStops.filter((s) => s.trip_id === "5169D");
		expect(stops5169D.length).toBe(3);
		expect(stops5169D[0].station_id).toBe("SUDB");
		expect(stops5169D[1].station_id).toBe("MRI");
		expect(stops5169D[2].station_id).toBe("BKS");

		// 2. Non-target train 5022D: KAT remains unmapped, fails Invariant 9, and falls back to reconstruction
		const trip5022D = result.trips.find((t) => t.trip_id === "5022D");
		expect(trip5022D).toBeDefined();
		expect(trip5022D?.source).toBe("reconstructed");

		const stops5022D = result.tripStops.filter((s) => s.trip_id === "5022D");
		expect(stops5022D.length).toBe(3);
		expect(stops5022D[0].station_id).toBe("SUDB");
		expect(stops5022D[1].station_id).toBe("MRI");
		expect(stops5022D[2].station_id).toBe("BKS");
	});
});
