// tests/core/core.unit.test.ts
import { describe, expect, it } from "bun:test";
import {
	computeBoardResponseHash,
	computeStationMasterHash,
} from "../../src/archive/hashes";
import {
	foldDayTypeRule,
	formatDateWib,
	getDayOfWeekWib,
	resolveDayType,
} from "../../src/core/calendar";
import {
	cleanDestinationName,
	parseRouteName,
	resolveStationId,
} from "../../src/core/route";
import {
	DEAD_BAND_CUTOFF_SECS,
	parseHMS,
	resolveItinerarySecs,
	secsToDisplay,
	toServiceDaySecs,
} from "../../src/core/time";
import { parseTrainId } from "../../src/core/trainid";
import { loadHolidays } from "../../src/db/holidays";

describe("src/core/trainid", () => {
	it("parses base train with revision and fakultatif flag", () => {
		const parsed = parseTrainId("1163F");
		expect(parsed).toEqual({
			trip_id: "1163F",
			base_train_no: 1163,
			revision: null,
			is_fakultatif: true,
		});
	});

	it("parses base train with revision letter", () => {
		const parsed = parseTrainId("5022D");
		expect(parsed).toEqual({
			trip_id: "5022D",
			base_train_no: 5022,
			revision: "D",
			is_fakultatif: false,
		});
	});

	it("parses plain base train without letters", () => {
		const parsed = parseTrainId("5195");
		expect(parsed).toEqual({
			trip_id: "5195",
			base_train_no: 5195,
			revision: null,
			is_fakultatif: false,
		});
	});

	it("parses train with revision and fakultatif combined", () => {
		const parsed = parseTrainId("5552AF");
		expect(parsed).toEqual({
			trip_id: "5552AF",
			base_train_no: 5552,
			revision: "A",
			is_fakultatif: true,
		});
	});

	it("rejects malformed IDs (letters outside A-E, symbols, lowercase)", () => {
		expect(parseTrainId("5022Z")).toBeNull();
		expect(parseTrainId("5022_A")).toBeNull();
		expect(parseTrainId("5022a")).toBeNull();
		expect(parseTrainId("")).toBeNull();
		expect(parseTrainId("ABC")).toBeNull();
	});

	it("sanitizes transport whitespace at boundary", () => {
		const parsed = parseTrainId("  5022D \n");
		expect(parsed).toEqual({
			trip_id: "5022D",
			base_train_no: 5022,
			revision: "D",
			is_fakultatif: false,
		});
	});
});

describe("src/core/time", () => {
	it("exposes DEAD_BAND_CUTOFF_SECS as 03:30:00 (12600s)", () => {
		expect(DEAD_BAND_CUTOFF_SECS).toBe(12600);
		expect(parseHMS("03:30:00")).toBe(DEAD_BAND_CUTOFF_SECS);
	});

	it("converts time to service-day seconds with dead-band wrap", () => {
		// Strictly below 03:30:00 wraps into previous operating day (+86400)
		expect(toServiceDaySecs("00:02:00")).toBe(120 + 86400);
		expect(toServiceDaySecs("01:04:00")).toBe(3840 + 86400);
		expect(toServiceDaySecs("03:29:59")).toBe(12599 + 86400);

		// Exactly at or above 03:30:00 does not wrap
		expect(toServiceDaySecs("03:30:00")).toBe(12600);
		expect(toServiceDaySecs("04:12:00")).toBe(15120);
		expect(toServiceDaySecs("23:59:59")).toBe(86399);
	});

	it("formats continuous seconds past midnight for GTFS", () => {
		expect(secsToDisplay(86520)).toBe("24:02:00");
		expect(secsToDisplay(90600)).toBe("25:10:00");
		expect(secsToDisplay(15120)).toBe("04:12:00");
	});

	it("resolves itinerary sequence across midnight using monotonic walk", () => {
		const stops = [
			{ time_est: "23:50:00" }, // 85800
			{ time_est: "23:58:00" }, // 86280
			{ time_est: "00:05:00" }, // wraps -> 300 + 86400 = 86700
			{ time_est: "00:15:00" }, // 900 + 86400 = 87300
		];

		const resolved = resolveItinerarySecs(stops);
		expect(resolved).toEqual([
			{ arrival_secs: null, departure_secs: 85800 },
			{ arrival_secs: 86280, departure_secs: 86280 },
			{ arrival_secs: 86700, departure_secs: 86700 },
			{ arrival_secs: 87300, departure_secs: null },
		]);
	});
});

