import * as path from "node:path";
import type { CAC } from "cac";
import { scanSnapshots, scanTimetableVersions } from "../../archive/snapshots";
import { commitCaptureSnapshot } from "../../capture/capture";
import { resolveSafePath } from "../../core/path";
import { errorMessage, exitError } from "../shared/parse";

export function registerCommitSnapshotCommand(cli: CAC): void {
	cli
		.command(
			"commit-snapshot [version] [snapshotId]",
			"Commit a raw capture snapshot to git repository",
		)
		.option("--data-dir <path>", "Override raw data root directory", {
			default: "data/raw",
		})
		.action(
			async (
				versionArg: string | undefined,
				snapshotIdArg: string | undefined,
				options: { dataDir?: string },
			) => {
				let dataDir: string;
				try {
					dataDir = resolveSafePath(options.dataDir ?? "data/raw");
				} catch (err) {
					exitError(errorMessage(err));
				}

				const { version, snapshotId } = await resolveTarget(
					dataDir,
					versionArg,
					snapshotIdArg,
				);
				const snapshotDir = path.join(
					dataDir,
					String(version),
					"captures",
					String(snapshotId),
				);

				console.log(`Committing snapshot at: ${snapshotDir}`);
				const commitResult = await commitCaptureSnapshot({ snapshotDir });

				if (commitResult.committed) {
					console.log(
						`Successfully committed snapshot: ${commitResult.commitHash?.slice(0, 7)}`,
					);
				} else {
					exitError(`Commit failed: ${commitResult.reason}`);
				}
			},
		);
}

/** Falls back to the latest version & latest snapshot when args are omitted. */
async function resolveTarget(
	dataDir: string,
	versionArg: string | undefined,
	snapshotIdArg: string | undefined,
): Promise<{ version: number; snapshotId: number }> {
	if (versionArg !== undefined && snapshotIdArg !== undefined) {
		if (!/^\d+$/.test(versionArg) || !/^\d+$/.test(snapshotIdArg)) {
			exitError("version and snapshotId must be positive integers");
		}
		return {
			version: Number.parseInt(versionArg, 10),
			snapshotId: Number.parseInt(snapshotIdArg, 10),
		};
	}

	const versions = await scanTimetableVersions(dataDir);
	if (versions.length === 0) {
		exitError(`No timetable versions found in ${dataDir}`);
	}
	const version = versions[versions.length - 1];

	const snapshots = await scanSnapshots(dataDir, version);
	if (snapshots.length === 0) {
		exitError(`No snapshots found under version ${version} in ${dataDir}`);
	}
	return { version, snapshotId: snapshots[snapshots.length - 1].id };
}
