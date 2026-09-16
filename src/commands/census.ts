// src/commands/census.ts
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { KciClient } from "../api/client";
import {
	type DayType,
	DepartureBoardResponseSchema,
	type ItineraryObservation,
	type ItineraryStop,
	type MultiObservationItinerary,
	MultiObservationItinerarySchema,
} from "../api/schemas";
import { payloadHash } from "../core/canonical";
import { type CommitCensusResult, commitCensus } from "../core/git";
import { resolveSafePath } from "../core/path";
import { scanSnapshots, scanTimetableVersions } from "./capture";

export interface DiscoveredTrain {
	trainId: string;
	kaName?: string;
	routeName?: string;
	dest?: string;
	stations: string[];
	dayTypes: Set<DayType>;
}

export interface CensusOptions {
	client?: KciClient;
	dataDir?: string;
	version?: number;
	dayType?: DayType;
	reprobeAll?: boolean;
	now?: Date;
	commit?: boolean;
	onProgress?: (progress: CensusProgress) => void;
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

export interface StratifiedDivergence {
	stratum: string;
	trainId: string;
	baselineDayType: DayType;
	baselineHash: string;
	liveHash: string;
}

export interface StratifiedCheckResult {
	evaluated: boolean;
	divergences: StratifiedDivergence[];
	passed: boolean;
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

/**
 * Samples 5 representative services across key corridors for the Stratified Spot-Check (§9):
 * 1. Bogor Trunk train
 * 2. Cikarang Trunk train
 * 3. Loop-line / Racket topology train
 * 4. Western Branch line train (Rangkasbitung / Merak)
 * 5. Fakultatif ('F'-suffix) train
 */
export function selectStratifiedSample(
	discoveredTrains: Map<string, DiscoveredTrain>,
): Record<string, DiscoveredTrain | null> {
	const sample: Record<string, DiscoveredTrain | null> = {
		bogor: null,
		cikarang: null,
		loop: null,
		branch: null,
		fakultatif: null,
	};

	for (const train of discoveredTrains.values()) {
		const trainId = train.trainId;
		const kaName = (train.kaName ?? "").toLowerCase();
		const routeName = (train.routeName ?? "").toLowerCase();
		const dest = (train.dest ?? "").toUpperCase();

		// 5. Fakultatif service (ends in 'F', e.g. 1234F)
		if (!sample.fakultatif && /f$/i.test(trainId)) {
			sample.fakultatif = train;
		}

		// 1. Bogor Trunk (calls at Bogor / Manggarai trunk, ka_name mentions Bogor)
		if (
			!sample.bogor &&
			(kaName.includes("bogor") ||
				dest === "BOGOR" ||
				dest === "JAKARTA KOTA") &&
			(train.stations.includes("BOO") || train.stations.includes("MRI"))
		) {
			sample.bogor = train;
		}

		// 2. Cikarang Trunk (calls at Bekasi/Cikarang trunk, ka_name mentions Cikarang)
		if (
			!sample.cikarang &&
			(kaName.includes("cikarang") ||
				dest === "CIKARANG" ||
				dest === "BEKASI") &&
			(train.stations.includes("CKR") || train.stations.includes("BKS"))
		) {
			sample.cikarang = train;
		}

		// 3. Loop-line / Racket (calls at loop stations e.g. Kampung Bandan, Angke, Jatinegara)
		if (
			!sample.loop &&
			(kaName.includes("loop") ||
				routeName.includes("loop") ||
				routeName.includes("lingkar") ||
				(train.stations.includes("KMO") && train.stations.includes("JNG")))
		) {
			sample.loop = train;
		}

		// 4. Western Branch (Rangkasbitung, Serpong, Merak)
		if (
			!sample.branch &&
			(kaName.includes("rangkasbitung") ||
				kaName.includes("merak") ||
				dest === "RANGKASBITUNG" ||
				dest === "MERAK" ||
				train.stations.includes("RK") ||
				train.stations.includes("MER"))
		) {
			sample.branch = train;
		}
	}

	return sample;
}

/**
 * Safely resolves the JSON envelope storage path for a train ID.
 * Replaces forward slashes with '%2F' to ensure flat directory storage,
 * and guarantees containment within itinerariesDir.
 */
export function getItineraryPath(
	itinerariesDir: string,
	trainId: string,
): string {
	const safeFilename = `${encodeURIComponent(trainId)}.json`;
	return resolveSafePath(
		path.join(itinerariesDir, safeFilename),
		itinerariesDir,
	);
}

/**
 * Reads and parses an existing MultiObservationItinerary envelope from disk.
 * Returns null if the file does not exist (ENOENT). Throws if corrupted or malformed.
 */
export async function readItineraryEnvelope(
	filePath: string,
): Promise<MultiObservationItinerary | null> {
	try {
		const content = await fs.readFile(filePath, "utf-8");
		return MultiObservationItinerarySchema.parse(JSON.parse(content));
	} catch (err) {
		if (
			err &&
			typeof err === "object" &&
			"code" in err &&
			(err as { code: string }).code === "ENOENT"
		) {
			return null;
		}
		throw new Error(
			`Failed to read or parse itinerary envelope at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Atomically writes a MultiObservationItinerary envelope to disk via temporary sibling rename.
 */
export async function writeItineraryEnvelope(
	filePath: string,
	envelope: MultiObservationItinerary,
): Promise<void> {
	MultiObservationItinerarySchema.parse(envelope);
	const dir = path.dirname(filePath);
	const filename = path.basename(filePath);
	const tmpFile = resolveSafePath(
		path.join(dir, `.tmp_${filename}_${Date.now()}`),
		dir,
	);

	await fs.writeFile(tmpFile, JSON.stringify(envelope, null, 2), "utf-8");
	await fs.rename(tmpFile, filePath);
}

/**
 * Runs the Stratified Spot-Check (§9) against 5 representative services.
 * Compares current live payload hashes against cached baseline (weekday) observations.
 */
export async function runStratifiedSpotCheck(params: {
	client: KciClient;
	itinerariesDir: string;
	sample: Record<string, DiscoveredTrain | null>;
	currentDayType: DayType;
	baselineDayType?: DayType;
}): Promise<StratifiedCheckResult> {
	const baselineDayType = params.baselineDayType ?? "weekday";
	const divergences: StratifiedDivergence[] = [];
	let checkedAny = false;

	for (const [stratum, train] of Object.entries(params.sample)) {
		if (!train) continue;

		const itineraryFile = getItineraryPath(
			params.itinerariesDir,
			train.trainId,
		);
		const existing = await readItineraryEnvelope(itineraryFile);
		const baselineObs = existing?.observations[baselineDayType];
		if (!baselineObs) continue;

		checkedAny = true;
		const liveResponse = await params.client.fetchTrainSchedule(train.trainId);

		// Upstream 404 handling
		if (!liveResponse) {
			// Fakultatif ('F'-suffix) trains on weekends: 404 is expected suspension, not divergence (§9)
			if (stratum === "fakultatif") {
				continue;
			}
			divergences.push({
				stratum,
				trainId: train.trainId,
				baselineDayType,
				baselineHash: baselineObs.payload_hash,
				liveHash: "404_NOT_FOUND",
			});
			continue;
		}

		const liveHash = payloadHash(liveResponse.data);
		if (liveHash !== baselineObs.payload_hash) {
			divergences.push({
				stratum,
				trainId: train.trainId,
				baselineDayType,
				baselineHash: baselineObs.payload_hash,
				liveHash,
			});
		}
	}

	return {
		evaluated: checkedAny,
		divergences,
		passed: divergences.length === 0,
	};
}

/**
 * Executes the complete Itinerary Census pipeline (§8.3, §9).
 * Discovers train IDs from board captures, runs stratified spot-check if applicable,
 * and performs a paced, resumable crawl to populate multi-observation itinerary envelopes.
 */
export async function executeCensus(
	options: CensusOptions = {},
): Promise<CensusResult> {
	const startTime = Date.now();
	const client = options.client ?? new KciClient();
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

	// 6. Concurrent, Paced Crawl
	let successCount = 0;
	let notFoundCount = 0;
	let failedCount = 0;
	const failedTrains: Array<{ trainId: string; reason: string }> = [];

	let completedSoFar = cachedCount;

	await Promise.all(
		trainsToProbe.map(async (trainId) => {
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

	const durationSecs = ((Date.now() - startTime) / 1000).toFixed(1);

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
	};
}
