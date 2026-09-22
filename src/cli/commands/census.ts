import type { CAC } from "cac";
import { executeCensus } from "@/census/census";
import { parseDataDir, parseDayType, parseVersionArg } from "../shared/parse";
import { printSection } from "../shared/report";
import { runAction } from "../shared/run";

interface CensusOptions {
	dayType?: string;
	reprobeAll?: boolean;
	timetableVersion?: string | number;
	dataDir?: string;
	commit?: boolean;
	logFile?: string;
	log?: boolean;
}

export function registerCensusCommand(cli: CAC): void {
	cli
		.command(
			"census [version]",
			"Crawl complete itineraries for newly discovered trips (§8.3)",
		)
		.option(
			"--day-type <type>",
			"Target day type (weekday, saturday, sunday, holiday)",
		)
		.option("--reprobe-all", "Force reprobe all active trains for day type")
		.option(
			"--timetable-version <number>",
			"Specific timetable version (alternative to [version])",
		)
		.option("--data-dir <path>", "Override raw data root directory")
		.option("--commit", "Automatically commit captured itineraries to git")
		.option(
			"--log-file <path>",
			"Custom destination path for structured JSONL logs",
		)
		.option("--no-log", "Disable automatic file logging under logs/")
		.action(async (versionArg: string | undefined, options: CensusOptions) => {
			const dayType = parseDayType(options.dayType);
			const dataDir = parseDataDir(options.dataDir);
			const versionStr =
				options.timetableVersion !== undefined
					? String(options.timetableVersion)
					: versionArg;
			const version = parseVersionArg(versionStr);

			console.log("Starting KRL itinerary census crawl...");
			await runAction("Census", async () => {
				const result = await executeCensus({
					dayType,
					reprobeAll: Boolean(options.reprobeAll),
					version,
					dataDir,
					commit: Boolean(options.commit),
					logFilePath: options.logFile,
					noLog: options.log === false,
				});

				printSection("Census Summary", [
					["Timetable Version", String(result.version)],
					["Day Type", result.dayType],
					["Total Discovered", `${result.totalDiscovered} trains`],
					[
						"Newly Probed",
						`${result.totalProbed} (${result.successCount} OK, ${result.notFoundCount} 404/suspended)`,
					],
					["Already Cached", `${result.cachedCount} trains`],
					["Failed / Errors", `${result.failedCount} trains`],
					[
						"Duration",
						`${result.durationSecs}s${result.logFilePath ? `\nLog File:           ${result.logFilePath}` : ""}`,
					],
				]);

				if (result.commitResult) {
					if (result.commitResult.committed) {
						console.log(
							`Committed census itineraries: ${result.commitResult.commitHash?.slice(0, 7)}`,
						);
					} else {
						console.log(`Git commit skipped: ${result.commitResult.reason}`);
					}
				}
			});
		});
}