describe("src/core/route", () => {
	const stations = [
		{ sta_id: "KPB", sta_name: "KAMPUNG BANDAN" },
		{ sta_id: "CKR", sta_name: "CIKARANG" },
		{ sta_id: "BKS", sta_name: "BEKASI" },
		{ sta_id: "JAKK", sta_name: "JAKARTA KOTA" },
		{ sta_id: "TPK", sta_name: "TANJUNG PRIOK" },
	];

	it("parses route name with VIA token", () => {
		const parsed = parseRouteName("KAMPUNGBANDAN-CIKARANG VIA PSE");
		expect(parsed).toEqual({
			origin_token: "KAMPUNGBANDAN",
			dest_token: "CIKARANG",
			via_token: "PSE",
		});
	});

	it("parses route name without VIA token", () => {
		const parsed = parseRouteName("BEKASI-JAKARTA KOTA");
		expect(parsed).toEqual({
			origin_token: "BEKASI",
			dest_token: "JAKARTA KOTA",
			via_token: null,
		});
	});

	it("cleans trailing bypass/via markers from destination string", () => {
		expect(cleanDestinationName("CIKARANG VIA MRI")).toBe("CIKARANG");
		expect(cleanDestinationName("KAMPUNGBANDAN VIA PSE")).toBe("KAMPUNGBANDAN");
		expect(cleanDestinationName("BOGOR")).toBe("BOGOR");
	});

	it("resolves station IDs via whitespace-insensitive matching", () => {
		expect(resolveStationId("KAMPUNGBANDAN", stations)).toBe("KPB");
		expect(resolveStationId("KAMPUNG BANDAN", stations)).toBe("KPB");
		expect(resolveStationId("CIKARANG", stations)).toBe("CKR");
		expect(resolveStationId("JAKARTA KOTA", stations)).toBe("JAKK");
		expect(resolveStationId("UNKNOWN", stations)).toBeNull();
	});

	it("resolves station IDs with bypass markers and transliterations", () => {
		expect(resolveStationId("CIKARANG VIA MRI", stations)).toBe("CKR");
		expect(resolveStationId("KAMPUNGBANDAN VIA PSE", stations)).toBe("KPB");
		expect(resolveStationId("TANJUNGPRIUK", stations)).toBe("TPK");
	});
});

describe("src/core/calendar", () => {
	const holidays = loadHolidays();

	it("formats date and extracts day of week under Asia/Jakarta clock", () => {
		const dt = new Date("2026-09-17T03:00:00Z"); // 10:00 WIB on Thursday
		expect(formatDateWib(dt)).toBe("2026-09-17");
		expect(getDayOfWeekWib(dt)).toBe(4); // Thursday
	});

	it("correctly evaluates statutory holiday in Asia/Jakarta timezone", () => {
		// 2026-08-17 is Proklamasi Kemerdekaan (statutory holiday)
		const independenceDay = new Date("2026-08-17T05:00:00Z"); // 12:00 WIB
		expect(resolveDayType(independenceDay, holidays)).toBe("holiday");
	});

	it("treats collective leave (cuti bersama) as regular weekday for operation", () => {
		// 2026-02-16 is cuti bersama Imlek (is_collective_leave: true)
		const cutiImlek = new Date("2026-02-16T05:00:00Z");
		expect(resolveDayType(cutiImlek, holidays)).toBe("weekday");
	});

	it("correctly evaluates standard weekend days", () => {
		// 2026-09-19 is a Saturday
		const saturday = new Date("2026-09-19T05:00:00Z");
		expect(resolveDayType(saturday, holidays)).toBe("saturday");

		// 2026-09-20 is a Sunday
		const sunday = new Date("2026-09-20T05:00:00Z");
		expect(resolveDayType(sunday, holidays)).toBe("sunday");
	});

	it("folds captured day types into presence mask columns", () => {
		expect(foldDayTypeRule("weekday")).toBe("runs_weekday");
		expect(foldDayTypeRule("holiday")).toBe("runs_weekday");
		expect(foldDayTypeRule("saturday")).toBe("runs_saturday");
		expect(foldDayTypeRule("sunday")).toBe("runs_sunday");
	});
});

describe("src/core/manifest", () => {
	it("computes station master hash excluding WIL section headers", () => {
		const stations = [
			{
				sta_id: "WIL0",
				sta_name: "AREA JABODETABEK",
				group_wil: 0,
				fg_enable: 0 as const,
			},
			{
				sta_id: "MRI",
				sta_name: "MANGGARAI",
				group_wil: 0,
				fg_enable: 1 as const,
			},
			{
				sta_id: "BKS",
				sta_name: "BEKASI",
				group_wil: 0,
				fg_enable: 1 as const,
			},
		];

		const hash = computeStationMasterHash(stations);
		expect(typeof hash).toBe("string");
		expect(hash.length).toBe(64);

		// Reordered input produces identical hash
		const reordered = [stations[2], stations[0], stations[1]];
		expect(computeStationMasterHash(reordered)).toBe(hash);
	});

	it("computes board response hash deterministically across station ordering", () => {
		const boardsA = {
			BKS: [
				{
					train_id: "5022",
					ka_name: "CIKARANG",
					route_name: "BKS-CKR",
					dest: "CKR",
					time_est: "06:00:00",
					color: "#0084D8",
					dest_time: "06:30:00",
				},
			],
			MRI: [
				{
					train_id: "1001",
					ka_name: "BOGOR",
					route_name: "MRI-BOO",
					dest: "BOO",
					time_est: "06:10:00",
					color: "#FF0000",
					dest_time: "07:00:00",
				},
			],
		};

		const boardsB = {
			MRI: boardsA.MRI,
			BKS: boardsA.BKS,
		};

		expect(computeBoardResponseHash(boardsA)).toBe(
			computeBoardResponseHash(boardsB),
		);
	});
});
