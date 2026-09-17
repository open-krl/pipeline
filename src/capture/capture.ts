import * as fs from "node:fs/promises";
import {
	computeBoardResponseHash,
	computeStationMasterHash,
} from "../archive/hashes";
import { startTimer } from "../core/logger";
import { fetchDepartureBoards } from "./boards";
import type { CommitSnapshotResult } from "./commit";
import { commitCaptureSnapshot } from "./commit";
import { type CaptureOptions, resolveCaptureContext } from "./context";
import { evaluateGate1, evaluateGate2, promoteSnapshotToDisk } from "./gates";
import { writeSnapshotToDisk } from "./persist";
import { filterOperationalStations } from "./stations";
import { printCaptureSummary } from "./summary";
import type { CaptureResult } from "./types";

/**
 * Executes the full live capture pipeline (§8.1, §8.2).
 *
 * Data-safety contract: the fetched network payload is always persisted
 * to disk before Gate 2 evaluates the board hash. Gate 2 returns a
 * verdict — "accept", "bump", or "quit" — and the orchestrator acts on
 * it without ever discarding the data written to disk.
 */
export async function executeCapture(
	options: CaptureOptions = {},
): Promise<CaptureResult> {
	const timer = startTimer();
	const ctx = resolveCaptureContext(options);

	ctx.logger.info(
		"capture",
		"capture_started",
		"Starting departure board capture pipeline",
		{
			regionScope: ctx.regionScope,
			dayType: ctx.resolvedDayType,
			newVersion: ctx.newVersion,
			logFilePath: ctx.logFilePath,
		},
	);

	// 1. Fetch Station Master Catalog & Extract Operational Roster
	const stationsResponse = await ctx.client.fetchStations();
	const operationalStations = filterOperationalStations(
		stationsResponse.data,
		ctx.regionScope,
	);
	const currentStationMasterHash =
		computeStationMasterHash(operationalStations);

	// 2. Gate 1: Network Station Catalog Gate
	const gate1 = await evaluateGate1({
		dataDir: ctx.dataDir,
		currentStationMasterHash,
		currentStations: stationsResponse.data,
		newVersion: ctx.newVersion,
		yes: ctx.yes,
		prompt: ctx.prompt,
	});

	ctx.logger.info(
		"capture",
		"gate1_evaluated",
		`Gate 1 evaluated: version ${gate1.versionToUse}`,
		{
			activeVersion: gate1.activeVersion,
			versionToUse: gate1.versionToUse,
			shouldBumpVersion: gate1.shouldBumpVersion,
			stationMasterHash: currentStationMasterHash,
		},
	);

	// 3. Paced Concurrent Board Fan-Out
	const boardsResult = await fetchDepartureBoards(
		operationalStations,
		ctx.client,
		ctx.logger,
	);
	const currentBoardResponseHash = computeBoardResponseHash(
		boardsResult.boardsMap,
	);

	// 4. Write snapshot to disk immediately as "provisional".
	//    This guarantees the fetched data survives Gate 2 regardless of outcome.
	const provisionalStatus = boardsResult.isDegraded
		? "degraded"
		: "provisional";
	const provisionalResult = await writeSnapshotToDisk({
		dataDir: ctx.dataDir,
		versionToUse: gate1.versionToUse,
		shouldBumpVersion: gate1.shouldBumpVersion,
		snapshotDate: ctx.snapshotDate,
		resolvedDayType: ctx.resolvedDayType,
		regionScope: ctx.regionScope,
		currentStationMasterHash,
		currentBoardResponseHash,
		isDegraded: boardsResult.isDegraded,
		stationsResponse,
		rawBoardsMap: boardsResult.rawBoardsMap,
		status: provisionalStatus,
	});

	// 5. Gate 2: Timetable Edition Gate — operates on-disk, returns a verdict
	const gate2 = await evaluateGate2({
		dataDir: ctx.dataDir,
		versionToUse: gate1.versionToUse,
		shouldBumpVersion: gate1.shouldBumpVersion,
		resolvedDayType: ctx.resolvedDayType,
		currentBoardResponseHash,
		currentBoards: boardsResult.boardsMap,
		yes: ctx.yes,
		prompt: ctx.prompt,
	});

	ctx.logger.info(
		"capture",
		"gate2_evaluated",
		`Gate 2 evaluated: verdict=${gate2.verdict}, version ${gate2.versionToUse}`,
		{
			verdict: gate2.verdict,
			versionToUse: gate2.versionToUse,
			shouldBumpVersion: gate2.shouldBumpVersion,
			boardResponseHash: currentBoardResponseHash,
		},
	);

	let result: CaptureResult;

	if (gate2.verdict === "quit") {
		// Operator deferred — leave snapshot as provisional, exit cleanly
		result = {
			...provisionalResult,
			commitResult: undefined,
			logFilePath: ctx.logFilePath,
		};

		printCaptureSummary({
			result: { ...provisionalResult, logFilePath: ctx.logFilePath },
			totalStations: operationalStations.length,
			successfulBoardsCount: boardsResult.boardsMap.size,
			failedStations: boardsResult.failedStations,
			durationSecs: timer.elapsedSecs,
		});

		ctx.logger.info(
			"capture",
			"capture_provisional",
			"Capture left as provisional by operator. Inspect with: krl diff",
			{
				timetableVersion: provisionalResult.timetable_version,
				snapshotId: provisionalResult.snapshot_id,
				snapshotDir: provisionalResult.snapshot_dir,
			},
		);

		await ctx.logger.flush();
		return result;
	}

	if (gate2.verdict === "bump") {
		// Operator confirmed version bump — write a fresh complete snapshot under
		// the new version, then delete the provisional from the original version.
		const bumpedResult = await writeSnapshotToDisk({
			dataDir: ctx.dataDir,
			versionToUse: gate2.versionToUse,
			shouldBumpVersion: true,
			snapshotDate: ctx.snapshotDate,
			resolvedDayType: ctx.resolvedDayType,
			regionScope: ctx.regionScope,
			currentStationMasterHash,
			currentBoardResponseHash,
			isDegraded: boardsResult.isDegraded,
			stationsResponse,
			rawBoardsMap: boardsResult.rawBoardsMap,
			// No status override — use default complete/degraded logic
		});

		// Clean up the now-redundant provisional from the previous version
		await fs.rm(provisionalResult.snapshot_dir, {
			recursive: true,
			force: true,
		});

		result = {
			...bumpedResult,
			commitResult: undefined,
			logFilePath: ctx.logFilePath,
		};
	} else {
		// verdict === "accept": hash matched or operator accepted divergence.
		// Promote the provisional manifest to "complete" in-place.
		if (!boardsResult.isDegraded) {
			await promoteSnapshotToDisk({
				dataDir: ctx.dataDir,
				version: provisionalResult.timetable_version,
				snapshotId: provisionalResult.snapshot_id,
				manifest: provisionalResult.manifest,
			});
		}

		result = {
			...provisionalResult,
			manifest: {
				...provisionalResult.manifest,
				status: boardsResult.isDegraded ? "degraded" : "complete",
			},
			commitResult: undefined,
			logFilePath: ctx.logFilePath,
		};
	}

	// 6. Report Summary
	printCaptureSummary({
		result: { ...result, logFilePath: ctx.logFilePath },
		totalStations: operationalStations.length,
		successfulBoardsCount: boardsResult.boardsMap.size,
		failedStations: boardsResult.failedStations,
		durationSecs: timer.elapsedSecs,
	});

	// 7. Optional Git Auto-Commit Integration
	let commitResult: CommitSnapshotResult | undefined;
	if (ctx.commit && !ctx.noCommit) {
		commitResult = await commitCaptureSnapshot({
			snapshotDir: result.snapshot_dir,
			manifest: result.manifest,
		});

		if (commitResult.committed) {
			console.log(
				`[Git] Committed snapshot to git: ${commitResult.commitHash?.slice(0, 7)}`,
			);
		} else {
			console.warn(
				`[Git] Notice: Snapshot not committed: ${commitResult.reason}`,
			);
		}
	}

	ctx.logger.info(
		"capture",
		"capture_completed",
		"Departure board capture completed successfully",
		{
			timetableVersion: result.timetable_version,
			snapshotId: result.snapshot_id,
			status: result.manifest.status,
			totalStations: operationalStations.length,
			successfulBoardsCount: boardsResult.boardsMap.size,
			failedCount: boardsResult.failedStations.length,
			durationSecs: timer.elapsedSecs,
			durationMs: timer.elapsedMs,
			stationMasterHash: result.manifest.station_master_hash,
			boardResponseHash: result.manifest.board_response_hash,
		},
	);

	await ctx.logger.flush();

	return {
		...result,
		commitResult,
		logFilePath: ctx.logFilePath,
	};
}
