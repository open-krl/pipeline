import type { KciClient } from "../api/client";
import type {
	DepartureBoardItem,
	DepartureBoardResponse,
	StationItem,
} from "../api/schemas";
import { resolveStationCode } from "../config";
import { type StructuredLogger, startTimer } from "../core/logger";

export interface FailedStation {
	id: string;
	name: string;
	reason: string;
}

export interface BoardFetchResult {
	boardsMap: Map<string, DepartureBoardItem[]>;
	rawBoardsMap: Map<string, DepartureBoardResponse>;
	failedStations: FailedStation[];
	isDegraded: boolean;
	durationSecs: string;
}

/**
 * Executes paced concurrent fan-out across all operational station departure boards.
 */
export async function fetchDepartureBoards(
	operationalStations: readonly StationItem[],
	client: KciClient,
	logger?: StructuredLogger,
): Promise<BoardFetchResult> {
	const startTime = Date.now();
	const boardsMap = new Map<string, DepartureBoardItem[]>();
	const rawBoardsMap = new Map<string, DepartureBoardResponse>();
	const failedStations: FailedStation[] = [];
	let completedCount = 0;
	const totalStations = operationalStations.length;

	await Promise.all(
		operationalStations.map(async (station) => {
			const stationTimer = startTimer();
			const resolvedId = resolveStationCode(station.sta_id);
			try {
				const schedule = await client.fetchStationSchedule(resolvedId);
				boardsMap.set(resolvedId, schedule.data);
				rawBoardsMap.set(resolvedId, schedule);
				completedCount++;
				const aliasInfo =
					resolvedId !== station.sta_id ? ` -> ${resolvedId}` : "";
				console.log(
					`[${String(completedCount).padStart(2, " ")}/${totalStations}] OK    ${(station.sta_id + aliasInfo).padEnd(10, " ")} (${station.sta_name}) - ${schedule.data.length} departures`,
				);
				logger?.info(
					"capture",
					"station_fetched",
					`Station ${station.sta_id} departures fetched`,
					{
						stationId: resolvedId,
						originalStationId: station.sta_id,
						stationName: station.sta_name,
						departures: schedule.data.length,
						durationMs: stationTimer.elapsedMs,
					},
				);
			} catch (err) {
				completedCount++;
				const reason = err instanceof Error ? err.message : String(err);
				failedStations.push({
					id: resolvedId,
					name: station.sta_name,
					reason,
				});
				console.warn(
					`[${String(completedCount).padStart(2, " ")}/${totalStations}] FAIL  ${station.sta_id.padEnd(5, " ")} (${station.sta_name}) - ${reason}`,
				);
				logger?.error(
					"capture",
					"station_failed",
					`Station ${station.sta_id} failed: ${reason}`,
					{
						stationId: resolvedId,
						originalStationId: station.sta_id,
						stationName: station.sta_name,
						reason,
						durationMs: stationTimer.elapsedMs,
					},
				);
			}
		}),
	);

	if (boardsMap.size === 0) {
		throw new Error(
			"Failed to fetch any departure boards. Upstream service unreachable.",
		);
	}

	const durationSecs = ((Date.now() - startTime) / 1000).toFixed(1);
	return {
		boardsMap,
		rawBoardsMap,
		failedStations,
		isDegraded: failedStations.length > 0,
		durationSecs,
	};
}
