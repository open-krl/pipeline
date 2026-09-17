// src/census/census.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { KciClient } from "../api/client";
import type {
	DayType,
	ItineraryObservation,
	ItineraryStop,
} from "../api/schemas";
import { scanSnapshots, scanTimetableVersions } from "../capture";
import { payloadHash } from "../core/canonical";
import { type CommitResult, commitPath } from "../core/git";
import {
	generateDefaultLogPath,
	StructuredLogger,
	startTimer,
} from "../core/logger";
import { resolveSafePath } from "../core/path";
import { type DiscoveredTrain, discoverTrainIds } from "./discovery";
import {
	getItineraryPath,
	readItineraryEnvelope,
	writeItineraryEnvelope,
} from "./envelope";
import {
	runStratifiedSpotCheck,
	type StratifiedCheckResult,
	type StratifiedDivergence,
	selectStratifiedSample,
} from "./sample";

export type { DiscoveredTrain, StratifiedCheckResult, StratifiedDivergence };

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

export interface CensusResult {
	version: number;
	dayType: DayType;
	totalDiscovered: number;
	totalProbed: number;
	cachedCount: number;
	successCount: number;
	notFoundCount: number;
	failedCount: number;
	durationSecs: string;
	stratifiedCheck?: StratifiedCheckResult;
	failedTrains: Array<{ trainId: string; reason: string }>;
	commitResult?: CommitCensusResult;
	logFilePath?: string;
}

/**
 * Executes the complete Itinerary Census pipeline (§8.3, §9).
 * Discovers train IDs from board captures, runs stratified spot-check if applicable,
 * and performs a paced, resumable crawl to populate multi-observation itinerary envelopes.
 */
