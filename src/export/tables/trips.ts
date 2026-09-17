// src/export/tables/trips.ts
import { formatCsv } from "../csv";
import type { TripRow } from "../types";
import { computeServiceId } from "./calendar";
import { resolveRouteId } from "./routes";

export interface TripEntityWithCalendar {
	trip_id: string;
	line_name: string;
	headsign: string;
	runs_weekday: number;
	runs_saturday: number;
	runs_sunday: number;
	is_fakultatif: number | null;
}

/**
 * Maps trips and calendar presence into GTFS TripRow records.
 */
export function generateTripRows(trips: TripEntityWithCalendar[]): TripRow[] {
	const rows: TripRow[] = trips.map((t) => {
		const isFakultatif = t.is_fakultatif ? 1 : 0;
		const serviceId = computeServiceId(
			t.runs_weekday,
			t.runs_saturday,
			t.runs_sunday,
			isFakultatif,
		);
		const routeId = resolveRouteId(t.line_name);

		return {
			route_id: routeId,
			service_id: serviceId,
			trip_id: t.trip_id,
			trip_headsign: t.headsign,
		};
	});

	rows.sort((a, b) => a.trip_id.localeCompare(b.trip_id));
	return rows;
}

export function formatTripsCsv(rows: TripRow[]): string {
	const columns: (keyof TripRow)[] = [
		"route_id",
		"service_id",
		"trip_id",
		"trip_headsign",
	];
	return formatCsv(columns, rows);
}
