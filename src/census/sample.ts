// src/census/sample.ts
import type { KciClient } from "../api/client";
import type { DayType } from "../archive/schemas";
import { payloadHash } from "../core/canonical";
import type { DiscoveredTrain } from "./discovery";
import { getItineraryPath, readItineraryEnvelope } from "./envelope";

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
