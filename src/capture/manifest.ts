// src/capture/manifest.ts
import type { DepartureBoardItem, StationItem } from "../api/schemas";
import { canonicalSerialize, payloadHash, sha256 } from "../core/canonical";

/**
 * Computes canonical hash for the active station master catalog (§8.1, §8.2).
 * Excludes WIL% section headers, sorts stations alphabetically by sta_id.
 */
export function computeStationMasterHash(
	stations: ReadonlyArray<StationItem>,
): string {
	const validStations = stations
		.filter((s) => !s.sta_id.startsWith("WIL"))
		.slice()
		.sort((a, b) => a.sta_id.localeCompare(b.sta_id));

	return payloadHash(validStations);
}

/**
 * Computes composite departure board signature hash for drift detection (§8.2).
 * Station board JSON responses within the capture are sorted alphabetically
 * by sta_id, serialized with sorted object keys, concatenated, and hashed via SHA-256.
 */
export function computeBoardResponseHash(
	boardsByStationId:
		| Record<string, DepartureBoardItem[]>
		| Map<string, DepartureBoardItem[]>,
): string {
	const entries =
		boardsByStationId instanceof Map
			? Array.from(boardsByStationId.entries())
			: Object.entries(boardsByStationId);

	// Sort station keys alphabetically
	entries.sort(([idA], [idB]) => idA.localeCompare(idB));

	// Concatenate canonical serialized payload strings
	const serializedChunks: string[] = [];
	for (const [stationId, departures] of entries) {
		serializedChunks.push(`${stationId}:${canonicalSerialize(departures)}`);
	}

	return sha256(serializedChunks.join("\n"));
}
