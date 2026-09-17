// src/diagnostic/cli-diff.ts

import { itinerariesDir } from "../archive/layout";
import { DayTypeSchema } from "../archive/schemas";
import { scanSnapshots, scanTimetableVersions } from "../archive/snapshots";
import { getItineraryPath, readItineraryEnvelope } from "../census/envelope";
import { resolveSafePath } from "../core/path";
import {
	formatBoardDiff,
	formatCatalogDiff,
	formatItineraryDiff,
} from "./format";
import { diffItineraries } from "./itinerary";
import { diffSnapshots, type SnapshotRef } from "./snapshot";

export interface DiffCommandOptions {
	dataDir?: string;
	v1?: number | string;
	v2?: number | string;
	train?: string | string[];
	dayType?: string;
	detail?: boolean;
}

/**
 * Parses a snapshot reference token such as "1:3" or "3".
 */
export function parseSnapshotRef(
	token: string,
	fallbackVersion: number,
): SnapshotRef {
	const trimmed = token.trim();
	if (trimmed.includes(":")) {
		const parts = trimmed.split(":");
		if (parts.length !== 2) {
			throw new Error(
				`Invalid snapshot reference '${token}'. Expected format '<version>:<snapshot_id>' (e.g. 1:3).`,
			);
		}
		const [vStr, sStr] = parts;
		if (!/^\d+$/.test(vStr) || !/^\d+$/.test(sStr)) {
			throw new Error(
				`Invalid snapshot reference '${token}'. Expected format '<version>:<snapshot_id>' (e.g. 1:3).`,
			);
		}
		const v = Number.parseInt(vStr, 10);
		const s = Number.parseInt(sStr, 10);
		if (v <= 0 || s <= 0) {
			throw new Error(
				`Invalid snapshot reference '${token}'. Expected format '<version>:<snapshot_id>' (e.g. 1:3).`,
			);
		}
		return { version: v, snapshotId: s };
	}

	if (!/^\d+$/.test(trimmed)) {
		throw new Error(
			`Invalid snapshot ID '${token}'. Expected a positive integer or '<version>:<snapshot_id>'.`,
		);
	}
	const s = Number.parseInt(trimmed, 10);
	if (s <= 0) {
		throw new Error(
			`Invalid snapshot ID '${token}'. Expected a positive integer or '<version>:<snapshot_id>'.`,
		);
	}
	return { version: fallbackVersion, snapshotId: s };
}

/**
 * Resolves the latest complete snapshot in a given timetable version.
 */
async function resolveLatestCompleteSnapshot(
	dataDir: string,
	version: number,
): Promise<number | null> {
	const snapshots = await scanSnapshots(dataDir, version);
	const complete = snapshots.filter((s) => s.manifest.status === "complete");
	if (complete.length === 0) return null;
	return complete[complete.length - 1].id;
}

/**
 * Executes the `krl diff` CLI command (§8.1, §9).
 */
