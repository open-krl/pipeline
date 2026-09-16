#!/usr/bin/env bun
// src/cli.ts
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { type DayType, DayTypeSchema } from "./api/schemas";
import {
	executeCapture,
	scanSnapshots,
	scanTimetableVersions,
} from "./commands/capture";
import { formatSnapshotTable, getSnapshotList } from "./commands/snapshots";
import { type RegionScope, RegionScopeSchema } from "./config";
import { commitCaptureSnapshot } from "./core/git";

async function main() {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "--help" || command === "-h") {
		console.log(`
KRL Schedule Pipeline CLI

Usage:
  bun src/cli.ts <command> [options]

Commands:
  capture          Fetch station catalog & boards with version gating (§8.1)
  commit-snapshot  Commit a raw capture snapshot to git repository
  list-snapshots   List captured timetable snapshots and their git archive status
  census           Crawl complete itineraries for newly discovered trips (§8.3)
  build            Compile SQLite database, resolve services & presence (§10)
  export           Generate standard GTFS feeds (§11)
  calendar         Update statutory holiday definitions (§10.2)
  detect           Probe corridor hubs for timetable drift (§12)

Capture Options:
  --day-type <type>    Force day type (weekday, saturday, sunday, holiday)
  --region <region>    Region scope (jabodetabek, yogyakarta, all) [default: jabodetabek]
  --new-version        Force bumping to next timetable version (<version + 1>)
  --yes                Non-interactive execution (fails on gate alerts)
  --data-dir <path>    Override raw data root directory [default: data/raw]
  --commit             Automatically commit captured snapshot to git
  --no-commit          Skip committing snapshot to git

Commit Snapshot Usage:
  bun src/cli.ts commit-snapshot [version] [snapshot_id] [--data-dir <path>]

List Snapshots Usage:
  bun src/cli.ts list-snapshots [version] [--data-dir <path>]
`);
		process.exit(0);
	}

	switch (command) {
		case "capture": {
			const { values } = parseArgs({
				args: args.slice(1),
				options: {
					"day-type": { type: "string" },
					region: { type: "string" },
					"new-version": { type: "boolean", default: false },
					yes: { type: "boolean", default: false },
					"data-dir": { type: "string" },
					commit: { type: "boolean", default: false },
					"no-commit": { type: "boolean", default: false },
				},
				allowPositionals: false,
			});

			let dayType: DayType | undefined;
			if (values["day-type"]) {
				const res = DayTypeSchema.safeParse(values["day-type"]);
				if (!res.success) {
					console.error(
						`Error: Invalid --day-type '${values["day-type"]}'. Allowed values: ${Object.values(DayTypeSchema.enum).join(", ")}`,
					);
					process.exit(1);
				}
				dayType = res.data;
			}

			let region: RegionScope | undefined;
			if (values.region) {
				const res = RegionScopeSchema.safeParse(values.region);
				if (!res.success) {
					console.error(
						`Error: Invalid --region '${values.region}'. Allowed values: ${Object.values(RegionScopeSchema.enum).join(", ")}`,
					);
					process.exit(1);
				}
				region = res.data;
			}

			const newVersion = values["new-version"];
			const yes = values.yes;
			const dataDir = values["data-dir"];
			const commit = values.commit ? true : undefined;
			const noCommit = values["no-commit"];

			console.log("Starting KRL schedule capture pipeline...");
			const result = await executeCapture({
				dayType,
				region,
				newVersion,
				yes,
				dataDir,
				commit,
				noCommit,
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
			break;
		}

		case "commit-snapshot": {
			const { values, positionals } = parseArgs({
				args: args.slice(1),
				options: {
					"data-dir": { type: "string" },
				},
				allowPositionals: true,
			});

			const dataDir =
				values["data-dir"] ?? path.resolve(process.cwd(), "data/raw");
			let version: number;
			let snapshotId: number;

			if (positionals.length >= 2) {
				version = Number.parseInt(positionals[0], 10);
				snapshotId = Number.parseInt(positionals[1], 10);
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
			break;
		}

		case "list-snapshots": {
			const { values, positionals } = parseArgs({
				args: args.slice(1),
				options: {
					"data-dir": { type: "string" },
				},
				allowPositionals: true,
			});

			const dataDir = values["data-dir"];
			const version =
				positionals.length > 0
					? Number.parseInt(positionals[0], 10)
					: undefined;

			const entries = await getSnapshotList({ dataDir, version });
			console.log(`\n${formatSnapshotTable(entries)}\n`);
			break;
		}

		case "census":
		case "build":
		case "export":
		case "calendar":
		case "detect": {
			console.log(
				`Command '${command}' will be implemented in upcoming milestone.`,
			);
			break;
		}

		default: {
			console.error(`Unknown command: '${command}'. Use --help for usage.`);
			process.exit(1);
		}
	}
}

main().catch((err) => {
	console.error(
		"Error executing command:",
		err instanceof Error ? err.message : err,
	);
	process.exit(1);
});
