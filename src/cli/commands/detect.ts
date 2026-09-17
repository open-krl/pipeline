import type { CAC } from "cac";
import { executeDetect } from "../../diagnostic/detect";
import { formatDetectReport } from "../../diagnostic/format";
import {
	parseDataDir,
	parseDayType,
	parseIsoDate,
	parseStationCodes,
	parseToleranceSecs,
	parseVersionArg,
} from "../shared/parse";
import { runAction } from "../shared/run";

interface DetectOptions {
	date?: string;
	dayType?: string;
	dbPath?: string;
	raw?: boolean;
	dataDir?: string;
	stations?: string;
	holidaysPath?: string;
	tolerance?: string | number;
	failOnDrift?: boolean;
	json?: boolean;
}

export function registerDetectCommand(cli: CAC): void {
	cli
		.command(
			"detect [version]",
			"Probe corridor hub departure boards for timetable drift (§9, §12)",
		)
		.option("--date <YYYY-MM-DD>", "Target date for day-type resolution")
		.option(
			"--day-type <type>",
			"Explicit day type override (weekday, saturday, sunday, holiday)",
		)
		.option("--db-path <path>", "Override SQLite database path")
		.option("--raw", "Use raw snapshot captures instead of compiled database")
		.option("--data-dir <path>", "Override raw data root directory")
		.option(
			"--stations <codes>",
			"Comma-separated station codes to probe (e.g. MRI,BKS,RK)",
		)
		.option("--holidays-path <path>", "Override holidays file path", {
			default: "data/holidays.json",
		})
		.option(
			"--tolerance <seconds>",
			"Arrival matching tolerance in seconds (default: 900)",
		)
		.option(
			"--fail-on-drift",
			"Exit with code 1 if potential timetable edition drift is detected",
		)
		.option("--json", "Emit structured JSON output")
		.action(async (versionArg: string | undefined, options: DetectOptions) => {
			const version = parseVersionArg(versionArg, "version number");
			const date = parseIsoDate(options.date);
			const dayType = parseDayType(options.dayType);
			const tolerance = parseToleranceSecs(options.tolerance);
			const stations = parseStationCodes(options.stations);
			const dataDir = parseDataDir(options.dataDir);

			await runAction("Drift detection", async () => {
				const result = await executeDetect({
					version,
					date,
					dayType,
					dbPath: options.dbPath,
					dataDir,
					preferSource: options.raw ? "snapshots" : "database",
					stations,
					holidaysPath: options.holidaysPath,
					toleranceSecs: tolerance,
				});

				if (options.json) {
					console.log(JSON.stringify(result, null, 2));
				} else {
					console.log(formatDetectReport(result));
				}

				if (
					options.failOnDrift &&
					result.status === "POTENTIAL_EDITION_DRIFT"
				) {
					process.exit(1);
				}
			});
		});
}
