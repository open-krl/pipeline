import type { CAC } from "cac";
import {
	analyzeDayTypeCalendar,
	loadCalendarData,
} from "@/diagnostic/calendar";
import { formatCalendarReport } from "@/diagnostic/format";
import { parseToleranceSecs, parseVersionArg } from "../shared/parse";
import { runAction } from "../shared/run";

interface CalendarOptions {
	dataDir?: string;
	dbPath?: string;
	tolerance?: string | number;
	detail?: boolean;
	json?: boolean;
}

export function registerCalendarCommand(cli: CAC): void {
	cli
		.command(
			"calendar [version]",
			"Inspect three-way day-type set differences & schedule identity report (§9)",
		)
		.option("--data-dir <path>", "Override raw data root directory", {
			default: "data/raw",
		})
		.option("--db-path <path>", "Override SQLite database path")
		.option(
			"--tolerance <seconds>",
			"Arrival matching tolerance in seconds (default: 900)",
		)
		.option(
			"--detail",
			"Show detailed line-by-line breakdown and sample services",
		)
		.option("--json", "Emit structured JSON output")
		.action(
			async (versionArg: string | undefined, options: CalendarOptions) => {
				const version = parseVersionArg(versionArg, "version number");
				const tolerance = parseToleranceSecs(options.tolerance);

				await runAction("Calendar analysis", async () => {
					const data = await loadCalendarData({
						version,
						dataDir: options.dataDir,
						dbPath: options.dbPath,
					});

					const result = analyzeDayTypeCalendar({
						timetableVersion: data.version,
						source: data.source,
						weekdayTrips: data.weekdayTrips,
						saturdayTrips: data.saturdayTrips,
						sundayTrips: data.sundayTrips,
						options: { toleranceSecs: tolerance },
					});

					if (options.json) {
						console.log(JSON.stringify(result, null, 2));
					} else {
						console.log(formatCalendarReport(result, options.detail));
					}
				});
			},
		);
}
