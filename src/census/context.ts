import { KciClient } from "../api/client";
import type { DayType } from "../archive/schemas";
import { scanSnapshots, scanTimetableVersions } from "../archive/snapshots";
import { resolvePipelineLogging, type StructuredLogger } from "../core/logger";
import { resolveSafePath } from "../core/path";

export interface CensusOptions {
	client?: KciClient;
	dataDir?: string;
	version?: number;
	dayType?: DayType;
	reprobeAll?: boolean;
	now?: Date;
	commit?: boolean;
	onProgress?: (progress: CensusProgress) => void;
	logger?: StructuredLogger;
	logFilePath?: string;
	noLog?: boolean;
}

export interface CensusProgress {
	current: number;
	total: number;
	trainId: string;
	status: "cached" | "ok" | "not_found" | "failed";
	stopCount?: number;
	payloadHash?: string;
	error?: string;
}

export type CensusContext = Awaited<ReturnType<typeof resolveCensusContext>>;

/**
 * Resolves options + data-dir state into validated run parameters.
 * Enforces the §9 release gate: a completed capture must exist for the
 * target day type before census may run.
 */
export async function resolveCensusContext(options: CensusOptions) {
	const dataDir = resolveSafePath(options.dataDir ?? "data/raw");

	// 1. Resolve timetable version
	const allVersions = await scanTimetableVersions(dataDir);
	if (allVersions.length === 0) {
		throw new Error(
			`No timetable versions found in data directory: ${dataDir}`,
		);
	}
	const version = options.version ?? allVersions[allVersions.length - 1];

	// 2. Snapshots must exist for the version
	const snapshots = await scanSnapshots(dataDir, version);
	if (snapshots.length === 0) {
		throw new Error(
			`No snapshots found under version ${version} in ${dataDir}`,
		);
	}

	// 3. Resolve target day type under the release gate (§9)
	const targetDayType = await resolveTargetDayType(
		options.dayType,
		snapshots,
		version,
		dataDir,
	);

	const { logger, logFilePath } = resolvePipelineLogging({
		logger: options.logger,
		logFilePath: options.logFilePath,
		noLog: options.noLog,
		defaultLogName: "census",
		context: { version, dayType: targetDayType, now: options.now },
		baseDir: options.dataDir ? dataDir : undefined,
	});

	const client = options.client ?? new KciClient({ logger });

	return {
		dataDir,
		version,
		targetDayType,
		client,
		logger,
		logFilePath,
		reprobeAll: Boolean(options.reprobeAll),
		commit: Boolean(options.commit),
		onProgress: options.onProgress,
	};
}

/**
 * Default: day type of the latest *completed* snapshot. When explicitly
 * supplied, requires a completed capture for that day type (§9).
 */
function resolveTargetDayType(
	requested: DayType | undefined,
	snapshots: Awaited<ReturnType<typeof scanSnapshots>>,
	version: number,
	dataDir: string,
): DayType {
	if (!requested) {
		const latestComplete = [...snapshots]
			.reverse()
			.find((s) => s.manifest.status === "complete");
		if (!latestComplete) {
			throw new Error(
				`Census release gate failed: No completed capture snapshot found under version ${version} in ${dataDir}.`,
			);
		}
		return latestComplete.manifest.day_type;
	}

	const completedCapture = snapshots.find(
		(s) =>
			s.manifest.day_type === requested && s.manifest.status === "complete",
	);
	if (!completedCapture) {
		throw new Error(
			`Census release gate failed: No completed capture snapshot found for day type '${requested}' under version ${version}. Capture this day type first before running census.`,
		);
	}
	return requested;
}
