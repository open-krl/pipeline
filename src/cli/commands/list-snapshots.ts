import type { CAC } from "cac";
import { formatSnapshotTable, getSnapshotList } from "../../capture/snapshots";
import { parseDataDir, parseVersionArg } from "../shared/parse";

export function registerListSnapshotsCommand(cli: CAC): void {
	cli
		.command(
			"list-snapshots [version]",
			"List captured timetable snapshots and their git archive status",
		)
		.option("--data-dir <path>", "Override raw data root directory")
		.action(
			async (versionArg: string | undefined, options: { dataDir?: string }) => {
				const dataDir = parseDataDir(options.dataDir);
				const version = parseVersionArg(versionArg);
				const entries = await getSnapshotList({ dataDir, version });
				console.log(`\n${formatSnapshotTable(entries)}\n`);
			},
		);
}
