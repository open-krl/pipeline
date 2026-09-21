#!/usr/bin/env bun
/**
 * scripts/release-prepare.ts
 *
 * Orchestrates the deterministic release pipeline:
 *   1. Resolves the target timetable version.
 *   2. Executes Stage 3 (build) — pure functional fold → SQLite.
 *   3. Executes Stage 4 (export) — GTFS CSV generation → ZIP + SHA-256.
 *   4. Generates structured GitHub Release Notes from actual build/export results.
 *
 * Flags:
 *   <version>                   Explicit timetable version (positive integer).
 *   --allow-provisional         Skip the resolved-calendar release gate.
 *   --allow-incomplete-census   Skip the census-complete release gate.
 *   --out-dir <path>            Override output directory (default: data/build).
 *
 * Exit codes:
 *   0  Success.
 *   1  Validation, build, or export failure.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scanTimetableVersions } from "../src/archive/snapshots";
import { executeBuild } from "../src/build/build";
import { projectName, projectVersion } from "../src/config";
import { resolveSafePath } from "../src/core/path";
import { executeExport } from "../src/export/export";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReleasePrepOptions {
	version?: number;
	outDir?: string;
	requireResolvedCalendar?: boolean;
	requireCensusComplete?: boolean;
	requireHolidayCoverage?: boolean;
}

interface ArtifactPaths {
	dbPath: string;
	zipPath: string;
	sha256Path: string;
	notesPath: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function printBanner(title: string): void {
	const line = "=".repeat(60);
	console.log(`\n${line}`);
	console.log(`  ${title}`);
	console.log(`${line}\n`);
}

function printStep(step: number, total: number, message: string): void {
	console.log(`  [${step}/${total}] ${message}`);
}

function printOk(message: string): void {
	console.log(`       ✓ ${message}`);
}

function printWarn(message: string): void {
	console.warn(`       ⚠ ${message}`);
}

/**
 * Strictly validates that a string is a positive integer (no floats, no signs).
 */
function parseStrictVersion(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) {
		return undefined;
	}
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Cleans the output directory of stale artifacts matching the version pattern
 * to prevent picking up files from a prior run.
 */
async function cleanOutputDir(outDir: string, version: number): Promise<void> {
	const patterns = [
		`krl_v${version}.db`,
		`krl_gtfs_v${version}.zip`,
		`krl_gtfs_v${version}.zip.sha256`,
		`RELEASE_NOTES_v${version}.md`,
	];
	for (const name of patterns) {
		const filePath = path.join(outDir, name);
		await fs.rm(filePath, { force: true }).catch(() => {});
	}
}

/**
 * Generates release notes from actual build and export results rather than
 * hardcoding invariant pass/fail text.
 */
