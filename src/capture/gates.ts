import type { DepartureBoardItem, StationItem } from "../api/schemas";
import type { DayType } from "../archive/schemas";
import {
	readSnapshotBoards,
	readSnapshotStations,
	scanSnapshots,
	scanTimetableVersions,
} from "../archive/snapshots";
import type { PromptFn } from "../core/prompt";
import { diffDepartureBoards } from "../diagnostic/board";
import { diffStationCatalogs } from "../diagnostic/catalog";

export interface Gate1Params {
	dataDir: string;
	currentStationMasterHash: string;
	currentStations?: readonly StationItem[];
	newVersion: boolean;
	yes: boolean;
	prompt: PromptFn;
}

export interface Gate1Result {
	activeVersion: number;
	versionToUse: number;
	shouldBumpVersion: boolean;
}

export interface Gate2Params {
	dataDir: string;
	versionToUse: number;
	shouldBumpVersion: boolean;
	resolvedDayType: DayType;
	currentBoardResponseHash: string;
	currentBoards?:
		| Record<string, readonly DepartureBoardItem[]>
		| Map<string, readonly DepartureBoardItem[]>;
	yes: boolean;
	prompt: PromptFn;
}

export interface Gate2Result {
	versionToUse: number;
	shouldBumpVersion: boolean;
}

/**
 * Shared hash-mismatch decision flow: halt in non-interactive mode,
 * prompt the operator, or confirm a version bump.
 */
async function resolveHashMismatchAlert(params: {
	gateName: string;
	promptMsg: string;
	nonInteractiveReason: string;
	abortReason: string;
	yes: boolean;
	prompt: PromptFn;
}): Promise<void> {
	if (params.yes) {
		throw new Error(params.nonInteractiveReason);
	}

	const confirmed = await params.prompt(params.promptMsg, false);
	if (!confirmed) {
		throw new Error(params.abortReason);
	}
}

/**
 * Best-effort diff summary for gate alerts. Falls back to empty
 * string (hash-only display) when the baseline cannot be loaded.
 */
async function buildDiffSummary(load: () => Promise<string>): Promise<string> {
	try {
		return `\n  ${await load()}`;
	} catch {
		return "";
	}
}

/**
 * Gate 1: Compares active station catalog hash against existing versions (§8.1).
 * Strictly evaluates against snapshots with status: "complete".
 */
export async function evaluateGate1(params: Gate1Params): Promise<Gate1Result> {
	const existingVersions = await scanTimetableVersions(params.dataDir);
	const activeVersion =
		existingVersions.length > 0
			? existingVersions[existingVersions.length - 1]
			: 1;

	if (params.newVersion && existingVersions.length > 0) {
		return {
			activeVersion,
			versionToUse: activeVersion + 1,
			shouldBumpVersion: true,
		};
	}

	if (existingVersions.length === 0) {
		return {
			activeVersion: 1,
			versionToUse: 1,
			shouldBumpVersion: false,
		};
	}

	const existingSnapshots = await scanSnapshots(params.dataDir, activeVersion);
	const completeSnapshots = existingSnapshots.filter(
		(s) => s.manifest.status === "complete",
	);
	if (completeSnapshots.length === 0) {
		return {
			activeVersion,
			versionToUse: activeVersion,
			shouldBumpVersion: false,
		};
	}

	const latestCompleteSnapshot =
		completeSnapshots[completeSnapshots.length - 1];
	const latestManifest = latestCompleteSnapshot.manifest;
	if (latestManifest.station_master_hash !== params.currentStationMasterHash) {
		const currentStations = params.currentStations; // ← hoist the narrowing
		const diffSummary = currentStations
			? await buildDiffSummary(async () => {
					const baselineStations = await readSnapshotStations(
						params.dataDir,
						activeVersion,
						latestCompleteSnapshot.id,
					);
					if (!baselineStations) return "";
					const diff = diffStationCatalogs(
						baselineStations.data,
						currentStations, // ← now safe
					);
					return diff.summary;
				})
			: "";

		const promptMsg = `[Gate 1 Alert] Station master hash differs from active version ${activeVersion} (${latestManifest.station_master_hash.slice(0, 8)} -> ${params.currentStationMasterHash.slice(0, 8)}).${diffSummary}\nNetwork catalog mutated. Increment timetable version to ${activeVersion + 1}?`;

		await resolveHashMismatchAlert({
			gateName: "1",
			promptMsg,
			nonInteractiveReason:
				"Capture halted by Gate 1 in non-interactive mode: station master hash mutated without --new-version flag.",
			abortReason: `[Gate 1 Alert] Capture aborted by operator: station master hash mismatch with active version ${activeVersion}.`,
			yes: params.yes,
			prompt: params.prompt,
		});

		return {
			activeVersion,
			versionToUse: activeVersion + 1,
			shouldBumpVersion: true,
		};
	}

	return {
		activeVersion,
		versionToUse: activeVersion,
		shouldBumpVersion: false,
	};
}

/**
 * Gate 2: Compares board signature against existing same-day-type snapshots (§8.1).
 */
export async function evaluateGate2(params: Gate2Params): Promise<Gate2Result> {
	if (params.shouldBumpVersion) {
		return {
			versionToUse: params.versionToUse,
			shouldBumpVersion: true,
		};
	}

	const existingSnapshots = await scanSnapshots(
		params.dataDir,
		params.versionToUse,
	);
	const sameDayTypeSnapshot = existingSnapshots.find(
		(s) =>
			s.manifest.day_type === params.resolvedDayType &&
			s.manifest.status === "complete",
	);

	if (sameDayTypeSnapshot) {
		const existingHash = sameDayTypeSnapshot.manifest.board_response_hash;
		if (existingHash !== params.currentBoardResponseHash) {
			const currentBoards = params.currentBoards;
			const diffSummary = currentBoards
				? await buildDiffSummary(async () => {
						const baselineBoardsMap = await readSnapshotBoards(
							params.dataDir,
							params.versionToUse,
							sameDayTypeSnapshot.id,
						);
						const baselineBoardsFlat = new Map<string, DepartureBoardItem[]>();
						for (const [staId, res] of baselineBoardsMap.entries()) {
							baselineBoardsFlat.set(staId, res.data);
						}
						const diff = diffDepartureBoards({
							boardsBefore: baselineBoardsFlat,
							boardsAfter: currentBoards,
							manifestBefore: sameDayTypeSnapshot.manifest,
							manifestAfter: { day_type: params.resolvedDayType },
						});
						return diff.summary;
					})
				: "";

			const promptMsg = `[Gate 2 Alert] Board signature differs for day type '${params.resolvedDayType}' compared to snapshot ${sameDayTypeSnapshot.id} (${existingHash.slice(0, 8)} -> ${params.currentBoardResponseHash.slice(0, 8)}).${diffSummary}\nPotential timetable edition revision. Increment timetable version to ${params.versionToUse + 1}?`;

			await resolveHashMismatchAlert({
				gateName: "2",
				promptMsg,
				nonInteractiveReason: `[Gate 2 Alert] Capture halted in non-interactive mode: board response signature differs for day type '${params.resolvedDayType}' without --new-version flag.`,
				abortReason: `[Gate 2 Alert] Capture aborted by operator: board response signature differs for day type '${params.resolvedDayType}'.`,
				yes: params.yes,
				prompt: params.prompt,
			});

			return {
				versionToUse: params.versionToUse + 1,
				shouldBumpVersion: true,
			};
		}
	}

	return {
		versionToUse: params.versionToUse,
		shouldBumpVersion: false,
	};
}
