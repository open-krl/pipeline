// src/diagnostic/catalog.ts
import type { StationItem } from "../api/schemas";
import type { CatalogDiff, CatalogUpdatedStation } from "./types";

/**
 * Computes a semantic diff between two station catalogs (§8.1 Gate 1).
 * Identifies added, removed, and attribute-updated stations.
 */
export function diffStationCatalogs(
	beforeStations: readonly StationItem[],
	afterStations: readonly StationItem[],
): CatalogDiff {
	const beforeMap = new Map<string, StationItem>();
	for (const s of beforeStations) {
		beforeMap.set(s.sta_id, s);
	}

	const afterMap = new Map<string, StationItem>();
	for (const s of afterStations) {
		afterMap.set(s.sta_id, s);
	}

	const added: StationItem[] = [];
	const removed: StationItem[] = [];
	const updated: CatalogUpdatedStation[] = [];
	let identicalCount = 0;

	// Find added and updated
	for (const [staId, after] of afterMap.entries()) {
		const before = beforeMap.get(staId);
		if (!before) {
			added.push(after);
			continue;
		}

		const changedFields: Array<"sta_name" | "group_wil" | "fg_enable"> = [];
		if (before.sta_name !== after.sta_name) {
			changedFields.push("sta_name");
		}
		if (before.group_wil !== after.group_wil) {
			changedFields.push("group_wil");
		}
		if (before.fg_enable !== after.fg_enable) {
			changedFields.push("fg_enable");
		}

		if (changedFields.length > 0) {
			updated.push({
				sta_id: staId,
				before,
				after,
				changedFields,
			});
		} else {
			identicalCount++;
		}
	}

	// Find removed
	for (const [staId, before] of beforeMap.entries()) {
		if (!afterMap.has(staId)) {
			removed.push(before);
		}
	}

	// Sort results by sta_id for determinism
	added.sort((a, b) => a.sta_id.localeCompare(b.sta_id));
	removed.sort((a, b) => a.sta_id.localeCompare(b.sta_id));
	updated.sort((a, b) => a.sta_id.localeCompare(b.sta_id));

	const totalChanges = added.length + removed.length + updated.length;
	let summary: string;
	if (totalChanges === 0) {
		summary = `Station catalog: identical (${identicalCount} stations)`;
	} else {
		const parts: string[] = [];
		if (added.length > 0) parts.push(`${added.length} added`);
		if (removed.length > 0) parts.push(`${removed.length} removed`);
		if (updated.length > 0) parts.push(`${updated.length} updated`);
		summary = `Station catalog: ${parts.join(", ")} (${identicalCount} unchanged)`;
	}

	return {
		added,
		removed,
		updated,
		identicalCount,
		summary,
	};
}
