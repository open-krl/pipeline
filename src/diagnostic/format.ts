// src/diagnostic/format.ts
import type { BoardDiff, CatalogDiff, ItineraryDiff } from "./types";

export interface FormatOptions {
	detail?: boolean;
}

/**
 * Formats a catalog diff into a human-readable text block.
 */
export function formatCatalogDiff(
	diff: CatalogDiff,
	_options: FormatOptions = {},
): string {
	const lines: string[] = [`Station Catalog: ${diff.summary}`];

	if (diff.added.length > 0) {
		lines.push(`  Added (${diff.added.length}):`);
		for (const s of diff.added) {
			lines.push(`    + [${s.sta_id}] ${s.sta_name} (group: ${s.group_wil})`);
		}
	}

	if (diff.removed.length > 0) {
		lines.push(`  Removed (${diff.removed.length}):`);
		for (const s of diff.removed) {
			lines.push(`    - [${s.sta_id}] ${s.sta_name}`);
		}
	}

	if (diff.updated.length > 0) {
		lines.push(`  Updated (${diff.updated.length}):`);
		for (const u of diff.updated) {
			const changes: string[] = [];
			if (u.changedFields.includes("sta_name")) {
				changes.push(`name: '${u.before.sta_name}' -> '${u.after.sta_name}'`);
			}
			if (u.changedFields.includes("fg_enable")) {
				changes.push(`enabled: ${u.before.fg_enable} -> ${u.after.fg_enable}`);
			}
			if (u.changedFields.includes("group_wil")) {
				changes.push(
					`group_wil: ${u.before.group_wil} -> ${u.after.group_wil}`,
				);
			}
			lines.push(`    ~ [${u.sta_id}] ${changes.join(", ")}`);
		}
	}

	return lines.join("\n");
}

/**
 * Formats a departure board diff into a human-readable text block.
 */
export function formatBoardDiff(
	diff: BoardDiff,
	options: FormatOptions = {},
): string {
	const lines: string[] = [
		`Departure Boards: ${diff.summary}`,
		`  Trips: ${diff.totalTripsBefore} before -> ${diff.totalTripsAfter} after (${diff.identicalCount} identical)`,
	];

	if (diff.stationCoverage.stationsOnlyInBefore.length > 0) {
		lines.push(
			`  Missing in target capture: ${diff.stationCoverage.stationsOnlyInBefore.join(", ")}`,
		);
	}
	if (diff.stationCoverage.stationsOnlyInAfter.length > 0) {
		lines.push(
			`  New in target capture: ${diff.stationCoverage.stationsOnlyInAfter.join(", ")}`,
		);
	}

	if (diff.relettered.length > 0) {
		lines.push(`  Re-lettered Services (${diff.relettered.length}):`);
		for (const item of diff.relettered) {
			lines.push(`    ~ ${item.details}`);
		}
	}

	if (diff.retimed.length > 0) {
		lines.push(`  Retimed Services (${diff.retimed.length}):`);
		const limit = options.detail ? diff.retimed.length : 10;
		for (let i = 0; i < limit && i < diff.retimed.length; i++) {
			lines.push(`    ~ ${diff.retimed[i].details}`);
		}
		if (!options.detail && diff.retimed.length > limit) {
			lines.push(
				`    ... and ${diff.retimed.length - limit} more (use --detail to view all)`,
			);
		}
	}

	if (diff.added.length > 0) {
		lines.push(`  Added Services (${diff.added.length}):`);
		const limit = options.detail ? diff.added.length : 10;
		for (let i = 0; i < limit && i < diff.added.length; i++) {
			lines.push(`    + ${diff.added[i].details}`);
		}
		if (!options.detail && diff.added.length > limit) {
			lines.push(
				`    ... and ${diff.added.length - limit} more (use --detail to view all)`,
			);
		}
	}

	if (diff.withdrawn.length > 0) {
		lines.push(`  Withdrawn Services (${diff.withdrawn.length}):`);
		const limit = options.detail ? diff.withdrawn.length : 10;
		for (let i = 0; i < limit && i < diff.withdrawn.length; i++) {
			lines.push(`    - ${diff.withdrawn[i].details}`);
		}
		if (!options.detail && diff.withdrawn.length > limit) {
			lines.push(
				`    ... and ${diff.withdrawn.length - limit} more (use --detail to view all)`,
			);
		}
	}

	return lines.join("\n");
}

/**
 * Formats an itinerary diff into a human-readable text block.
 */
export function formatItineraryDiff(
	diff: ItineraryDiff,
	options: FormatOptions = {},
): string {
	const lines: string[] = [
		`Itinerary: ${diff.summary}`,
		`  Total stops: ${diff.stopsCountBefore} before -> ${diff.stopsCountAfter} after`,
	];

	if (
		diff.stops.length > 0 &&
		(options.detail ||
			diff.retimedCount > 0 ||
			diff.addedCount > 0 ||
			diff.removedCount > 0)
	) {
		lines.push("  Stop Details:");
		for (const stop of diff.stops) {
			if (stop.status === "unchanged" && !options.detail) continue;

			if (stop.status === "unchanged") {
				lines.push(
					`    = [${stop.stationId}] ${stop.stationName} (${stop.timeAfter})`,
				);
			} else if (stop.status === "retimed") {
				const sign = stop.deltaSecs >= 0 ? "+" : "";
				const mins = Math.round(stop.deltaSecs / 60);
				lines.push(
					`    ~ [${stop.stationId}] ${stop.stationName}: ${stop.timeBefore} -> ${stop.timeAfter} (${sign}${mins}m / ${sign}${stop.deltaSecs}s)`,
				);
			} else if (stop.status === "added") {
				lines.push(
					`    + [${stop.stationId}] ${stop.stationName} (${stop.timeAfter})`,
				);
			} else if (stop.status === "removed") {
				lines.push(
					`    - [${stop.stationId}] ${stop.stationName} (was ${stop.timeBefore})`,
				);
			}
		}
	}

	return lines.join("\n");
}
