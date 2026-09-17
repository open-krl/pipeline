import type { CAC } from "cac";
import { executeBuild } from "../../build/build";
import { parseVersionArg } from "../shared/parse";
import { printSection } from "../shared/report";
import { runAction } from "../shared/run";

interface BuildOptions {
	dataDir?: string;
	outDir?: string;
	dbPath?: string;
	holidaysPath?: string;
	coordinatesPath?: string;
}

export function registerBuildCommand(cli: CAC): void {
	cli
		.command(
			"build [version]",
			"Compile SQLite database, resolve services & presence (§10)",
		)
		.option("--data-dir <path>", "Override raw data root directory", {
			default: "data/raw",
		})
		.option("--out-dir <path>", "Override build output directory", {
			default: "data/build",
		})
		.option("--db-path <path>", "Override destination SQLite database path")
		.option("--holidays-path <path>", "Override holidays JSON path")
		.option(
			"--coordinates-path <path>",
			"Override station coordinates CSV path",
		)
		.action(async (versionArg: string | undefined, options: BuildOptions) => {
			const version = parseVersionArg(versionArg);

			console.log("Starting KRL schedule database compilation...");
			await runAction("Build", async () => {
				const result = await executeBuild({
					version,
					dataDir: options.dataDir,
					outDir: options.outDir,
					dbPath: options.dbPath,
					holidaysPath: options.holidaysPath,
					coordinatesPath: options.coordinatesPath,
				});

				const calendarState = result.stats.calendarResolved
					? "resolved (3/3 day types confirmed)"
					: `provisional (${result.stats.dayTypesCaptured}/3 day types observed)`;

				printSection("Build Summary", [
					["Timetable Version", String(result.timetableVersion)],
					["Database Target", result.dbPath],
					[
						"Snapshots Folded",
						`${result.snapshotsFolded} complete snapshot(s)`,
					],
					["Calendar State", calendarState],
					[
						"Trips Compiled",
						`${result.stats.totalTrips} total (${result.stats.itineraryTrips} itinerary, ${result.stats.reconstructedTrips} reconstructed)`,
					],
					[
						"Quarantined Trips",
						`${result.stats.quarantinedTrips} (isolated in quarantined_trips table)`,
					],
					["Total Stations", `${result.stats.totalStations} stations`],
					[
						"Total Stop Events",
						`${result.stats.totalStops.toLocaleString()} stops`,
					],
					["Compilation Time", `${result.durationSecs}s`],
				]);
			});
		});
}
