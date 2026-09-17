import type { FailedStation } from "./boards";
import type { CaptureResult } from "./types";

/**
 * Formats and displays the end-of-run capture summary box.
 */
export function printCaptureSummary(params: {
	result: CaptureResult;
	totalStations: number;
	successfulBoardsCount: number;
	failedStations: FailedStation[];
	durationSecs: string;
}): void {
	const failedStr =
		params.failedStations.length > 0
			? ` (${params.failedStations.map((f) => `${f.id}: ${f.reason}`).join(", ")})`
			: "";
	const logStr = params.result.logFilePath
		? `\nLog File:             ${params.result.logFilePath}`
		: "";

	console.log(`
── Capture Summary ──────────────────────────────────────────
Timetable Version:    ${params.result.timetable_version}
Snapshot ID:          ${params.result.snapshot_id} (${params.result.manifest.day_type}, ${params.result.manifest.status})
Operational Stations: ${params.totalStations}
Successful Boards:    ${params.successfulBoardsCount}
Failed Stations:      ${params.failedStations.length}${failedStr}
Duration:             ${params.durationSecs}s
Station Master Hash:  ${params.result.manifest.station_master_hash.slice(0, 16)}...
Board Response Hash:  ${params.result.manifest.board_response_hash.slice(0, 16)}...
Saved to:             ${params.result.snapshot_dir}${logStr}
─────────────────────────────────────────────────────────────
`);
}
