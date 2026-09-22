// src/export/tables/stop-times.ts
import { secsToDisplay } from "@/core/time";
import { formatCsv } from "../csv";
import type { StopTimeRow } from "../types";

export interface TripStopEntity {
	trip_id: string;
	stop_sequence: number;
	station_id: string;
	arrival_secs: number | null;
	departure_secs: number | null;
}

/**
 * Maps database trip_stops into GTFS StopTimeRow records (§4.6).
 * Continuous service-day seconds are stringified via secsToDisplay (supporting 24:XX:XX).
 */
export function generateStopTimeRows(stops: TripStopEntity[]): StopTimeRow[] {
	const rows: StopTimeRow[] = stops.map((st) => {
		const isOrigin = st.arrival_secs === null;
		const isTerminus = st.departure_secs === null;

		let arrSecs = st.arrival_secs;
		let depSecs = st.departure_secs;

		// GTFS requires valid timestamps on all rows:
		// At origin: arrival_time = departure_time
		// At terminus: departure_time = arrival_time
		if (isOrigin && depSecs !== null) {
			arrSecs = depSecs;
		}
		if (isTerminus && arrSecs !== null) {
			depSecs = arrSecs;
		}

		if (arrSecs === null || depSecs === null) {
			throw new Error(
				`Trip stop ${st.trip_id} seq ${st.stop_sequence} has unresolvable timestamps (arr: ${st.arrival_secs}, dep: ${st.departure_secs})`,
			);
		}

		return {
			trip_id: st.trip_id,
			arrival_time: secsToDisplay(arrSecs),
			departure_time: secsToDisplay(depSecs),
			stop_id: st.station_id,
			stop_sequence: st.stop_sequence,
			pickup_type: isTerminus ? 1 : 0, // No pickup at destination
			drop_off_type: isOrigin ? 1 : 0, // No drop-off at departure origin
		};
	});

	rows.sort((a, b) => {
		const cmp = a.trip_id.localeCompare(b.trip_id);
		return cmp !== 0 ? cmp : a.stop_sequence - b.stop_sequence;
	});

	return rows;
}

export function formatStopTimesCsv(rows: StopTimeRow[]): string {
	const columns: (keyof StopTimeRow)[] = [
		"trip_id",
		"arrival_time",
		"departure_time",
		"stop_id",
		"stop_sequence",
		"pickup_type",
		"drop_off_type",
	];
	return formatCsv(columns, rows);
}
