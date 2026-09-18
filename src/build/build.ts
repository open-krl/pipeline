// src/build/build.ts
import * as path from "node:path";
import { resolveSafePath } from "../core/path";
import { foldArchive } from "./fold";
import { checkEditionConsistency } from "./invariants";
import { loadRawArchive } from "./load";
import { persistBuildResult } from "./persist";
import type { BuildOptions, BuildResult } from "./types";

/**
 * Stage 3 Runner: Orchestrates loadRawArchive -> Invariant 11 -> foldArchive -> persistBuildResult.
 */
export async function executeBuild(
	options: BuildOptions = {},
): Promise<BuildResult> {
	const startTime = Date.now();
	const cwd = options.cwd ?? process.cwd();

	// 1. Load RawArchive from disk
	const archive = await loadRawArchive(options);

	// 2. Validate Invariant 11: Cross-Capture Edition Consistency (semantic parsed-trip-set check)
	const editionCheck = checkEditionConsistency(archive.snapshots);
	if (!editionCheck.valid) {
		throw new Error(
			`Build halted on Invariant 11 (Cross-Capture Edition Divergence): ${editionCheck.reason}. See Phased Runbook (Section 9) to initialize next timetable version.`,
		);
	}

	// 3. Pure Functional Fold
	const foldResult = foldArchive(archive);

	// 4. Resolve Output Database Path
	let dbPath: string;
	if (options.dbPath) {
		dbPath = resolveSafePath(options.dbPath, cwd);
	} else {
		const outDir = options.outDir
			? resolveSafePath(options.outDir, cwd)
			: path.join(cwd, "data/build");
		dbPath = path.join(outDir, `krl_v${archive.timetableVersion}.db`);
	}

	// 5. Transactional Persistence to SQLite
	persistBuildResult(dbPath, foldResult);

	const durationSecs = Number(((Date.now() - startTime) / 1000).toFixed(2));

	return {
		dbPath,
		timetableVersion: archive.timetableVersion,
		snapshotsFolded: archive.snapshots.length,
		durationSecs,
		stats: foldResult.stats,
	};
}
