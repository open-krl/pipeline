// src/export/tables/stops.ts
import { formatCsv } from "../csv";
import type { StopRow } from "../types";

export interface StationEntity {
	sta_id: string;
	sta_name: string;
	lat: number | null;
	lon: number | null;
}

/**
 * Maps database stations into GTFS StopRow records.
 * Strictly asserts that every station actively referenced in trip_stops has valid coordinates.
 */
export function generateStopRows(
	allStations: StationEntity[],
	activeStationIds: Set<string>,
): StopRow[] {
	const missingCoords: string[] = [];

	for (const staId of activeStationIds) {
		const st = allStations.find((s) => s.sta_id === staId);
		if (!st || st.lat === null || st.lon === null) {
			missingCoords.push(staId);
		}
	}

	if (missingCoords.length > 0) {
		throw new Error(
			`GTFS export failed: active stations missing WGS-84 coordinates in database: ${missingCoords.join(", ")}. Check data/station_coordinates.csv and rebuild.`,
		);
	}

	// Export all active stations (and any other catalog stations that possess valid coordinates)
	const rows: StopRow[] = [];
	for (const s of allStations) {
		if (activeStationIds.has(s.sta_id) || (s.lat !== null && s.lon !== null)) {
			if (s.lat !== null && s.lon !== null) {
				rows.push({
					stop_id: s.sta_id,
					stop_name: s.sta_name,
					stop_lat: s.lat,
					stop_lon: s.lon,
					location_type: 0,
				});
			}
		}
	}

	rows.sort((a, b) => a.stop_id.localeCompare(b.stop_id));
	return rows;
}

export function formatStopsCsv(rows: StopRow[]): string {
	const columns: (keyof StopRow)[] = [
		"stop_id",
		"stop_name",
		"stop_lat",
		"stop_lon",
		"location_type",
	];
	return formatCsv(columns, rows);
}
