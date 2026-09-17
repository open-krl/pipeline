#!/usr/bin/env bun
// src/cli.ts
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { cac } from "cac";
import { type DayType, DayTypeSchema } from "./archive/schemas";
import { scanSnapshots, scanTimetableVersions } from "./archive/snapshots";
import { executeBuild } from "./build/build";
import { commitCaptureSnapshot, executeCapture } from "./capture/capture";
import { formatSnapshotTable, getSnapshotList } from "./capture/snapshots";
import { executeCensus } from "./census/census";
import { type RegionScope, RegionScopeSchema } from "./config";
import { resolveSafePath } from "./core/path";

export function createCli() {
	const cli = cac("krl");

	// 1. capture
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
		.action(
			async (options: {
				dayType?: string;
				region?: string;
				newVersion?: boolean;
				yes?: boolean;
				dataDir?: string;
				commit?: boolean;
				logFile?: string;
				log?: boolean;
			}) => {
				let dayType: DayType | undefined;
				if (options.dayType) {
					const res = DayTypeSchema.safeParse(options.dayType);
					if (!res.success) {
						console.error(
							`Error: Invalid --day-type '${options.dayType}'. Allowed values: ${Object.values(DayTypeSchema.enum).join(", ")}`,
						);
						process.exit(1);
					}
					dayType = res.data;
				}

				let region: RegionScope | undefined;
				if (options.region) {
					const res = RegionScopeSchema.safeParse(options.region);
					if (!res.success) {
						console.error(
							`Error: Invalid --region '${options.region}'. Allowed values: ${Object.values(RegionScopeSchema.enum).join(", ")}`,
						);
						process.exit(1);
					}
					region = res.data;
				}

				const newVersion = options.newVersion;
				const yes = options.yes;
				let dataDir: string | undefined;
				if (options.dataDir) {
					try {
						dataDir = resolveSafePath(options.dataDir);
					} catch (err) {
						console.error(
							`Error: ${err instanceof Error ? err.message : String(err)}`,
						);
						process.exit(1);
					}
				}

				const commit = options.commit === true ? true : undefined;
				const noCommit = options.commit === false;

				console.log("Starting KRL schedule capture pipeline...");
				const result = await executeCapture({
					dayType,
					region,
					newVersion,
					yes,
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

				if (!commit && !noCommit && process.stdin.isTTY && !yes) {
					const rl = readline.createInterface({
						input: process.stdin,
						output: process.stdout,
					});
					try {
						const ans = await rl.question(
							"\nCommit snapshot to git repository? [Y/n] ",
						);
						const trimmed = ans.trim().toLowerCase();
						if (trimmed === "" || trimmed === "y" || trimmed === "yes") {
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
					} finally {
						rl.close();
					}
				}
			},
		);

	// 2. commit-snapshot
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
					console.error(
						`Error: ${err instanceof Error ? err.message : String(err)}`,
					);
					process.exit(1);
				}
				let version: number;
				let snapshotId: number;

				if (versionArg !== undefined && snapshotIdArg !== undefined) {
					if (!/^\d+$/.test(versionArg) || !/^\d+$/.test(snapshotIdArg)) {
						console.error(
							"Error: version and snapshotId must be positive integers",
						);
						process.exit(1);
					}
					version = Number.parseInt(versionArg, 10);
					snapshotId = Number.parseInt(snapshotIdArg, 10);
				} else {
					// Detect latest version & snapshot
					const versions = await scanTimetableVersions(dataDir);
					if (versions.length === 0) {
						console.error(`No timetable versions found in ${dataDir}`);
						process.exit(1);
					}
					version = versions[versions.length - 1];
					const snapshots = await scanSnapshots(dataDir, version);
					if (snapshots.length === 0) {
						console.error(
							`No snapshots found under version ${version} in ${dataDir}`,
						);
						process.exit(1);
					}
					snapshotId = snapshots[snapshots.length - 1].id;
				}

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
					console.error(`Commit failed: ${commitResult.reason}`);
					process.exit(1);
				}
			},
		);

	// 3. list-snapshots
	cli
		.command(
			"list-snapshots [version]",
			"List captured timetable snapshots and their git archive status",
		)
		.option("--data-dir <path>", "Override raw data root directory")
		.action(
			async (versionArg: string | undefined, options: { dataDir?: string }) => {
				let dataDir: string | undefined;
				if (options.dataDir) {
					try {
						dataDir = resolveSafePath(options.dataDir);
					} catch (err) {
						console.error(
							`Error: ${err instanceof Error ? err.message : String(err)}`,
						);
						process.exit(1);
					}
				}
				let version: number | undefined;
				if (versionArg !== undefined) {
					if (!/^\d+$/.test(versionArg)) {
						console.error(
							`Error: Invalid version '${versionArg}'. Must be a positive integer.`,
						);
						process.exit(1);
					}
					version = Number.parseInt(versionArg, 10);
				}

				const entries = await getSnapshotList({ dataDir, version });
				console.log(`\n${formatSnapshotTable(entries)}\n`);
			},
		);

	// 4. census
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
		.action(
			async (
				versionArg: string | undefined,
				options: {
					dayType?: string;
					reprobeAll?: boolean;
					timetableVersion?: string | number;
					dataDir?: string;
					commit?: boolean;
					logFile?: string;
					log?: boolean;
				},
			) => {
				let dayType: DayType | undefined;
				if (options.dayType) {
					const res = DayTypeSchema.safeParse(options.dayType);
					if (!res.success) {
						console.error(
							`Error: Invalid --day-type '${options.dayType}'. Allowed values: ${Object.values(DayTypeSchema.enum).join(", ")}`,
						);
						process.exit(1);
					}
					dayType = res.data;
				}

				let dataDir: string | undefined;
				if (options.dataDir) {
					try {
						dataDir = resolveSafePath(options.dataDir);
					} catch (err) {
						console.error(
							`Error: ${err instanceof Error ? err.message : String(err)}`,
						);
						process.exit(1);
					}
				}

				const versionStr =
					options.timetableVersion !== undefined
						? String(options.timetableVersion)
						: versionArg;
				let version: number | undefined;
				if (versionStr !== undefined) {
					if (!/^\d+$/.test(versionStr.trim())) {
						console.error(
							`Error: Invalid version '${versionStr}'. Must be a positive integer.`,
						);
						process.exit(1);
					}
					version = Number.parseInt(versionStr, 10);
				}

				console.log("Starting KRL itinerary census crawl...");
				try {
					const result = await executeCensus({
						dayType,
						reprobeAll: Boolean(options.reprobeAll),
						version,
						dataDir,
						commit: Boolean(options.commit),
						logFilePath: options.logFile,
						noLog: options.log === false,
					});

					const logStr = result.logFilePath
						? `\nLog File:           ${result.logFilePath}`
						: "";

					console.log(`
── Census Summary ───────────────────────────────────────────
Timetable Version:  ${result.version}
Day Type:           ${result.dayType}
Total Discovered:   ${result.totalDiscovered} trains
Newly Probed:       ${result.totalProbed} (${result.successCount} OK, ${result.notFoundCount} 404/suspended)
Already Cached:     ${result.cachedCount} trains
Failed / Errors:    ${result.failedCount} trains
Duration:           ${result.durationSecs}s${logStr}
─────────────────────────────────────────────────────────────
`);
					if (result.commitResult) {
						if (result.commitResult.committed) {
							console.log(
								`Committed census itineraries: ${result.commitResult.commitHash?.slice(0, 7)}`,
							);
						} else {
							console.log(`Git commit skipped: ${result.commitResult.reason}`);
						}
					}
				} catch (err) {
					console.error(
						`Census failed: ${err instanceof Error ? err.message : String(err)}`,
					);
					process.exit(1);
				}
			},
		);

	// 5. build
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
		.action(
			async (
				versionArg: string | undefined,
				options: {
					dataDir?: string;
					outDir?: string;
					dbPath?: string;
					holidaysPath?: string;
					coordinatesPath?: string;
				},
			) => {
				let version: number | undefined;
				if (versionArg !== undefined) {
					const trimmed = versionArg.trim();
					const parsed = Number.parseInt(trimmed, 10);
					if (
						!/^\d+$/.test(trimmed) ||
						!Number.isSafeInteger(parsed) ||
						parsed <= 0
					) {
						console.error(
							`Error: Invalid version '${versionArg}'. Must be a positive integer.`,
						);
						process.exit(1);
					}
					version = parsed;
				}

				console.log("Starting KRL schedule database compilation...");
				try {
					const result = await executeBuild({
						version,
						dataDir: options.dataDir,
						outDir: options.outDir,
						dbPath: options.dbPath,
						holidaysPath: options.holidaysPath,
						coordinatesPath: options.coordinatesPath,
					});

					const stateStr = result.stats.calendarResolved
						? "resolved (3/3 day types confirmed)"
						: `provisional (${result.stats.dayTypesCaptured}/3 day types observed)`;

					console.log(`
── Build Summary ────────────────────────────────────────────
Timetable Version:  ${result.timetableVersion}
Database Target:    ${result.dbPath}
Snapshots Folded:   ${result.snapshotsFolded} complete snapshot(s)
Calendar State:     ${stateStr}
Trips Compiled:     ${result.stats.totalTrips} total (${result.stats.itineraryTrips} itinerary, ${result.stats.reconstructedTrips} reconstructed)
Quarantined Trips:  ${result.stats.quarantinedTrips} (isolated in quarantined_trips table)
Total Stations:     ${result.stats.totalStations} stations
Total Stop Events:  ${result.stats.totalStops.toLocaleString()} stops
Compilation Time:   ${result.durationSecs}s
─────────────────────────────────────────────────────────────
`);
				} catch (err) {
					console.error(
						`Build failed: ${err instanceof Error ? err.message : String(err)}`,
					);
					process.exit(1);
				}
			},
		);

	// 6. Future milestones
	const upcomingCommands = [
		{
			name: "export",
			desc: "Generate standard GTFS feeds (§11)",
		},
		{
			name: "calendar",
			desc: "Inspect three-way day-type set differences & schedule identity report (§9)",
		},
		{
			name: "detect",
			desc: "Probe corridor hubs for timetable drift (§12)",
		},
	];

	for (const { name, desc } of upcomingCommands) {
		cli.command(name, desc).action(() => {
			console.log(
				`Command '${name}' will be implemented in upcoming milestone.`,
			);
		});
	}

	cli.help();
	cli.version("0.1.0");

	return cli;
}

export async function runCli(argv = process.argv) {
	const cli = createCli();
	try {
		cli.parse(argv, { run: false });

		if (cli.options.help || cli.options.version) {
			return;
		}

		if (!cli.matchedCommand) {
			if (cli.args.length > 0) {
				console.error(
					`Unknown command: '${cli.args[0]}'. Use --help for usage.`,
				);
				process.exit(1);
			} else {
				cli.outputHelp();
				process.exit(0);
			}
		}

		await cli.runMatchedCommand();
	} catch (error) {
		console.error(
			`Error: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}

if (import.meta.main) {
	runCli();
}
