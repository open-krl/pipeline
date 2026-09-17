// src/diagnostic/format.ts
import type {
	BoardDiff,
	CalendarAnalysisResult,
	CatalogDiff,
	DetectResult,
	ItineraryDiff,
} from "./types";

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

/**
 * Formats a terminal-friendly calendar identity and set-difference report.
 */
export function formatCalendarReport(
	result: CalendarAnalysisResult,
	detail = false,
): string {
	const { availableDayTypes, totalTripsByDayType, breakdown, stats } = result;

	const dayTypesStr: string[] = [];
	if (availableDayTypes.weekday) dayTypesStr.push("Weekday");
	if (availableDayTypes.saturday) dayTypesStr.push("Saturday");
	if (availableDayTypes.sunday) dayTypesStr.push("Sunday");

	const resolutionStatus =
		dayTypesStr.length === 3
			? "Resolved (3/3 day types confirmed)"
			: `Provisional (${dayTypesStr.length}/3 day types: ${dayTypesStr.join(", ") || "none"})`;

	const formatPct = (count: number) =>
		result.totalServices > 0
			? `${((count / result.totalServices) * 100).toFixed(1)}%`
			: "0.0%";

	const lines: string[] = [];
	lines.push("── Calendar Schedule Identity Report ────────────────────────");
	lines.push(
		`Timetable Version:    ${result.timetableVersion} (source: ${result.source})`,
	);
	lines.push(`Calendar Resolution:  ${resolutionStatus}`);
	lines.push(
		`Total Unique Services:${result.totalServices.toLocaleString()} distinct operational runs`,
	);
	lines.push(
		`Weekday Departures:   ${availableDayTypes.weekday ? `${totalTripsByDayType.weekday.toLocaleString()} trips` : "N/A"}`,
	);
	lines.push(
		`Saturday Departures:  ${availableDayTypes.saturday ? `${totalTripsByDayType.saturday.toLocaleString()} trips` : "N/A"}`,
	);
	lines.push(
		`Sunday Departures:    ${availableDayTypes.sunday ? `${totalTripsByDayType.sunday.toLocaleString()} trips` : "N/A"}`,
	);
	lines.push("");

	lines.push("── 3-Way Set Difference Breakdown ───────────────────────────");
	lines.push(
		`  Daily (All 7 Days):     ${String(breakdown.daily.length).padStart(5, " ")} services (${formatPct(breakdown.daily.length).padStart(5, " ")})`,
	);
	lines.push(
		`  Weekday Only:           ${String(breakdown.weekdayOnly.length).padStart(5, " ")} services (${formatPct(breakdown.weekdayOnly.length).padStart(5, " ")})`,
	);
	lines.push(
		`  Weekend Only (Sat+Sun): ${String(breakdown.weekendOnly.length).padStart(5, " ")} services (${formatPct(breakdown.weekendOnly.length).padStart(5, " ")})`,
	);
	lines.push(
		`  Mon - Sat:              ${String(breakdown.monSat.length).padStart(5, " ")} services (${formatPct(breakdown.monSat.length).padStart(5, " ")})`,
	);
	lines.push(
		`  Saturday Only:          ${String(breakdown.saturdayOnly.length).padStart(5, " ")} services (${formatPct(breakdown.saturdayOnly.length).padStart(5, " ")})`,
	);
	lines.push(
		`  Sunday Only:            ${String(breakdown.sundayOnly.length).padStart(5, " ")} services (${formatPct(breakdown.sundayOnly.length).padStart(5, " ")})`,
	);
	lines.push(
		`  Weekday + Sunday:       ${String(breakdown.weekdaySunday.length).padStart(5, " ")} services (${formatPct(breakdown.weekdaySunday.length).padStart(5, " ")})`,
	);
	lines.push("");

	lines.push("── Operational Variance Diagnostics ─────────────────────────");
	lines.push(
		`  Re-lettered on Weekend: ${stats.reletteredCount} services (e.g. 5022D -> 5022E)`,
	);
	lines.push(
		`  Retimed on Weekend:     ${stats.retimedCount} services (arrival delta within tolerance)`,
	);
	lines.push(
		`  Fakultatif Services:    ${stats.fakultatif.total} total (${stats.fakultatif.weekdayActive} weekday active, ${stats.fakultatif.weekendActive} weekend active, ${stats.fakultatif.suspendedOnWeekend} suspended on weekend)`,
	);
	lines.push("─────────────────────────────────────────────────────────────");

	if (detail) {
		// Group by commercial line name
		const linesMap = new Map<
			string,
			{
				daily: number;
				weekdayOnly: number;
				weekendOnly: number;
				other: number;
				total: number;
			}
		>();

		const allClusters = [
			...breakdown.daily,
			...breakdown.weekdayOnly,
			...breakdown.weekendOnly,
			...breakdown.monSat,
			...breakdown.saturdayOnly,
			...breakdown.sundayOnly,
			...breakdown.weekdaySunday,
		];

		for (const c of allClusters) {
			const key = c.lineName || "Unassigned";
			let entry = linesMap.get(key);
			if (!entry) {
				entry = {
					daily: 0,
					weekdayOnly: 0,
					weekendOnly: 0,
					other: 0,
					total: 0,
				};
				linesMap.set(key, entry);
			}
			entry.total++;
			if (c.category === "daily") entry.daily++;
			else if (c.category === "weekday_only") entry.weekdayOnly++;
			else if (c.category === "weekend_only") entry.weekendOnly++;
			else entry.other++;
		}

		lines.push(
			"\n── Line-by-Line Service Distribution ───────────────────────",
		);
		lines.push(
			`${"Line Name".padEnd(30, " ")} ${"Daily".padStart(6, " ")} ${"Wkday".padStart(6, " ")} ${"Wkend".padStart(6, " ")} ${"Other".padStart(6, " ")} ${"Total".padStart(6, " ")}`,
		);
		lines.push("─".repeat(61));
		for (const [name, counts] of Array.from(linesMap.entries()).sort(
			(a, b) => b[1].total - a[1].total,
		)) {
			lines.push(
				`${name.slice(0, 30).padEnd(30, " ")} ${String(counts.daily).padStart(6, " ")} ${String(counts.weekdayOnly).padStart(6, " ")} ${String(counts.weekendOnly).padStart(6, " ")} ${String(counts.other).padStart(6, " ")} ${String(counts.total).padStart(6, " ")}`,
			);
		}

		// List re-lettered samples
		const reletteredClusters = allClusters.filter((c) => c.relettered);
		if (reletteredClusters.length > 0) {
			lines.push(
				"\n── Re-lettered Weekend Services (Sample) ───────────────────",
			);
			for (const c of reletteredClusters.slice(0, 8)) {
				lines.push(
					`  • ${c.trainIds.join(" -> ")}: ${c.originStation} -> ${c.destStation} (${c.lineName})`,
				);
			}
			if (reletteredClusters.length > 8) {
				lines.push(`  ... and ${reletteredClusters.length - 8} more`);
			}
		}

		// List retimed samples
		const retimedClusters = allClusters.filter((c) => c.retimed);
		if (retimedClusters.length > 0) {
			lines.push(
				"\n── Retimed Services Across Day Types (Sample) ───────────────",
			);
			for (const c of retimedClusters.slice(0, 8)) {
				lines.push(
					`  • ${c.trainIds.join(", ")} (${c.destStation}): max delta ±${c.maxDeltaSecs}s`,
				);
			}
			if (retimedClusters.length > 8) {
				lines.push(`  ... and ${retimedClusters.length - 8} more`);
			}
		}
	}

	return lines.join("\n");
}

