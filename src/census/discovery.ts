// src/census/discovery.ts
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type DayType, DepartureBoardResponseSchema } from "../api/schemas";
import { scanSnapshots } from "../capture";
import { resolveSafePath } from "../core/path";

export interface DiscoveredTrain {
	trainId: string;
	kaName?: string;
	routeName?: string;
	dest?: string;
	stations: string[];
	dayTypes: Set<DayType>;
}

/**
 * Scans all board files within captures of a given timetable version,
 * discovering all distinct train IDs and their routing metadata (§8.1, §8.3).
 */
export async function discoverTrainIds(
	dataDir: string,
	version: number,
	filterDayType?: DayType,
): Promise<Map<string, DiscoveredTrain>> {
	const safeDataDir = resolveSafePath(dataDir);
	const snapshots = await scanSnapshots(safeDataDir, version);
	const trains = new Map<string, DiscoveredTrain>();

	const matchingSnapshots = filterDayType
		? snapshots.filter((s) => s.manifest.day_type === filterDayType)
		: snapshots;

	for (const snap of matchingSnapshots) {
		const boardsDir = resolveSafePath(
			path.join(
				safeDataDir,
				String(version),
				"captures",
				String(snap.id),
				"boards",
			),
			safeDataDir,
		);

		let entries: Dirent[];
		try {
			entries = await fs.readdir(boardsDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const boardFile = resolveSafePath(
				path.join(boardsDir, entry.name),
				boardsDir,
			);
			const staId = entry.name.replace(/\.json$/, "");

			try {
				const content = await fs.readFile(boardFile, "utf-8");
				const parsed = DepartureBoardResponseSchema.parse(JSON.parse(content));

				for (const item of parsed.data) {
					if (
						!item.train_id ||
						typeof item.train_id !== "string" ||
						item.train_id.includes("..") ||
						!/^[A-Za-z0-9_/-]+$/.test(item.train_id)
					) {
						console.warn(
							`Warning: Skipping invalid train ID '${item.train_id}' in board ${boardFile}`,
						);
						continue;
					}

					const existing = trains.get(item.train_id);
					if (existing) {
						if (!existing.stations.includes(staId)) {
							existing.stations.push(staId);
						}
						existing.dayTypes.add(snap.manifest.day_type);
						if (!existing.kaName && item.ka_name) {
							existing.kaName = item.ka_name;
						}
						if (!existing.routeName && item.route_name) {
							existing.routeName = item.route_name;
						}
						if (!existing.dest && item.dest) {
							existing.dest = item.dest;
						}
					} else {
						trains.set(item.train_id, {
							trainId: item.train_id,
							kaName: item.ka_name,
							routeName: item.route_name,
							dest: item.dest,
							stations: [staId],
							dayTypes: new Set([snap.manifest.day_type]),
						});
					}
				}
			} catch (err) {
				console.warn(
					`Warning: Failed to parse board file at ${boardFile}:`,
					err instanceof Error ? err.message : String(err),
				);
			}
		}
	}

	return trains;
}
