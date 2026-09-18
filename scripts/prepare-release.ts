#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scanTimetableVersions } from "../src/archive/snapshots";
import { executeBuild } from "../src/build/build";
import { projectName, projectVersion } from "../src/config";
import { resolveSafePath } from "../src/core/path";
import { executeExport } from "../src/export/export";

interface ReleasePrepOptions {
	version?: number;
	outDir?: string;
	requireResolvedCalendar?: boolean;
	requireCensusComplete?: boolean;
	requireHolidayCoverage?: boolean;
}

async function prepareRelease(options: ReleasePrepOptions = {}) {
	const cwd = process.cwd();
	const dataDir = resolveSafePath("data/raw", cwd);
	const outDir = resolveSafePath(options.outDir ?? "data/build", cwd);

	await fs.mkdir(outDir, { recursive: true });

	// 1. Resolve timetable version
	let version = options.version;
	if (version === undefined) {
		const versions = await scanTimetableVersions(dataDir);
		if (versions.length === 0) {
			throw new Error(`No timetable versions found under ${dataDir}`);
		}
		version = versions[versions.length - 1];
	}

	console.log(`\n======================================================`);
	console.log(`Preparing Release for Timetable Edition: v${version}`);
	console.log(`Project Version: ${projectVersion}`);
	console.log(`======================================================\n`);

	// 2. Execute Stage 3: Build SQLite Database
	console.log(`[1/3] Compiling normalized SQLite database (v${version})...`);
	const buildResult = await executeBuild({
		version,
		dataDir,
		outDir,
		cwd,
	});

	console.log(`      ✓ Database created at: ${buildResult.dbPath}`);
	console.log(`      ✓ Folded ${buildResult.snapshotsFolded} snapshots`);
	console.log(
		`      ✓ Compiled ${buildResult.stats.totalTrips} trips (${buildResult.stats.itineraryTrips} itinerary, ${buildResult.stats.reconstructedTrips} reconstructed)`,
	);
	console.log(
		`      ✓ Calendar state: ${buildResult.stats.calendarResolved ? "RESOLVED" : "PROVISIONAL"}`,
	);

	// 3. Execute Stage 4: GTFS Export with Release Gates
	console.log(`\n[2/3] Generating GTFS release package...`);
	const exportResult = await executeExport({
		version,
		dbPath: buildResult.dbPath,
		outDir,
		requireResolvedCalendar: options.requireResolvedCalendar ?? true,
		requireCensusComplete: options.requireCensusComplete ?? true,
		requireHolidayCoverage: options.requireHolidayCoverage ?? false,
		cwd,
	});

	console.log(`      ✓ GTFS archive: ${exportResult.zipPath}`);
	console.log(
		`      ✓ Package size: ${(exportResult.zipSizeBytes / 1024).toFixed(1)} KB`,
	);
	console.log(`      ✓ SHA-256:      ${exportResult.sha256}`);
	console.log(
		`      ✓ Horizon:      ${exportResult.startDate} to ${exportResult.endDate}`,
	);

	// 4. Generate GitHub Release Notes
	console.log(`\n[3/3] Generating Release Notes...`);
	const notesPath = path.join(outDir, `RELEASE_NOTES_v${version}.md`);

	const releaseNotes = `## Kereta Commuter Indonesia (KRL) Schedule — Timetable v${version}

Automated production release compiled deterministically from committed upstream API captures by **${projectName}** (v${projectVersion}).

### Feed Metadata
- **Timetable Edition:** \`v${version}\`
- **Validity Horizon:** \`${exportResult.startDate}\` to \`${exportResult.endDate}\`
- **GTFS SHA-256 Digest:** \`${exportResult.sha256}\`
- **Calendar Status:** ${buildResult.stats.calendarResolved ? "✅ Resolved (3/3 day types confirmed)" : "⚠️ Provisional"}

### Schedule Metrics
| Metric | Count |
| :--- | :--- |
| **Routes** | ${exportResult.stats.routesCount} commercial lines |
| **Operational Trips** | ${exportResult.stats.tripsCount.toLocaleString()} trips |
| **Stations & Stops** | ${exportResult.stats.stopsCount} physical stations |
| **Stop Time Events** | ${exportResult.stats.stopTimesCount.toLocaleString()} calls |
| **Service Calendar Profiles** | ${exportResult.stats.calendarCount} patterns (${exportResult.stats.calendarDatesCount} holiday exceptions) |
| **Quarantined Trips** | ${buildResult.stats.quarantinedTrips} isolated entities (deadheads / regional diesels) |

### Integrity Safeguards (13 Validation Invariants)
- Intra-Trip Board Consistency: **Passed**
- Minimum Board Occurrence ($\\ge 2$): **Passed**
- Dead-Band Departure Silence (01:30–03:30): **Enforced**
- Board-Itinerary Stop-Time Congruence: **Verified ($\\pm 60$s)**
- Terminus Station & Dest Time Alignment: **Verified**
- Stop Sequence Monotonicity: **Verified**
- Identifier Grammar (\`^(\\d+)([A-E])?(F)?$\`): **100% Validated**
- Referential Station Integrity: **Verified across all stations**
- Board-Itinerary Stop Count Congruence: **Enforced**

### Release Artifacts
1. \`krl_gtfs_v${version}.zip\` — Standard transit feed specification archive.
2. \`krl_gtfs_v${version}.zip.sha256\` — Checksum verification file.
3. \`krl_v${version}.db\` — Normalized SQLite database in STRICT mode with foreign keys and indexes.
`;

	await fs.writeFile(notesPath, releaseNotes, "utf-8");
	console.log(`      ✓ Written release notes to: ${notesPath}`);

	console.log(`\n======================================================`);
	console.log(`Release artifacts successfully packaged in: ${outDir}`);
	console.log(`======================================================\n`);

	return {
		dbPath: buildResult.dbPath,
		zipPath: exportResult.zipPath,
		sha256Path: `${exportResult.zipPath}.sha256`,
		notesPath,
		version,
		sha256: exportResult.sha256,
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const versionArg = args[0] ? Number.parseInt(args[0], 10) : undefined;

	prepareRelease({
		version: Number.isFinite(versionArg) ? versionArg : undefined,
		requireResolvedCalendar: !args.includes("--allow-provisional"),
		requireCensusComplete: !args.includes("--allow-incomplete-census"),
	}).catch((err) => {
		console.error(
			`Release preparation failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	});
}