export async function executeDiff(
	args: string[],
	options: DiffCommandOptions,
): Promise<void> {
	const dataDir = resolveSafePath(options.dataDir ?? "data/raw");
	const detail = Boolean(options.detail);

	// Case 1: Train Itinerary Envelope Diff
	if (options.train) {
		const trainArgs = [options.train, ...args]
			.flat()
			.flatMap((t) => String(t).split(/[\s,]+/))
			.filter(Boolean);

		const versions = await scanTimetableVersions(dataDir);
		const activeVersion =
			versions.length > 0 ? versions[versions.length - 1] : 1;
		const targetVersion = options.v1
			? Number.parseInt(String(options.v1), 10)
			: activeVersion;
		if (options.dayType !== undefined) {
			const parsedDayType = DayTypeSchema.safeParse(options.dayType);
			if (!parsedDayType.success) {
				throw new Error(
					`Invalid day type '${options.dayType}'. Must be weekday, saturday, sunday, or holiday.`,
				);
			}
		}
		const targetDayType = options.dayType ?? "weekday";
		const iDir = itinerariesDir(dataDir, targetVersion);

		if (trainArgs.length >= 2) {
			const trainA = trainArgs[0];
			const trainB = trainArgs[1];

			const pathA = getItineraryPath(iDir, trainA);
			const pathB = getItineraryPath(iDir, trainB);

			const envA = await readItineraryEnvelope(pathA);
			const envB = await readItineraryEnvelope(pathB);

			if (!envA)
				throw new Error(
					`Itinerary envelope not found for train ${trainA} at ${pathA}`,
				);
			if (!envB)
				throw new Error(
					`Itinerary envelope not found for train ${trainB} at ${pathB}`,
				);

			const obsA =
				envA.observations[targetDayType as keyof typeof envA.observations];
			const obsB =
				envB.observations[targetDayType as keyof typeof envB.observations];

			if (!obsA || obsA.stops.length === 0) {
				throw new Error(
					`Train ${trainA} has no observations for day type '${targetDayType}'`,
				);
			}
			if (!obsB || obsB.stops.length === 0) {
				throw new Error(
					`Train ${trainB} has no observations for day type '${targetDayType}'`,
				);
			}

			const diff = diffItineraries(trainA, obsA.stops, trainB, obsB.stops);
			console.log(
				`\n=============================================================`,
			);
			console.log(
				`Train Itinerary Diff: v${targetVersion} ${trainA} vs ${trainB} (${targetDayType})`,
			);
			console.log(
				`=============================================================`,
			);
			console.log(formatItineraryDiff(diff, { detail }));
			console.log(
				`=============================================================\n`,
			);
			return;
		}

		if (trainArgs.length === 1) {
			const trainId = trainArgs[0];
			const pathA = getItineraryPath(iDir, trainId);
			const env = await readItineraryEnvelope(pathA);
			if (!env)
				throw new Error(
					`Itinerary envelope not found for train ${trainId} at ${pathA}`,
				);

			const availableDayTypes = Object.keys(env.observations);
			if (availableDayTypes.length < 2) {
				console.log(
					`Train ${trainId} only has observations for [${availableDayTypes.join(", ")}]. At least 2 day types needed to diff.`,
				);
				return;
			}

			const dt1 = availableDayTypes[0];
			const dt2 = availableDayTypes[1];
			const stops1 =
				env.observations[dt1 as keyof typeof env.observations]?.stops ?? [];
			const stops2 =
				env.observations[dt2 as keyof typeof env.observations]?.stops ?? [];

			const diff = diffItineraries(trainId, stops1, trainId, stops2);
			console.log(
				`\n=============================================================`,
			);
			console.log(`Train Itinerary Diff: ${trainId} (${dt1} vs ${dt2})`);
			console.log(
				`=============================================================`,
			);
			console.log(formatItineraryDiff(diff, { detail }));
			console.log(
				`=============================================================\n`,
			);
			return;
		}
	}

	// Case 2: Snapshot Diffing
	const versions = await scanTimetableVersions(dataDir);
	const activeVersion = versions.length > 0 ? versions[versions.length - 1] : 1;

	let beforeRef: SnapshotRef | null = null;
	let afterRef: SnapshotRef | null = null;

	if (args.length >= 2) {
		beforeRef = parseSnapshotRef(args[0], activeVersion);
		afterRef = parseSnapshotRef(args[1], activeVersion);
	} else if (args.length === 1) {
		throw new Error(
			`Expected two snapshot references (e.g. krl diff 1:1 1:3), but only received '${args[0]}'.`,
		);
	} else if (options.v1 && options.v2) {
		const v1Num = Number.parseInt(String(options.v1), 10);
		const v2Num = Number.parseInt(String(options.v2), 10);
		const snap1 = await resolveLatestCompleteSnapshot(dataDir, v1Num);
		const snap2 = await resolveLatestCompleteSnapshot(dataDir, v2Num);

		if (!snap1)
			throw new Error(
				`No complete snapshot found for timetable version ${v1Num}`,
			);
		if (!snap2)
			throw new Error(
				`No complete snapshot found for timetable version ${v2Num}`,
			);

		beforeRef = { version: v1Num, snapshotId: snap1 };
		afterRef = { version: v2Num, snapshotId: snap2 };
	} else {
		// Default: find last two snapshots in active version
		const snapshots = await scanSnapshots(dataDir, activeVersion);
		if (snapshots.length < 2) {
			console.log(
				`Need at least two snapshots to diff. Available in version ${activeVersion}: ${snapshots.length} snapshot(s).`,
			);
			console.log(`Usage:`);
			console.log(
				`  krl diff 1:1 1:3             # Compare snapshot 1 with snapshot 3 in version 1`,
			);
			console.log(
				`  krl diff --v1 1 --v2 2       # Compare latest complete snapshots across versions`,
			);
			console.log(
				`  krl diff --train 5022D 5022E # Compare two train itineraries`,
			);
			return;
		}

		beforeRef = {
			version: activeVersion,
			snapshotId: snapshots[snapshots.length - 2].id,
		};
		afterRef = {
			version: activeVersion,
			snapshotId: snapshots[snapshots.length - 1].id,
		};
	}

	const result = await diffSnapshots({
		dataDir,
		before: beforeRef,
		after: afterRef,
	});

	console.log(
		`\n=============================================================`,
	);
	console.log(
		`KRL Snapshot Diff: v${result.snapshotBefore.version}:${result.snapshotBefore.snapshotId} (${result.manifestBefore.day_type}) -> v${result.snapshotAfter.version}:${result.snapshotAfter.snapshotId} (${result.manifestAfter.day_type})`,
	);
	const hasBoardChanges =
		result.boardDiff.relettered.length > 0 ||
		result.boardDiff.retimed.length > 0 ||
		result.boardDiff.added.length > 0 ||
		result.boardDiff.withdrawn.length > 0;
	const hasCatalogChanges =
		result.catalogDiff != null &&
		(result.catalogDiff.added.length > 0 ||
			result.catalogDiff.removed.length > 0 ||
			result.catalogDiff.updated.length > 0);
	const hasTimetableChanges = hasBoardChanges || hasCatalogChanges;

	let evaluation: string;
	if (result.boardDiff.dayTypeContext === "calendar_variance") {
		evaluation = hasCatalogChanges
			? "CALENDAR VARIANCE WITH CATALOG MUTATIONS (Potential Edition Drift)"
			: "CALENDAR VARIANCE (expected day-type difference)";
	} else if (!hasTimetableChanges) {
		evaluation = "STABLE (Identical Timetable)";
	} else {
		evaluation = "POTENTIAL EDITION DRIFT (Timetable revisions detected)";
	}

	console.log(`Evaluation: ${evaluation}`);
	console.log(`=============================================================`);

	if (result.catalogDiff) {
		console.log(formatCatalogDiff(result.catalogDiff, { detail }));
		console.log(``);
	}

	console.log(formatBoardDiff(result.boardDiff, { detail }));
	console.log(
		`=============================================================\n`,
	);
}
