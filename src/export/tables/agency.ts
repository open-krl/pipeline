// src/export/tables/agency.ts
import { formatCsv } from "../csv";
import type { AgencyRow, GtfsAgencyMeta } from "../types";

export const DEFAULT_AGENCY_META: GtfsAgencyMeta = {
	agency_id: "KCI",
	agency_name: "Kereta Commuter Indonesia",
	agency_url: "https://commuterline.id",
	agency_timezone: "Asia/Jakarta",
	agency_lang: "id",
	agency_phone: "121",
};

export function generateAgencyRows(
	meta: GtfsAgencyMeta = DEFAULT_AGENCY_META,
): AgencyRow[] {
	return [
		{
			agency_id: meta.agency_id,
			agency_name: meta.agency_name,
			agency_url: meta.agency_url,
			agency_timezone: meta.agency_timezone,
			agency_lang: meta.agency_lang,
			agency_phone: meta.agency_phone,
		},
	];
}

export function formatAgencyCsv(rows: AgencyRow[]): string {
	const columns: (keyof AgencyRow)[] = [
		"agency_id",
		"agency_name",
		"agency_url",
		"agency_timezone",
		"agency_lang",
		"agency_phone",
	];
	return formatCsv(columns, rows);
}
