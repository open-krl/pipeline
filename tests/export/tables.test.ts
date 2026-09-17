// tests/export/tables.test.ts
import { describe, expect, it } from "bun:test";
import {
	DEFAULT_AGENCY_META,
	formatAgencyCsv,
	generateAgencyRows,
} from "../../src/export/tables/agency";
import {
	computeServiceId,
	formatCalendarCsv,
	generateCalendarRows,
} from "../../src/export/tables/calendar";
import {
	formatCalendarDatesCsv,
	generateCalendarDateRows,
} from "../../src/export/tables/calendar-dates";
import {
	CANONICAL_ROUTES,
	cleanHexColor,
	formatRoutesCsv,
	generateRouteRows,
	resolveRouteId,
} from "../../src/export/tables/routes";
import {
	formatStopTimesCsv,
	generateStopTimeRows,
} from "../../src/export/tables/stop-times";
import {
	formatStopsCsv,
	generateStopRows,
} from "../../src/export/tables/stops";
import {
	formatTripsCsv,
	generateTripRows,
} from "../../src/export/tables/trips";

describe("src/export/tables — Table Generators", () => {
	it("agency: generates valid KCI agency row and formatted CSV", () => {
		const rows = generateAgencyRows(DEFAULT_AGENCY_META);
		expect(rows).toHaveLength(1);
		expect(rows[0].agency_id).toBe("KCI");
		expect(rows[0].agency_name).toBe("Kereta Commuter Indonesia");
		expect(rows[0].agency_timezone).toBe("Asia/Jakarta");

		const csv = formatAgencyCsv(rows);
		expect(csv).toContain("agency_id,agency_name,agency_url");
		expect(csv).toContain("KCI,Kereta Commuter Indonesia");
	});

	it("stops: verifies coordinates and throws on active station missing lat/lon", () => {
		const stations = [
			{ sta_id: "MRI", sta_name: "MANGGARAI", lat: -6.2098, lon: 106.8501 },
			{ sta_id: "BKS", sta_name: "BEKASI", lat: -6.2362, lon: 106.9987 },
			{ sta_id: "YOG", sta_name: "YOGYA", lat: null, lon: null },
		];

		// Case 1: active stations have coordinates
		const rows = generateStopRows(stations, new Set(["MRI", "BKS"]));
		expect(rows).toHaveLength(2);
		expect(rows[0].stop_id).toBe("BKS");
		expect(rows[1].stop_id).toBe("MRI");

		// Case 2: active station missing coordinates throws error
		expect(() => generateStopRows(stations, new Set(["MRI", "YOG"]))).toThrow(
			"active stations missing WGS-84 coordinates in database: YOG",
		);

		const csv = formatStopsCsv(rows);
		expect(csv).toContain(
			"stop_id,stop_name,stop_lat,stop_lon,location_type\r\n",
		);
		expect(csv).toContain("BKS,BEKASI,-6.2362,106.9987,0\r\n");
	});

	it("routes: normalizes commercial line names and colors", () => {
		expect(resolveRouteId("COMMUTER LINE BOGOR")).toBe("BOGOR");
		expect(resolveRouteId("Commuter Line Cikarang")).toBe("CIKARANG");
		expect(resolveRouteId("COMMUTERLINE MERAK")).toBe("MERAK");
		expect(resolveRouteId("COMMUTER LINE SPECIAL EXPRESS")).toBe(
			"SPECIAL_EXPRESS",
		);

		expect(cleanHexColor("#E30A16")).toBe("E30A16");
		expect(cleanHexColor("e30a16")).toBe("E30A16");
		expect(cleanHexColor("invalid", "0084D8")).toBe("0084D8");

		const trips = [
			{ line_name: "COMMUTER LINE BOGOR", color: "#E30A16" },
			{ line_name: "COMMUTER LINE BOGOR", color: "#F76114" },
			{ line_name: "COMMUTER LINE CIKARANG", color: "#0084D8" },
		];

		const routes = generateRouteRows(trips);
		expect(routes).toHaveLength(2);
		expect(routes[0].route_id).toBe("BOGOR");
		expect(routes[0].route_color).toBe(
			CANONICAL_ROUTES["COMMUTER LINE BOGOR"].color,
		);
		expect(routes[1].route_id).toBe("CIKARANG");

		const csv = formatRoutesCsv(routes);
		expect(csv).toContain(
			"route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\r\n",
		);
		expect(csv).toContain(
			"BOGOR,KCI,B,Commuter Line Bogor,2,E30A16,FFFFFF\r\n",
		);
	});

	it("calendar: derives deterministic signatures and produces recurring masks", () => {
		expect(computeServiceId(1, 0, 0, 0)).toBe("SVC_WD_REG");
		expect(computeServiceId(1, 0, 0, 1)).toBe("SVC_WD_FAK");
		expect(computeServiceId(1, 1, 1, 0)).toBe("SVC_DAILY_REG");
		expect(computeServiceId(1, 1, 0, 0)).toBe("SVC_MON_SAT_REG");
		expect(computeServiceId(0, 1, 1, 0)).toBe("SVC_WEEKEND_REG");

		const signatures = [
			{
				service_id: "SVC_WD_REG",
				runs_weekday: 1,
				runs_saturday: 0,
				runs_sunday: 0,
				is_fakultatif: 0,
			},
			{
				service_id: "SVC_WD_FAK",
				runs_weekday: 1,
				runs_saturday: 0,
				runs_sunday: 0,
				is_fakultatif: 1,
			},
		];

		const rows = generateCalendarRows(signatures, "20260916", "20261231");
		expect(rows).toHaveLength(2);
		expect(rows[0].service_id).toBe("SVC_WD_FAK");
		expect(rows[0].monday).toBe(1);
		expect(rows[0].saturday).toBe(0);
		expect(rows[0].start_date).toBe("20260916");
		expect(rows[0].end_date).toBe("20261231");

		const csv = formatCalendarCsv(rows);
		expect(csv).toContain(
			"service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\r\n",
		);
		expect(csv).toContain("SVC_WD_FAK,1,1,1,1,1,0,0,20260916,20261231\r\n");
	});

	it("calendar_dates: emits exceptions only for fakultatif on mid-week statutory holidays", () => {
		const holidays = [
			// 2026-12-24 is Thursday, but collective leave
			{
				holiday_date: "2026-12-24",
				name: "Cuti Bersama",
				is_collective_leave: 1,
			},
			// 2026-12-25 is Friday, statutory holiday
			{ holiday_date: "2026-12-25", name: "Natal", is_collective_leave: 0 },
			// 2026-08-17 is Monday, statutory holiday
			{ holiday_date: "2026-08-17", name: "HUT RI", is_collective_leave: 0 },
		];

		const fakultatifServices = ["SVC_WD_FAK"];
		const rows = generateCalendarDateRows(
			fakultatifServices,
			holidays,
			"20260916",
			"20261231",
		);

		// 2026-08-17 is outside [20260916, 20261231], 2026-12-24 is collective leave -> only 2026-12-25 emitted
		expect(rows).toHaveLength(1);
		expect(rows[0].service_id).toBe("SVC_WD_FAK");
		expect(rows[0].date).toBe("20261225");
		expect(rows[0].exception_type).toBe(2);

		const csv = formatCalendarDatesCsv(rows);
		expect(csv).toContain("service_id,date,exception_type\r\n");
		expect(csv).toContain("SVC_WD_FAK,20261225,2\r\n");
	});

	it("trips: maps route and service associations", () => {
		const trips = [
			{
				trip_id: "5022D",
				line_name: "COMMUTER LINE BOGOR",
				headsign: "BOGOR",
				runs_weekday: 1,
				runs_saturday: 0,
				runs_sunday: 0,
				is_fakultatif: 0,
			},
			{
				trip_id: "1163F",
				line_name: "COMMUTER LINE BOGOR",
				headsign: "JAKARTA KOTA",
				runs_weekday: 1,
				runs_saturday: 0,
				runs_sunday: 0,
				is_fakultatif: 1,
			},
		];

		const rows = generateTripRows(trips);
		expect(rows).toHaveLength(2);
		expect(rows[0].trip_id).toBe("1163F");
		expect(rows[0].route_id).toBe("BOGOR");
		expect(rows[0].service_id).toBe("SVC_WD_FAK");

		expect(rows[1].trip_id).toBe("5022D");
		expect(rows[1].route_id).toBe("BOGOR");
		expect(rows[1].service_id).toBe("SVC_WD_REG");

		const csv = formatTripsCsv(rows);
		expect(csv).toContain("route_id,service_id,trip_id,trip_headsign\r\n");
		expect(csv).toContain("BOGOR,SVC_WD_REG,5022D,BOGOR\r\n");
	});

	it("stop_times: maps continuous service times and origin/terminus pickup/drop-off flags", () => {
		const stops = [
			// Origin stop
			{
				trip_id: "5022D",
				stop_sequence: 1,
				station_id: "JAKK",
				arrival_secs: null,
				departure_secs: 86100, // 23:55:00
			},
			// Intermediate stop crossing midnight
			{
				trip_id: "5022D",
				stop_sequence: 2,
				station_id: "MGB",
				arrival_secs: 86520, // 24:02:00
				departure_secs: 86520,
			},
			// Terminus stop
			{
				trip_id: "5022D",
				stop_sequence: 3,
				station_id: "BOO",
				arrival_secs: 90000, // 25:00:00
				departure_secs: null,
			},
		];

		const rows = generateStopTimeRows(stops);
		expect(rows).toHaveLength(3);

		// Origin stop
		expect(rows[0].arrival_time).toBe("23:55:00");
		expect(rows[0].departure_time).toBe("23:55:00");
		expect(rows[0].pickup_type).toBe(0);
		expect(rows[0].drop_off_type).toBe(1); // No drop-off at origin

		// Intermediate stop with 24:XX:XX continuous format
		expect(rows[1].arrival_time).toBe("24:02:00");
		expect(rows[1].departure_time).toBe("24:02:00");
		expect(rows[1].pickup_type).toBe(0);
		expect(rows[1].drop_off_type).toBe(0);

		// Terminus stop
		expect(rows[2].arrival_time).toBe("25:00:00");
		expect(rows[2].departure_time).toBe("25:00:00");
		expect(rows[2].pickup_type).toBe(1); // No pickup at terminus
		expect(rows[2].drop_off_type).toBe(0);

		const csv = formatStopTimesCsv(rows);
		expect(csv).toContain(
			"trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\r\n",
		);
		expect(csv).toContain("5022D,24:02:00,24:02:00,MGB,2,0,0\r\n");
	});
});
