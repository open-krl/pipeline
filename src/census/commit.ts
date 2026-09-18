import { itinerariesDir } from "../archive/layout";
import { type CommitResult, commitPath } from "../core/git";
import { resolveSafePath } from "../core/path";

export interface CommitCensusOptions {
	dataDir: string;
	version: number;
	totalTrips: number;
	newlyProbed: number;
	failedCount: number;
	cwd?: string;
}

/**
 * Formats standard Conventional Commit message for an itinerary census run.
 */
export function formatCensusCommitMessage(
	params: {
		timetableVersion: number;
		totalTrips: number;
		newlyProbed: number;
		failedCount: number;
	},
	options: { coAuthor?: boolean } = {},
): string {
	const coAuthor = options.coAuthor ?? true;
	const footer = coAuthor ? "\n\nGenerated commit by Open-KRL-Pipeline" : "";

	return `chore(census): record v${params.timetableVersion} itineraries census (${params.totalTrips} trips)

Total Trips:  ${params.totalTrips}
Newly Probed: ${params.newlyProbed}
Failed:       ${params.failedCount}${footer}`;
}

/**
 * Stages and commits itinerary census raw payloads for a timetable edition to git.
 */
export async function commitCensus(
	options: CommitCensusOptions,
): Promise<CommitResult> {
	const cwd = options.cwd ?? process.cwd();
	let resolvedItinerariesDir: string;
	try {
		const safeDataDir = resolveSafePath(options.dataDir, cwd);
		resolvedItinerariesDir = itinerariesDir(safeDataDir, options.version);
	} catch (err) {
		return {
			committed: false,
			reason: `Invalid itineraries directory: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	return commitPath({
		path: resolvedItinerariesDir,
		message: formatCensusCommitMessage({
			timetableVersion: options.version,
			totalTrips: options.totalTrips,
			newlyProbed: options.newlyProbed,
			failedCount: options.failedCount,
		}),
		cwd,
	});
}
