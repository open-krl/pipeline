// src/export/tables/routes.ts
import { formatCsv } from "../csv";
import type { RouteRow } from "../types";

export interface CanonicalRouteDef {
	routeId: string;
	shortName: string;
	longName: string;
	color: string;
	textColor: string;
}

export const CANONICAL_ROUTES: Record<string, CanonicalRouteDef> = {
	"COMMUTER LINE BOGOR": {
		routeId: "BOGOR",
		shortName: "B",
		longName: "Commuter Line Bogor",
		color: "E30A16",
		textColor: "FFFFFF",
	},
	"COMMUTER LINE CIKARANG": {
		routeId: "CIKARANG",
		shortName: "C",
		longName: "Commuter Line Cikarang",
		color: "0084D8",
		textColor: "FFFFFF",
	},
	"COMMUTER LINE RANGKASBITUNG": {
		routeId: "RANGKASBITUNG",
		shortName: "R",
		longName: "Commuter Line Rangkasbitung",
		color: "16812B",
		textColor: "FFFFFF",
	},
	"COMMUTER LINE TANGERANG": {
		routeId: "TANGERANG",
		shortName: "T",
		longName: "Commuter Line Tangerang",
		color: "623814",
		textColor: "FFFFFF",
	},
	"COMMUTER LINE TANJUNGPRIUK": {
		routeId: "TANJUNGPRIUK",
		shortName: "TP",
		longName: "Commuter Line Tanjung Priok",
		color: "DD0067",
		textColor: "FFFFFF",
	},
	"COMMUTERLINE MERAK": {
		routeId: "MERAK",
		shortName: "LM",
		longName: "Commuter Line Merak",
		color: "16812B",
		textColor: "FFFFFF",
	},
	"COMMUTER LINE BANDARA SOEKARNO-HATTA": {
		routeId: "BANDARA",
		shortName: "A",
		longName: "Commuter Line Bandara Soekarno-Hatta",
		color: "2D328A",
		textColor: "FFFFFF",
	},
};

/**
 * Resolves the canonical route ID for a commercial line name.
 */
export function resolveRouteId(lineName: string): string {
	const upper = lineName.trim().toUpperCase();
	if (CANONICAL_ROUTES[upper]) {
		return CANONICAL_ROUTES[upper].routeId;
	}
	// Fallback heuristic: strip prefix and normalize
	const cleaned = upper
		.replace(/^COMMUTER\s*LINE\s*/, "")
		.replace(/^COMMUTERLINE\s*/, "")
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return cleaned || "KRL";
}

/**
 * Strips '#' and enforces a 6-digit hex color string.
 */
export function cleanHexColor(color: string, fallback = "000000"): string {
	const cleaned = color.replace(/^#/, "").trim().toUpperCase();
	if (/^[0-9A-F]{6}$/.test(cleaned)) {
		return cleaned;
	}
	return fallback;
}

/**
 * Aggregates unique commercial routes from active trips.
 */
export function generateRouteRows(
	trips: Array<{ line_name: string; color: string }>,
	agencyId = "KCI",
): RouteRow[] {
	const routeMap = new Map<string, RouteRow>();

	for (const trip of trips) {
		const upper = trip.line_name.trim().toUpperCase();
		const routeId = resolveRouteId(upper);

		if (!routeMap.has(routeId)) {
			const canonical = CANONICAL_ROUTES[upper];
			if (canonical) {
				routeMap.set(routeId, {
					route_id: canonical.routeId,
					agency_id: agencyId,
					route_short_name: canonical.shortName,
					route_long_name: canonical.longName,
					route_type: 2, // Rail
					route_color: canonical.color,
					route_text_color: canonical.textColor,
				});
			} else {
				routeMap.set(routeId, {
					route_id: routeId,
					agency_id: agencyId,
					route_short_name: routeId.slice(0, 3),
					route_long_name: trip.line_name.trim(),
					route_type: 2,
					route_color: cleanHexColor(trip.color, "0084D8"),
					route_text_color: "FFFFFF",
				});
			}
		}
	}

	const routes = Array.from(routeMap.values());
	routes.sort((a, b) => a.route_id.localeCompare(b.route_id));
	return routes;
}

export function formatRoutesCsv(rows: RouteRow[]): string {
	const columns: (keyof RouteRow)[] = [
		"route_id",
		"agency_id",
		"route_short_name",
		"route_long_name",
		"route_type",
		"route_color",
		"route_text_color",
	];
	return formatCsv(columns, rows);
}