/**
 * Pretty-prints a clean terminal report for corridor drift detection.
 */
export function formatDetectReport(result: DetectResult): string {
	const lines: string[] = [];
	lines.push("── Operational Corridor Drift Probe (§9, §12) ──────────────");
	lines.push(`Probe Timestamp:      ${result.probeTimeWib}`);
	lines.push(
		`Timetable Version:    ${result.timetableVersion} (baseline source: ${result.baselineSource})`,
	);
	lines.push(`Target Day Type:      ${result.dayType} (${result.dateStr})`);
	lines.push(
		`Corridor Signature:   ${result.stations.length} hub stations (${result.stations.map((s) => s.stationId).join(", ")})`,
	);
	lines.push("");

	lines.push("── Station Departure Results ────────────────────────────────");
	for (const s of result.stations) {
		const idTag = `[${s.stationId}]`.padEnd(5, " ");
		const name = s.stationName.slice(0, 20).padEnd(20, " ");
		const counts = `${String(s.expectedCount).padStart(3, " ")} exp, ${String(s.liveCount).padStart(3, " ")} live`;
		const diffs = `(${String(s.identicalCount).padStart(3, " ")} id, ${s.reletteredCount} re-let, ${s.retimedCount} retimed, ${s.addedCount} add, ${s.withdrawnCount} del)`;
		lines.push(`  ${idTag} ${name} : ${counts} ${diffs}`);
	}
	lines.push("");

	lines.push("── Overall Corridor Status ──────────────────────────────────");
	const statusEmoji =
		result.status === "STABLE"
			? "STABLE (Congruent) ✅"
			: result.status === "OPERATIONAL_VARIANCE"
				? "OPERATIONAL VARIANCE (Minor Drift) ℹ️"
				: "POTENTIAL TIMETABLE EDITION DRIFT ⚠️";
	lines.push(`Status:               ${statusEmoji}`);
	lines.push(
		`Congruent Departures: ${result.totalIdentical} / ${result.totalExpected} (${result.totalExpected > 0 ? ((result.totalIdentical / result.totalExpected) * 100).toFixed(1) : 0}%)`,
	);
	lines.push(`Re-lettered Services: ${result.totalRelettered}`);
	lines.push(`Retimed Services:     ${result.totalRetimed}`);
	lines.push(`Unexpected Added:     ${result.totalAdded}`);
	lines.push(`Missing / Cancelled:  ${result.totalWithdrawn}`);

	if (result.actionRecommendation) {
		lines.push("");
		lines.push(`Action Recommended:   ${result.actionRecommendation}`);
	}
	lines.push("─────────────────────────────────────────────────────────────");

	return lines.join("\n");
}
