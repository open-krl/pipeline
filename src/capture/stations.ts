import type { StationItem } from "../api/schemas";
import { REGION_GROUPS, type RegionScope } from "../config";

/**
 * Filters the station list to operational passenger stops in the active region.
 */
export function filterOperationalStations(
	stations: readonly StationItem[],
	regionScope: RegionScope,
): StationItem[] {
	const allowedGroups = REGION_GROUPS[regionScope];
	const operational = stations.filter((s) => {
		if (s.sta_id.startsWith("WIL")) return false;
		if (!allowedGroups.includes(s.group_wil)) return false;
		return s.fg_enable === 1;
	});

	if (operational.length === 0) {
		throw new Error(
			`No operational stations found for region scope '${regionScope}'.`,
		);
	}

	return operational;
}