function buildReleaseNotes(params: {
	version: number;
	buildResult: {
		snapshotsFolded: number;
		stats: {
			totalTrips: number;
			itineraryTrips: number;
			reconstructedTrips: number;
			quarantinedTrips: number;
			calendarResolved: boolean;
			dayTypesCaptured: number;
		};
	};
	exportResult: {
		zipPath: string;
		zipSizeBytes: number;
		sha256: string;
		startDate: string;
		endDate: string;
		stats: {
			routesCount: number;
			tripsCount: number;
			stopsCount: number;
			stopTimesCount: number;
			calendarCount: number;
			calendarDatesCount: number;
		};
		warnings: string[];
	};
}): string {
	const { version, buildResult, exportResult } = params;
	const calendarLabel = buildResult.stats.calendarResolved
		? "✅ Resolved (3/3 day types confirmed)"
		: `⚠️ Provisional (${buildResult.stats.dayTypesCaptured}/3 day types)`;

	const warningSection =
		exportResult.warnings.length > 0
			? `\n### Audit Warnings\n${exportResult.warnings.map((w) => `- ⚠️ ${w}`).join("\n")}\n`
			: "";

	return `## Kereta Commuter Indonesia (KRL) Schedule — Timetable v${version}

Automated production release compiled deterministically from committed upstream API captures by **${projectName}** (v${projectVersion}).

### Feed Metadata

| Property | Value |
| :--- | :--- |
| **Timetable Edition** | \`v${version}\` |
| **Validity Horizon** | \`${exportResult.startDate}\` → \`${exportResult.endDate}\` |
| **GTFS SHA-256 Digest** | \`${exportResult.sha256}\` |
| **Calendar Status** | ${calendarLabel} |
| **Snapshots Folded** | ${buildResult.snapshotsFolded} |

### Schedule Metrics

| Metric | Count |
| :--- | :--- |
| **Routes** | ${exportResult.stats.routesCount} commercial lines |
| **Operational Trips** | ${exportResult.stats.tripsCount.toLocaleString()} |
| **Stations & Stops** | ${exportResult.stats.stopsCount} |
| **Stop Time Events** | ${exportResult.stats.stopTimesCount.toLocaleString()} |
| **Service Calendar Profiles** | ${exportResult.stats.calendarCount} patterns (${exportResult.stats.calendarDatesCount} holiday exceptions) |
| **Itinerary Trips** | ${buildResult.stats.itineraryTrips.toLocaleString()} |
| **Reconstructed Trips** | ${buildResult.stats.reconstructedTrips} |
| **Quarantined Entities** | ${buildResult.stats.quarantinedTrips} (deadheads / regional diesels) |

### Integrity Safeguards

All 13 validation invariants were evaluated during the build fold.
The build completed **without invariant violations** — any violation halts compilation.

1. Intra-Trip Board Consistency
2. Minimum Board Occurrence (≥ 2)
3. Dead-Band Departure Silence (01:30–03:30)
4. Board-Itinerary Stop-Time Congruence (± 60 s)
5. Terminus Station & Dest-Time Alignment
6. Stop Sequence Monotonicity
7. Identifier Grammar (\`^(\\d+)([A-E])?(F)?$\`)
8. Cross-Capture Suffix Transition Bounds
9. Referential Station Integrity
10. Atomic Capture Integrity
11. Cross-Capture Edition Consistency
12. Cross-Capture Trip-Attribute Consistency
13. Board-Itinerary Stop Count Congruence
${warningSection}
### Release Artifacts

| File | Description |
| :--- | :--- |
| \`krl_gtfs_v${version}.zip\` | Standard GTFS transit feed archive |
| \`krl_gtfs_v${version}.zip.sha256\` | SHA-256 checksum verification file |
| \`krl_v${version}.db\` | Normalized SQLite database (STRICT mode, WAL, FK) |

---
*Generated by ${projectName} v${projectVersion} on ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}*
`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function prepareRelease(
	options: ReleasePrepOptions = {},
): Promise<ArtifactPaths> {
	const cwd = process.cwd();
	const dataDir = resolveSafePath("data/raw", cwd);
	const outDir = resolveSafePath(options.outDir ?? "data/build", cwd);

	// 1. Resolve timetable version
	let version = options.version;
	if (version === undefined) {
		const versions = await scanTimetableVersions(dataDir);
		if (versions.length === 0) {
			throw new Error(`No timetable versions found under ${dataDir}`);
		}
		version = versions[versions.length - 1];
	}

	printBanner(`Preparing Release — Timetable Edition v${version}`);
	console.log(`  Project:  ${projectName} v${projectVersion}`);
	console.log(`  Data Dir: ${dataDir}`);
	console.log(`  Out Dir:  ${outDir}`);
	console.log("");

	// 2. Clean stale artifacts for this version
	await fs.mkdir(outDir, { recursive: true });
	await cleanOutputDir(outDir, version);

	// 3. Execute Stage 3: Build SQLite Database
	printStep(1, 3, `Compiling normalized SQLite database (v${version})...`);
	const buildResult = await executeBuild({
		version,
		dataDir,
		outDir,
		cwd,
	});

	printOk(`Database: ${buildResult.dbPath}`);
	printOk(`Snapshots folded: ${buildResult.snapshotsFolded}`);
	printOk(
		`Trips: ${buildResult.stats.totalTrips} ` +
			`(${buildResult.stats.itineraryTrips} itinerary, ${buildResult.stats.reconstructedTrips} reconstructed)`,
	);
	printOk(
		`Calendar: ${buildResult.stats.calendarResolved ? "RESOLVED" : "PROVISIONAL"} ` +
			`(${buildResult.stats.dayTypesCaptured}/3 day types)`,
	);
	printOk(`Quarantined: ${buildResult.stats.quarantinedTrips} entities`);

	// 4. Execute Stage 4: GTFS Export with Release Gates
	printStep(2, 3, "Generating GTFS release package...");
	const exportResult = await executeExport({
		version,
		dbPath: buildResult.dbPath,
		outDir,
		requireResolvedCalendar: options.requireResolvedCalendar ?? true,
		requireCensusComplete: options.requireCensusComplete ?? true,
		requireHolidayCoverage: options.requireHolidayCoverage ?? false,
		cwd,
	});

	printOk(`GTFS archive: ${exportResult.zipPath}`);
	printOk(`Package size: ${(exportResult.zipSizeBytes / 1024).toFixed(1)} KB`);
	printOk(`SHA-256: ${exportResult.sha256}`);
	printOk(`Horizon: ${exportResult.startDate} → ${exportResult.endDate}`);

	if (exportResult.warnings.length > 0) {
		for (const warning of exportResult.warnings) {
			printWarn(warning);
		}
	}

	// 5. Generate Release Notes
	printStep(3, 3, "Generating release notes...");
	const notesPath = path.join(outDir, `RELEASE_NOTES_v${version}.md`);
	const releaseNotes = buildReleaseNotes({
		version,
		buildResult,
		exportResult,
	});
	await fs.writeFile(notesPath, releaseNotes, "utf-8");
	printOk(`Written: ${notesPath}`);

	// 6. Emit machine-readable artifact version for CI parsing
	console.log(`\nARTIFACT_VERSION=${version}`);

	printBanner("Release artifacts successfully packaged");

	return {
		dbPath: buildResult.dbPath,
		zipPath: exportResult.zipPath,
		sha256Path: `${exportResult.zipPath}.sha256`,
		notesPath,
	};
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

if (import.meta.main) {
	const args = process.argv.slice(2);

	// Parse positional version argument
	let versionArg: number | undefined;
	const positionalArgs = args.filter((a) => !a.startsWith("--"));
	if (positionalArgs.length > 0) {
		versionArg = parseStrictVersion(positionalArgs[0]);
		if (versionArg === undefined) {
			console.error(
				`Error: Invalid version argument '${positionalArgs[0]}'. Must be a positive integer.`,
			);
			process.exit(1);
		}
	}

	// Parse flags
	const allowProvisional = args.includes("--allow-provisional");
	const allowIncompleteCensus = args.includes("--allow-incomplete-census");

	// Parse --out-dir
	const outDirIdx = args.indexOf("--out-dir");
	const outDir = outDirIdx !== -1 ? args[outDirIdx + 1] : undefined;

	prepareRelease({
		version: versionArg,
		outDir,
		requireResolvedCalendar: !allowProvisional,
		requireCensusComplete: !allowIncompleteCensus,
	}).catch((err) => {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`\n✗ Release preparation failed: ${message}`);
		if (err instanceof Error && err.stack) {
			console.error(`  Stack: ${err.stack.split("\n").slice(1, 4).join("\n")}`);
		}
		process.exit(1);
	});
}
