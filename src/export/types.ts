// src/export/types.ts

export interface ExportOptions {
	dbPath?: string;
	version?: number;
	outDir?: string;
	startDate?: string;
	endDate?: string;
	requireResolvedCalendar?: boolean;
	requireCensusComplete?: boolean;
	requireHolidayCoverage?: boolean;
	dumpCsvDir?: string;
	cwd?: string;
}

export interface ExportStats {
	agencyCount: number;
	stopsCount: number;
	routesCount: number;
	tripsCount: number;
	stopTimesCount: number;
	calendarCount: number;
	calendarDatesCount: number;
}

export interface ExportResult {
	zipPath: string;
	zipSizeBytes: number;
	sha256: string;
	timetableVersion: number;
	startDate: string; // YYYYMMDD
	endDate: string; // YYYYMMDD
	durationSecs: number;
	stats: ExportStats;
	warnings: string[];
}

export interface GtfsAgencyMeta {
	agency_id: string;
	agency_name: string;
	agency_url: string;
	agency_timezone: string;
	agency_lang: string;
	agency_phone?: string;
}

export interface AgencyRow {
	agency_id: string;
	agency_name: string;
	agency_url: string;
	agency_timezone: string;
	agency_lang: string;
	agency_phone?: string;
}

export interface StopRow {
	stop_id: string;
	stop_name: string;
	stop_lat: number;
	stop_lon: number;
	location_type: number;
	wheelchair_boarding?: number;
}

export interface RouteRow {
	route_id: string;
	agency_id: string;
	route_short_name: string;
	route_long_name: string;
	route_type: number; // 2 = Rail
	route_color: string; // 6-digit hex without #
	route_text_color: string; // 6-digit hex without #
}

export interface TripRow {
	route_id: string;
	service_id: string;
	trip_id: string;
	trip_headsign: string;
	direction_id?: number;
}

export interface StopTimeRow {
	trip_id: string;
	arrival_time: string; // HH:MM:SS (or 24:XX:XX)
	departure_time: string; // HH:MM:SS (or 24:XX:XX)
	stop_id: string;
	stop_sequence: number;
	pickup_type: number; // 0 = standard, 1 = none
	drop_off_type: number; // 0 = standard, 1 = none
}

export interface CalendarRow {
	service_id: string;
	monday: number;
	tuesday: number;
	wednesday: number;
	thursday: number;
	friday: number;
	saturday: number;
	sunday: number;
	start_date: string; // YYYYMMDD
	end_date: string; // YYYYMMDD
}

export interface CalendarDateRow {
	service_id: string;
	date: string; // YYYYMMDD
	exception_type: number; // 1 = added, 2 = removed
}

export interface FeedData {
	agency: AgencyRow[];
	stops: StopRow[];
	routes: RouteRow[];
	trips: TripRow[];
	stopTimes: StopTimeRow[];
	calendar: CalendarRow[];
	calendarDates: CalendarDateRow[];
}
