import {
	computeBoardResponseHash,
	computeStationMasterHash,
} from "../archive/hashes";
import { startTimer } from "../core/logger";
import { fetchDepartureBoards } from "./boards";
import type { CommitSnapshotResult } from "./commit";
import { commitCaptureSnapshot } from "./commit";
import { type CaptureOptions, resolveCaptureContext } from "./context";
import { evaluateGate1, evaluateGate2 } from "./gates";
import { writeSnapshotToDisk } from "./persist";
import { filterOperationalStations } from "./stations";
import { printCaptureSummary } from "./summary";
import type { CaptureResult } from "./types";

/**
 * Executes the full live capture pipeline (§8.1, §8.2).
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

	// 4. Gate 2: Timetable Edition Gate
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
		`Gate 2 evaluated: version ${gate2.versionToUse}`,
		{
			versionToUse: gate2.versionToUse,
			shouldBumpVersion: gate2.shouldBumpVersion,
			boardResponseHash: currentBoardResponseHash,
		},
	);

	// 5. Atomic Disk Persistence
	const result = await writeSnapshotToDisk({
		dataDir: ctx.dataDir,
		versionToUse: gate2.versionToUse,
		shouldBumpVersion: gate2.shouldBumpVersion,
		snapshotDate: ctx.snapshotDate,
		resolvedDayType: ctx.resolvedDayType,
		regionScope: ctx.regionScope,
		currentStationMasterHash,
		currentBoardResponseHash,
		isDegraded: boardsResult.isDegraded,
		stationsResponse,
		rawBoardsMap: boardsResult.rawBoardsMap,
	});

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
