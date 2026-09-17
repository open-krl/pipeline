import type { KciClient } from "../api/client";
import type { ItineraryStop } from "../api/schemas";
import {
	getItineraryPath,
	readItineraryEnvelope,
	writeItineraryEnvelope,
} from "../archive/itineraries";
import type { DayType, ItineraryObservation } from "../archive/schemas";
import { payloadHash } from "../core/canonical";
import { type StructuredLogger, startTimer } from "../core/logger";
import type { CensusProgress } from "./context";

export type ProbeOutcome =
	| {
			status: "ok";
			trainId: string;
			stopCount: number;
			payloadHash: string;
			durationMs: number;
	  }
	| { status: "not_found"; trainId: string; durationMs: number }
	| { status: "failed"; trainId: string; reason: string; durationMs: number };

export interface CrawlResult {
	successCount: number;
	notFoundCount: number;
	failedCount: number;
	failedTrains: Array<{ trainId: string; reason: string }>;
}

/**
 * Splits discovered trains into cached (envelope already holds an
 * observation for the target day type) and to-probe. Envelope read
 * failures count as to-probe, making the crawl self-healing.
 */
export async function partitionTrains(params: {
	discoveredTrainIds: Iterable<string>;
	itinerariesDir: string;
	targetDayType: DayType;
	reprobeAll: boolean;
	totalDiscovered: number;
	onProgress?: (progress: CensusProgress) => void;
}): Promise<{ trainsToProbe: string[]; cachedCount: number }> {
	const trainsToProbe: string[] = [];
	let cachedCount = 0;

	for (const trainId of params.discoveredTrainIds) {
		if (params.reprobeAll) {
			trainsToProbe.push(trainId);
			continue;
		}
		try {
			const existing = await readItineraryEnvelope(
				getItineraryPath(params.itinerariesDir, trainId),
			);
			const targetObs = existing?.observations[params.targetDayType];
			if (existing && targetObs) {
				cachedCount++;
				params.onProgress?.({
					current: cachedCount,
					total: params.totalDiscovered,
					trainId,
					status: "cached",
					stopCount: targetObs.stops.length,
					payloadHash: targetObs.payload_hash,
				});
			} else {
				trainsToProbe.push(trainId);
			}
		} catch {
			trainsToProbe.push(trainId);
		}
	}

	return { trainsToProbe, cachedCount };
}

/**
 * Probes one train and persists the observation envelope.
 * Returns the outcome; does not mutate caller state.
 */
async function probeTrain(params: {
	trainId: string;
	client: KciClient;
	itinerariesDir: string;
	targetDayType: DayType;
}): Promise<ProbeOutcome> {
	const probeTimer = startTimer();
	const itineraryPath = getItineraryPath(params.itinerariesDir, params.trainId);

	try {
		const response = await params.client.fetchTrainSchedule(params.trainId);
		const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

		// 404 / no active schedule becomes an empty not_found observation
		const stops: ItineraryStop[] = response?.data?.length ? response.data : [];
		const hash = payloadHash(stops);

		const existing = (await readItineraryEnvelope(itineraryPath)) ?? {
			train_id: params.trainId,
			observations: {} as Record<DayType, ItineraryObservation>,
		};
		existing.observations[params.targetDayType] = {
			fetched_at: fetchedAt,
			payload_hash: hash,
			stops,
		};
		await writeItineraryEnvelope(itineraryPath, existing);

		return stops.length > 0
			? {
					status: "ok",
					trainId: params.trainId,
					stopCount: stops.length,
					payloadHash: hash,
					durationMs: probeTimer.elapsedMs,
				}
			: {
					status: "not_found",
					trainId: params.trainId,
					durationMs: probeTimer.elapsedMs,
				};
	} catch (err) {
		return {
			status: "failed",
			trainId: params.trainId,
			reason: err instanceof Error ? err.message : String(err),
			durationMs: probeTimer.elapsedMs,
		};
	}
}

/**
 * Single reporting point per outcome: structured log always,
 * onProgress callback when provided, console line otherwise.
 */
function reportOutcome(params: {
	outcome: ProbeOutcome;
	current: number;
	total: number;
	logger: StructuredLogger;
	onProgress?: (progress: CensusProgress) => void;
}): void {
	const { outcome, current, total } = params;

	params.onProgress?.({
		current,
		total,
		trainId: outcome.trainId,
		status: outcome.status,
		stopCount: outcome.status === "ok" ? outcome.stopCount : undefined,
		payloadHash: outcome.status === "ok" ? outcome.payloadHash : undefined,
		error: outcome.status === "failed" ? outcome.reason : undefined,
	});

	if (!params.onProgress) {
		const pct = ((current / total) * 100).toFixed(1);
		const label =
			outcome.status === "ok"
				? `OK (${outcome.stopCount} stops)`
				: outcome.status === "not_found"
					? "404 (Suspended)"
					: `FAIL - ${outcome.reason}`;
		const line = `[${String(current).padStart(4, " ")}/${total}] (${pct}%) ${label} ${outcome.trainId}`;
		if (outcome.status === "failed") console.warn(line);
		else console.log(line);
	}

	params.logger[outcome.status === "failed" ? "error" : "info"](
		"census",
		outcome.status === "failed" ? "train_failed" : "train_probed",
		`Train ${outcome.trainId}: ${
			outcome.status === "ok"
				? "OK"
				: outcome.status === "not_found"
					? "404 (Suspended)"
					: `probe failed: ${outcome.reason}`
		}`,
		{
			trainId: outcome.trainId,
			status: outcome.status,
			stopCount: outcome.status === "ok" ? outcome.stopCount : undefined,
			payloadHash: outcome.status === "ok" ? outcome.payloadHash : undefined,
			reason: outcome.status === "failed" ? outcome.reason : undefined,
			durationMs: outcome.durationMs,
		},
	);
}

/**
 * Concurrent crawl over to-probe trains.
 * NOTE: currently unbounded fan-out (see pacing follow-up).
 */
export async function runCensusCrawl(params: {
	trainsToProbe: string[];
	cachedCount: number;
	totalDiscovered: number;
	client: KciClient;
	itinerariesDir: string;
	targetDayType: DayType;
	logger: StructuredLogger;
	onProgress?: (progress: CensusProgress) => void;
}): Promise<CrawlResult> {
	let successCount = 0;
	let notFoundCount = 0;
	let failedCount = 0;
	const failedTrains: Array<{ trainId: string; reason: string }> = [];
	let completedSoFar = params.cachedCount;

	await Promise.all(
		params.trainsToProbe.map(async (trainId) => {
			const outcome = await probeTrain({
				trainId,
				client: params.client,
				itinerariesDir: params.itinerariesDir,
				targetDayType: params.targetDayType,
			});

			// Counters update only after probeTrain returns, i.e. after the
			// envelope write succeeded (or the probe failed outright).
			if (outcome.status === "ok") successCount++;
			else if (outcome.status === "not_found") notFoundCount++;
			else {
				failedCount++;
				failedTrains.push({ trainId, reason: outcome.reason });
			}

			completedSoFar++;
			reportOutcome({
				outcome,
				current: completedSoFar,
				total: params.totalDiscovered,
				logger: params.logger,
				onProgress: params.onProgress,
			});
		}),
	);

	return { successCount, notFoundCount, failedCount, failedTrains };
}
