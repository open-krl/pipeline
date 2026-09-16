// src/core/route.ts

export interface ParsedRoute {
	origin_token: string;
	dest_token: string;
	via_token: string | null;
}

/**
 * Parses raw concatenated route names (e.g. "KAMPUNGBANDAN-CIKARANG VIA PSE")
 * into origin, terminus, and optional via routing variant tokens (§4.3).
 */
export function parseRouteName(routeNameRaw: string): ParsedRoute {
	const trimmed = routeNameRaw.trim();
	const viaSplit = trimmed.split(/\s+VIA\s+/i);

	const mainRoute = viaSplit[0].trim();
	const via_token = viaSplit.length > 1 ? viaSplit[1].trim() : null;

	const dashIdx = mainRoute.indexOf("-");
	if (dashIdx === -1) {
		return {
			origin_token: mainRoute,
			dest_token: mainRoute,
			via_token,
		};
	}

	const origin_token = mainRoute.slice(0, dashIdx).trim();
	const dest_token = mainRoute.slice(dashIdx + 1).trim();

	return {
		origin_token,
		dest_token,
		via_token,
	};
}

/**
 * Resolves a station code from a station catalog using whitespace-insensitive matching (§4.3).
 */
export function resolveStationId(
	token: string,
	stationsCatalog: ReadonlyArray<{ sta_id: string; sta_name: string }>,
): string | null {
	const normalizedToken = token.replace(/\s+/g, "").toUpperCase();

	// Check by normalized station name
	const byName = stationsCatalog.find(
		(s) => s.sta_name.replace(/\s+/g, "").toUpperCase() === normalizedToken,
	);
	if (byName) {
		return byName.sta_id;
	}

	// Check by direct station ID (e.g. if code was passed)
	const byId = stationsCatalog.find(
		(s) => s.sta_id.toUpperCase() === normalizedToken,
	);
	if (byId) {
		return byId.sta_id;
	}

	return null;
}
