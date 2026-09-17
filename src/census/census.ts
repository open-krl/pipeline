// src/census/census.ts
import * as fs from "node:fs/promises";
import { itinerariesDir as getItinerariesDir } from "../archive/layout";
import type { DayType } from "../archive/schemas";
import type { CommitResult } from "../core/git";
import { startTimer } from "../core/logger";
import { commitCensus } from "./commit";
import {
	type CensusContext,
	type CensusOptions,
	resolveCensusContext,
} from "./context";
import { partitionTrains, runCensusCrawl } from "./crawl";
import { type DiscoveredTrain, discoverTrainIds } from "./discovery";
import {
	runStratifiedSpotCheck,
	type StratifiedCheckResult,
	selectStratifiedSample,
} from "./sample";

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
	commitResult?: CommitResult;
	logFilePath?: string;
}

/**
 * Executes the complete Itinerary Census pipeline (§8.3, §9).
 * Discovers train IDs from board captures, runs stratified spot-check if
 * applicable, and performs a resumable crawl to populate multi-observation
 * itinerary envelopes.
 */
export async function executeCensus(
	options: CensusOptions = {},
): Promise<CensusResult> {
	const timer = startTimer();
	const ctx = await resolveCensusContext(options);

	// 1. Discover all train IDs across captures in this version
	const discoveredMap = await discoverTrainIds(
		ctx.dataDir,
		ctx.version,
		ctx.targetDayType,
	);
	const totalDiscovered = discoveredMap.size;
	if (totalDiscovered === 0) {
		throw new Error(
			`No trains discovered from departure boards in version ${ctx.version} for day type '${ctx.targetDayType}'.`,
		);
	}

	// Logged before the cache-partition pass so slow phases are visible.
	ctx.logger.info(
		"census",
		"census_started",
		"Starting itinerary census crawl",
		{
			version: ctx.version,
			dayType: ctx.targetDayType,
			totalDiscovered,
			logFilePath: ctx.logFilePath,
		},
	);

	const itinerariesDir = getItinerariesDir(ctx.dataDir, ctx.version);
	await fs.mkdir(itinerariesDir, { recursive: true });

	// 2. Stratified Spot-Check (non-weekday runs, sampled from weekday baseline)
	const stratifiedCheck = await maybeRunSpotCheck(
		ctx,
		discoveredMap,
		itinerariesDir,
	);

	// 3. Partition cached vs to-probe
	const { trainsToProbe, cachedCount } = await partitionTrains({
		discoveredTrainIds: discoveredMap.keys(),
		itinerariesDir,
		targetDayType: ctx.targetDayType,
		reprobeAll: ctx.reprobeAll,
		totalDiscovered,
		onProgress: ctx.onProgress,
	});

	// 4. Concurrent crawl
	const crawl = await runCensusCrawl({
		trainsToProbe,
		cachedCount,
		totalDiscovered,
		client: ctx.client,
		itinerariesDir,
		targetDayType: ctx.targetDayType,
		logger: ctx.logger,
		onProgress: ctx.onProgress,
	});

	// 5. Optional git commit
	let commitResult: CommitResult | undefined;
	if (ctx.commit) {
		commitResult = await commitCensus({
			dataDir: ctx.dataDir,
			version: ctx.version,
			totalTrips: totalDiscovered,
			newlyProbed: trainsToProbe.length,
			failedCount: crawl.failedCount,
		});
	}

	ctx.logger.info(
		"census",
		"census_completed",
		"Itinerary census crawl completed",
		{
			version: ctx.version,
			dayType: ctx.targetDayType,
			totalDiscovered,
			totalProbed: trainsToProbe.length,
			cachedCount,
			successCount: crawl.successCount,
			notFoundCount: crawl.notFoundCount,
			failedCount: crawl.failedCount,
			durationSecs: timer.elapsedSecs,
			durationMs: timer.elapsedMs,
		},
	);
	await ctx.logger.flush();

	return {
		version: ctx.version,
		dayType: ctx.targetDayType,
		totalDiscovered,
		totalProbed: trainsToProbe.length,
		cachedCount,
		successCount: crawl.successCount,
		notFoundCount: crawl.notFoundCount,
		failedCount: crawl.failedCount,
		durationSecs: timer.elapsedSecs,
		stratifiedCheck,
		failedTrains: crawl.failedTrains,
		commitResult,
		logFilePath: ctx.logFilePath,
	};
}

/**
 * Non-weekday runs sample 5 representative services from the weekday
 * baseline and compare live hashes against cached weekday observations (§9).
 */
async function maybeRunSpotCheck(
	ctx: CensusContext,
	discoveredMap: Map<string, DiscoveredTrain>,
	itinerariesDir: string,
): Promise<StratifiedCheckResult | undefined> {
	if (ctx.targetDayType === "weekday") return undefined;

	// Weekday baseline includes suspended fakultatif services, which are
	// exactly the ones worth spot-checking on weekends.
	const baselineTrains = await discoverTrainIds(
		ctx.dataDir,
		ctx.version,
		"weekday",
	);
	const sample = selectStratifiedSample(
		baselineTrains.size > 0 ? baselineTrains : discoveredMap,
	);
	const check = await runStratifiedSpotCheck({
		client: ctx.client,
		itinerariesDir,
		sample,
		currentDayType: ctx.targetDayType,
		baselineDayType: "weekday",
	});

	if (!check.passed) {
		const details = check.divergences
			.map((d) => {
				const explanation = d.diffSummary ? `\n      ${d.diffSummary}` : "";
				return `  - [${d.stratum}] ${d.trainId}: ${d.baselineHash.slice(0, 10)}... vs ${d.liveHash.slice(0, 10)}...${explanation}`;
			})
			.join("\n");
		console.warn(
			`\n⚠️  [STRATIFIED SPOT-CHECK WARNING] Schedule divergence detected in representative services between weekday and ${ctx.targetDayType}:\n${details}\nRunbook escalation: Consider running 'census --reprobe-all --day-type ${ctx.targetDayType}'.\n`,
		);
	}
	return check;
}
