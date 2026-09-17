// src/export/tables/calendar.ts
import { formatCsv } from "../csv";
import type { CalendarRow } from "../types";

export interface ServiceSignature {
	service_id: string;
	runs_weekday: number;
	runs_saturday: number;
	runs_sunday: number;
	is_fakultatif: number;
}

/**
 * Derives a deterministic service ID from the operational signature.
 */
export function computeServiceId(
	runsWeekday: number,
	runsSaturday: number,
	runsSunday: number,
	isFakultatif: number,
): string {
	let pattern: string;
	if (runsWeekday && runsSaturday && runsSunday) {
		pattern = "DAILY";
	} else if (runsWeekday && !runsSaturday && !runsSunday) {
		pattern = "WD";
	} else if (runsWeekday && runsSaturday && !runsSunday) {
		pattern = "MON_SAT";
	} else if (!runsWeekday && runsSaturday && runsSunday) {
		pattern = "WEEKEND";
	} else {
		const days: string[] = [];
		if (runsWeekday) days.push("WD");
		if (runsSaturday) days.push("SAT");
		if (runsSunday) days.push("SUN");
		pattern = days.join("_") || "INERT";
	}

	const suffix = isFakultatif ? "FAK" : "REG";
	return `SVC_${pattern}_${suffix}`;
}

/**
 * Generates calendar.txt rows for recurring weekly schedules (§4.5).
 */
export function generateCalendarRows(
	signatures: ServiceSignature[],
	startDate: string, // YYYYMMDD
	endDate: string, // YYYYMMDD
): CalendarRow[] {
	const seen = new Set<string>();
	const rows: CalendarRow[] = [];

	for (const sig of signatures) {
		if (seen.has(sig.service_id)) continue;
		seen.add(sig.service_id);

		rows.push({
			service_id: sig.service_id,
			monday: sig.runs_weekday,
			tuesday: sig.runs_weekday,
			wednesday: sig.runs_weekday,
			thursday: sig.runs_weekday,
			friday: sig.runs_weekday,
			saturday: sig.runs_saturday,
			sunday: sig.runs_sunday,
			start_date: startDate,
			end_date: endDate,
		});
	}

	rows.sort((a, b) => a.service_id.localeCompare(b.service_id));
	return rows;
}

export function formatCalendarCsv(rows: CalendarRow[]): string {
	const columns: (keyof CalendarRow)[] = [
		"service_id",
		"monday",
		"tuesday",
		"wednesday",
		"thursday",
		"friday",
		"saturday",
		"sunday",
		"start_date",
		"end_date",
	];
	return formatCsv(columns, rows);
}
