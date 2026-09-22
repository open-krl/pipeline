import type { CAC } from "cac";
import { executeExport } from "@/export/export";
import { parseVersionArg } from "../shared/parse";
import { printSection } from "../shared/report";
import { runAction } from "../shared/run";

interface ExportOptions {
	dbPath?: string;
	outDir?: string;
	startDate?: string;
	endDate?: string;
	requireResolvedCalendar?: boolean;
	requireCensusComplete?: boolean;
	requireHolidayCoverage?: boolean;
	dumpCsv?: string;
}

export function registerExportCommand(cli: CAC): void {
	cli
		.command(
			"export [version]",
			"Generate standard GTFS specification feed package (§9, §11)",
		)
		.option("--db-path <path>", "Override SQLite database path")
		.option("--out-dir <path>", "Override output directory", {
			default: "data/build",
		})
		.option(
			"--start-date <date>",
			"Feed validity start date (YYYY-MM-DD or YYYYMMDD)",
		)
		.option(
			"--end-date <date>",
			"Feed validity end date (YYYY-MM-DD or YYYYMMDD)",
		)
		.option(
			"--require-resolved-calendar",
			"Fail if calendar state is provisional (all 3 day types required)",
		)
		.option(
			"--require-census-complete",
			"Fail if any trips remain with itinerary_status = 'unprobed'",
		)
		.option(
			"--require-holiday-coverage",
			"Fail if feed end date exceeds covered statutory holiday decrees",
		)
		.option("--dump-csv <dir>", "Dump uncompressed GTFS CSV files to directory")
		.action(async (versionArg: string | undefined, options: ExportOptions) => {
			const version = parseVersionArg(versionArg);

			console.log("Starting KRL GTFS feed export...");
			await runAction("Export", async () => {
				const result = await executeExport({
					version,
					dbPath: options.dbPath,
					outDir: options.outDir,
					startDate: options.startDate,
					endDate: options.endDate,
					requireResolvedCalendar: options.requireResolvedCalendar,
					requireCensusComplete: options.requireCensusComplete,
					requireHolidayCoverage: options.requireHolidayCoverage,
					dumpCsvDir: options.dumpCsv,
				});

				printSection("Export Summary", [
					["Timetable Version", String(result.timetableVersion)],
					[
						"Archive Target",
						`${result.zipPath} (${(result.zipSizeBytes / 1024).toFixed(1)} KB)`,
					],
					["SHA-256 Digest", result.sha256],
					["Validity Horizon", `${result.startDate} to ${result.endDate}`],
					["Routes Compiled", String(result.stats.routesCount)],
					["Trips Exported", result.stats.tripsCount.toLocaleString()],
					["Stops Exported", String(result.stats.stopsCount)],
					["Stop Times Rows", result.stats.stopTimesCount.toLocaleString()],
					[
						"Calendar Profiles",
						`${result.stats.calendarCount} (${result.stats.calendarDatesCount} holiday exceptions)`,
					],
					["Export Time", `${result.durationSecs}s`],
				]);

				for (const warning of result.warnings) {
					console.warn(`[Warning] ${warning}`);
				}
			});
		});
}
