import type { CAC } from "cac";
import { commitCaptureSnapshot, executeCapture } from "../../capture/capture";
import { confirm } from "../../core/prompt";
import { parseDataDir, parseDayType, parseRegion } from "../shared/parse";

interface CaptureOptions {
	dayType?: string;
	region?: string;
	newVersion?: boolean;
	yes?: boolean;
	dataDir?: string;
	commit?: boolean;
	logFile?: string;
	log?: boolean;
}

export function registerCaptureCommand(cli: CAC): void {
	cli
		.command(
			"capture",
			"Fetch station catalog & boards with version gating (§8.1)",
		)
		.option(
			"--day-type <type>",
			"Force day type (weekday, saturday, sunday, holiday)",
		)
		.option(
			"--region <region>",
			"Region scope (jabodetabek, yogyakarta, all)",
			{
				default: "jabodetabek",
			},
		)
		.option(
			"--new-version",
			"Force bumping to next timetable version (<version + 1>)",
		)
		.option("--yes", "Non-interactive execution (fails on gate alerts)")
		.option("--data-dir <path>", "Override raw data root directory", {
			default: "data/raw",
		})
		.option(
			"--commit",
			"Automatically commit captured snapshot to git (use --no-commit to skip)",
		)
		.option(
			"--log-file <path>",
			"Custom destination path for structured JSONL logs",
		)
		.option("--no-log", "Disable automatic file logging under logs/")
		.action(async (options: CaptureOptions) => {
			const dayType = parseDayType(options.dayType);
			const region = parseRegion(options.region);
			const dataDir = parseDataDir(options.dataDir);
			const commit = options.commit === true ? true : undefined;
			const noCommit = options.commit === false;

			console.log("Starting KRL schedule capture pipeline...");
			const result = await executeCapture({
				dayType,
				region,
				newVersion: options.newVersion,
				yes: options.yes,
				dataDir,
				commit,
				noCommit,
				logFilePath: options.logFile,
				noLog: options.log === false,
			});

			console.log(
				`Capture successful: version ${result.timetable_version}, snapshot ${result.snapshot_id} (${result.manifest.day_type}, ${result.manifest.status})`,
			);
			console.log(`Saved snapshot to: ${result.snapshot_dir}`);

			if (!commit && !noCommit && process.stdin.isTTY && !options.yes) {
				if (await confirm("\nCommit snapshot to git repository? [Y/n] ")) {
					const commitResult = await commitCaptureSnapshot({
						snapshotDir: result.snapshot_dir,
						manifest: result.manifest,
					});
					if (commitResult.committed) {
						console.log(
							`[Git] Committed snapshot to git: ${commitResult.commitHash?.slice(0, 7)}`,
						);
					} else {
						console.warn(
							`[Git] Notice: Snapshot not committed: ${commitResult.reason}`,
						);
					}
				}
			}
		});
}
