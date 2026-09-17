// src/export/tables/calendar-dates.ts
import { getDayOfWeekWib } from "../../core/calendar";
import { formatCsv } from "../csv";
import type { CalendarDateRow } from "../types";

export interface HolidayEntity {
	holiday_date: string; // YYYY-MM-DD
	name: string;
	is_collective_leave: number;
}

/**
 * Generates calendar_dates.txt rows (§4.5):
 * Emits exception_type = 2 (service removed) on mid-week statutory holidays (Mon-Fri)
 * for fakultatif service profiles. Weekend holidays emit no exception since they are
 * already inactive in calendar.txt.
 */
export function generateCalendarDateRows(
	fakultatifServiceIds: Iterable<string>,
	holidays: HolidayEntity[],
	startDate: string, // YYYYMMDD
	endDate: string, // YYYYMMDD
): CalendarDateRow[] {
	const rows: CalendarDateRow[] = [];
	const startYmd = `${startDate.slice(0, 4)}-${startDate.slice(4, 6)}-${startDate.slice(6, 8)}`;
	const endYmd = `${endDate.slice(0, 4)}-${endDate.slice(4, 6)}-${endDate.slice(6, 8)}`;

	const serviceIdList = Array.from(fakultatifServiceIds).sort();
	if (serviceIdList.length === 0) {
		return [];
	}

	for (const h of holidays) {
		// Only statutory holidays trigger cancellations (cuti bersama is inert)
		if (h.is_collective_leave === 1) {
			continue;
		}

		if (h.holiday_date < startYmd || h.holiday_date > endYmd) {
			continue;
		}

		// Parse holiday date as midday UTC to safely evaluate WIB day of week
		const dateObj = new Date(`${h.holiday_date}T12:00:00Z`);
		const dow = getDayOfWeekWib(dateObj);

		// Mid-week holiday: Monday (1) through Friday (5)
		if (dow >= 1 && dow <= 5) {
			const gtfsDate = h.holiday_date.replaceAll("-", "");
			for (const serviceId of serviceIdList) {
				rows.push({
					service_id: serviceId,
					date: gtfsDate,
					exception_type: 2, // Service removed
				});
			}
		}
	}

	rows.sort((a, b) => {
		const cmp = a.date.localeCompare(b.date);
		return cmp !== 0 ? cmp : a.service_id.localeCompare(b.service_id);
	});

	return rows;
}

export function formatCalendarDatesCsv(rows: CalendarDateRow[]): string {
	const columns: (keyof CalendarDateRow)[] = [
		"service_id",
		"date",
		"exception_type",
	];
	return formatCsv(columns, rows);
}
