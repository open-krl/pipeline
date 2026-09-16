#!/usr/bin/env bun
// src/cli.ts
import { parseArgs } from "node:util";
import type { DayType } from "./api/schemas";
import { executeCapture } from "./commands/capture";
import type { RegionScope } from "./config";

async function main() {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "--help" || command === "-h") {
		console.log(`
KRL Schedule Pipeline CLI

Usage:
  bun src/cli.ts <command> [options]

Commands:
  capture     Fetch station catalog & boards with version gating (§8.1)
  census      Crawl complete itineraries for newly discovered trips (§8.3)
  build       Compile SQLite database, resolve services & presence (§10)
  export      Generate standard GTFS feeds (§11)
  calendar    Update statutory holiday definitions (§10.2)
  detect      Probe corridor hubs for timetable drift (§12)

Capture Options:
  --day-type <type>    Force day type (weekday, saturday, sunday, holiday)
  --region <region>    Region scope (jabodetabek, yogyakarta, all) [default: jabodetabek]
  --new-version        Force bumping to next timetable version (<version + 1>)
  --yes                Non-interactive execution (fails on gate alerts)
  --data-dir <path>    Override raw data root directory [default: data/raw]
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
				},
				allowPositionals: false,
			});

			const dayType = values["day-type"] as DayType | undefined;
			const region = values.region as RegionScope | undefined;
			const newVersion = values["new-version"];
			const yes = values.yes;
			const dataDir = values["data-dir"];

			console.log("Starting KRL schedule capture pipeline...");
			const result = await executeCapture({
				dayType,
				region,
				newVersion,
				yes,
				dataDir,
			});

			console.log(
				`Capture successful: version ${result.timetable_version}, snapshot ${result.snapshot_id} (${result.manifest.day_type}, ${result.manifest.status})`,
			);
			console.log(`Saved snapshot to: ${result.snapshot_dir}`);
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