export async function executeCensus(
	options: CensusOptions = {},
): Promise<CensusResult> {
	const timer = startTimer();
	const safeDataDir = resolveSafePath(options.dataDir ?? "data/raw");

	// 1. Resolve timetable version
	const allVersions = await scanTimetableVersions(safeDataDir);
	if (allVersions.length === 0) {
		throw new Error(
			`No timetable versions found in data directory: ${safeDataDir}`,
		);
	}
	const version = options.version ?? allVersions[allVersions.length - 1];

	// 2. Discover all train IDs across captures in this version
	const snapshots = await scanSnapshots(safeDataDir, version);
	if (snapshots.length === 0) {
		throw new Error(
			`No snapshots found under version ${version} in ${safeDataDir}`,
		);
	}

	// 3. Resolve target day_type and validate that a completed capture exists (§9)
	let targetDayType = options.dayType;
	if (!targetDayType) {
		// Default to the day type of the latest *completed* snapshot (§9)
		const latestComplete = [...snapshots]
			.reverse()
			.find((s) => s.manifest.status === "complete");
		if (!latestComplete) {
			throw new Error(
				`Census release gate failed: No completed capture snapshot found under version ${version} in ${safeDataDir}.`,
			);
		}
		targetDayType = latestComplete.manifest.day_type;
	} else {
		// If explicitly supplied, validate that a completed capture exists for this day type
		const completedCapture = snapshots.find(
			(s) =>
				s.manifest.day_type === targetDayType &&
				s.manifest.status === "complete",
		);
		if (!completedCapture) {
			throw new Error(
				`Census release gate failed: No completed capture snapshot found for day type '${targetDayType}' under version ${version}. Capture this day type first before running census.`,
			);
		}
	}

	let logger = options.logger;
	let logFilePath = options.logFilePath;
	if (!logger && !options.noLog) {
		logFilePath =
			options.logFilePath ??
			generateDefaultLogPath("census", {
				version,
				dayType: targetDayType,
				now: options.now,
				baseDir: options.dataDir ? safeDataDir : undefined,
			});
		logger = new StructuredLogger({ logFilePath });
	} else if (!logger) {
		logger = new StructuredLogger();
	}
	logFilePath = logger.logFilePath;

	const client = options.client ?? new KciClient({ logger });

	const discoveredMap = await discoverTrainIds(
		safeDataDir,
		version,
		targetDayType,
	);
	const totalDiscovered = discoveredMap.size;
	if (totalDiscovered === 0) {
		throw new Error(
			`No trains discovered from departure boards in version ${version} for day type '${targetDayType}'.`,
		);
	}

	const itinerariesDir = resolveSafePath(
		path.join(safeDataDir, String(version), "itineraries"),
		safeDataDir,
	);
	await fs.mkdir(itinerariesDir, { recursive: true });

	// 4. Stratified Spot-Check (Sampling 5 representative corridors when baseline cache exists)
	let stratifiedCheck: StratifiedCheckResult | undefined;
	if (targetDayType !== "weekday") {
		// Sample from weekday baseline so all representative corridor services (including suspended fakultatif) can be spot-checked
		const baselineTrains = await discoverTrainIds(
			safeDataDir,
			version,
			"weekday",
		);
		const sample = selectStratifiedSample(
			baselineTrains.size > 0 ? baselineTrains : discoveredMap,
		);
		stratifiedCheck = await runStratifiedSpotCheck({
			client,
			itinerariesDir,
			sample,
			currentDayType: targetDayType,
			baselineDayType: "weekday",
		});

		if (!stratifiedCheck.passed) {
			const divDetails = stratifiedCheck.divergences
				.map(
					(d) =>
						`  - [${d.stratum}] ${d.trainId}: ${d.baselineHash.slice(0, 10)}... vs ${d.liveHash.slice(0, 10)}...`,
				)
				.join("\n");
			console.warn(
				`\n⚠️  [STRATIFIED SPOT-CHECK WARNING] Schedule divergence detected in representative services between weekday and ${targetDayType}:\n${divDetails}\nRunbook escalation: Consider running 'census --reprobe-all --day-type ${targetDayType}'.\n`,
			);
		}
	}

	// 5. Determine which trains need probing
	const trainsToProbe: string[] = [];
	let cachedCount = 0;

	for (const trainId of discoveredMap.keys()) {
		if (options.reprobeAll) {
			trainsToProbe.push(trainId);
			continue;
		}

		try {
			const itineraryPath = getItineraryPath(itinerariesDir, trainId);
			const existing = await readItineraryEnvelope(itineraryPath);

			const targetObs = existing?.observations[targetDayType];
			if (existing && targetObs) {
				cachedCount++;
				if (options.onProgress) {
					options.onProgress({
						current: cachedCount,
						total: totalDiscovered,
						trainId,
						status: "cached",
						stopCount: targetObs.stops.length,
						payloadHash: targetObs.payload_hash,
					});
				}
			} else {
				trainsToProbe.push(trainId);
			}
		} catch {
			trainsToProbe.push(trainId);
		}
	}

	logger.info("census", "census_started", "Starting itinerary census crawl", {
		version,
		dayType: targetDayType,
		totalDiscovered,
		toProbeCount: trainsToProbe.length,
		cachedCount,
		logFilePath,
	});

	// 6. Concurrent, Paced Crawl
	let successCount = 0;
	let notFoundCount = 0;
	let failedCount = 0;
	const failedTrains: Array<{ trainId: string; reason: string }> = [];

	let completedSoFar = cachedCount;

	await Promise.all(
		trainsToProbe.map(async (trainId) => {
			const probeTimer = startTimer();
			let stops: ItineraryStop[] = [];
			let hash = "";
			let status: "ok" | "not_found" = "not_found";

			try {
				const itineraryPath = getItineraryPath(itinerariesDir, trainId);
				const response = await client.fetchTrainSchedule(trainId);

				const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

				if (response?.data && response.data.length > 0) {
					stops = response.data;
					hash = payloadHash(stops);
					status = "ok";
				} else {
					// 404 / no active schedule
					stops = [];
					hash = payloadHash([]);
					status = "not_found";
				}

				const existing = (await readItineraryEnvelope(itineraryPath)) ?? {
					train_id: trainId,
					observations: {} as Record<DayType, ItineraryObservation>,
				};

				existing.observations[targetDayType] = {
					fetched_at: fetchedAt,
					payload_hash: hash,
					stops,
				};

				await writeItineraryEnvelope(itineraryPath, existing);

				// Outcome counters are updated ONLY after write succeeds
				if (status === "ok") {
					successCount++;
				} else {
					notFoundCount++;
				}

				completedSoFar++;
				logger.info(
					"census",
					"train_probed",
					`Train ${trainId}: ${status === "ok" ? "OK" : "404 (Suspended)"}`,
					{
						trainId,
						status,
						stopCount: stops.length,
						payloadHash: hash,
						durationMs: probeTimer.elapsedMs,
					},
				);

				if (options.onProgress) {
					options.onProgress({
						current: completedSoFar,
						total: totalDiscovered,
						trainId,
						status,
						stopCount: stops.length,
						payloadHash: hash,
					});
				} else {
					const pct = ((completedSoFar / totalDiscovered) * 100).toFixed(1);
					const statusLabel =
						status === "ok" ? `OK (${stops.length} stops)` : "404 (Suspended)";
					console.log(
						`[${String(completedSoFar).padStart(4, " ")}/${totalDiscovered}] (${pct}%) ${statusLabel} ${trainId}`,
					);
				}
			} catch (err) {
				completedSoFar++;
				failedCount++;
				const reason = err instanceof Error ? err.message : String(err);
				failedTrains.push({ trainId, reason });

				logger.error(
					"census",
					"train_failed",
					`Train ${trainId} probe failed: ${reason}`,
					{
						trainId,
						reason,
						durationMs: probeTimer.elapsedMs,
					},
				);

				if (options.onProgress) {
					options.onProgress({
						current: completedSoFar,
						total: totalDiscovered,
						trainId,
						status: "failed",
						error: reason,
					});
				} else {
					console.warn(
						`[${String(completedSoFar).padStart(4, " ")}/${totalDiscovered}] FAIL  ${trainId} - ${reason}`,
					);
				}
			}
		}),
	);

	// 7. Optional Git Commit
	let commitResult: CommitCensusResult | undefined;
	if (options.commit) {
		commitResult = await commitCensus({
			dataDir: safeDataDir,
			version,
			totalTrips: totalDiscovered,
			newlyProbed: trainsToProbe.length,
			failedCount,
		});
	}

	const durationSecs = timer.elapsedSecs;
	const durationMs = timer.elapsedMs;

	logger.info(
		"census",
		"census_completed",
		"Itinerary census crawl completed",
		{
			version,
			dayType: targetDayType,
			totalDiscovered,
			totalProbed: trainsToProbe.length,
			cachedCount,
			successCount,
			notFoundCount,
			failedCount,
			durationSecs,
			durationMs,
		},
	);

	await logger.flush();

	return {
		version,
		dayType: targetDayType,
		totalDiscovered,
		totalProbed: trainsToProbe.length,
		cachedCount,
		successCount,
		notFoundCount,
		failedCount,
		durationSecs,
		stratifiedCheck,
		failedTrains,
		commitResult,
		logFilePath,
	};
}

