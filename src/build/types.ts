// src/build/types.ts
import type {
	DepartureBoardResponse,
	StationMasterResponse,
} from "../api/schemas";
import type {
	CaptureManifest,
	HolidayItem,
	MultiObservationItinerary,
} from "../archive/schemas";
import type * as schema from "../db/tables";

export interface RawSnapshot {
	id: number;
	manifest: CaptureManifest;
	archiveCommit: string;
	stations: StationMasterResponse;
	boards: Map<string, DepartureBoardResponse>;
}

export interface RawArchive {
	timetableVersion: number;
	snapshots: RawSnapshot[];
	itineraries: Map<string, MultiObservationItinerary>;
	stationCoordinates: Map<string, { lat: number; lon: number }>;
	holidays: HolidayItem[];
}

export interface FoldStats {
	totalTrips: number;
	itineraryTrips: number;
	reconstructedTrips: number;
	quarantinedTrips: number;
	calendarResolved: boolean;
	dayTypesCaptured: number;
	totalStops: number;
	totalStations: number;
}

export interface FoldResult {
	stations: Array<typeof schema.stations.$inferInsert>;
	snapshots: Array<typeof schema.snapshots.$inferInsert>;
	trips: Array<typeof schema.trips.$inferInsert>;
	tripCalendar: Array<typeof schema.tripCalendar.$inferInsert>;
	tripStops: Array<typeof schema.tripStops.$inferInsert>;
	holidays: Array<typeof schema.holidays.$inferInsert>;
	quarantinedTrips: Array<typeof schema.quarantinedTrips.$inferInsert>;
	stats: FoldStats;
}

export interface BuildOptions {
	dataDir?: string;
	outDir?: string;
	dbPath?: string;
	version?: number;
	holidaysPath?: string;
	coordinatesPath?: string;
	cwd?: string;
}

export interface BuildResult {
	dbPath: string;
	timetableVersion: number;
	snapshotsFolded: number;
	durationSecs: number;
	stats: FoldStats;
}