export type CommitCensusResult = CommitResult;

export interface CommitCensusOptions {
	dataDir: string;
	version: number;
	totalTrips: number;
	newlyProbed: number;
	failedCount: number;
	cwd?: string;
}

/**
 * Formats standard Conventional Commit message for an itinerary census run.
 */
export function formatCensusCommitMessage(
	params: {
		timetableVersion: number;
		totalTrips: number;
		newlyProbed: number;
		failedCount: number;
	},
	options: { coAuthor?: boolean } = {},
): string {
	const coAuthor = options.coAuthor ?? true;
	const footer = coAuthor
		? "\n\nGenerated with Antigravity\nCo-authored-by: gemini-code-assist[bot] <176961590+gemini-code-assist[bot]@users.noreply.github.com>"
		: "";

	return `chore(census): record v${params.timetableVersion} itineraries census (${params.totalTrips} trips)

Total Trips:  ${params.totalTrips}
Newly Probed: ${params.newlyProbed}
Failed:       ${params.failedCount}${footer}`;
}

/**
 * Stages and commits itinerary census raw payloads for a timetable edition to git.
 */
export async function commitCensus(
	options: CommitCensusOptions,
): Promise<CommitCensusResult> {
	const cwd = options.cwd ?? process.cwd();
	let resolvedItinerariesDir: string;
	try {
		const safeDataDir = resolveSafePath(options.dataDir, cwd);
		resolvedItinerariesDir = resolveSafePath(
			path.join(safeDataDir, String(options.version), "itineraries"),
			cwd,
		);
	} catch (err) {
		return {
			committed: false,
			reason: `Invalid itineraries directory: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const commitMessage = formatCensusCommitMessage({
		timetableVersion: options.version,
		totalTrips: options.totalTrips,
		newlyProbed: options.newlyProbed,
		failedCount: options.failedCount,
	});

	return commitPath({
		path: resolvedItinerariesDir,
		message: commitMessage,
		cwd,
	});
}
