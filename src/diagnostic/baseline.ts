// src/diagnostic/baseline.ts

import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import path from "node:path";
import { scanTimetableVersions } from "../archive/snapshots";
import { resolveSafePath } from "../core/path";

export interface DiagnosticBaselineOptions {
	version?: number;
	dataDir?: string;
	dbPath?: string;
	cwd?: string;
	preferSource?: "database" | "snapshots";
}

export interface DatabaseBaseline {
	source: "database";
	version: number;
	dbPath: string;
}

export interface SnapshotsBaseline {
	source: "snapshots";
	version: number;
	dataDir: string;
}

export type ResolvedDiagnosticBaseline = DatabaseBaseline | SnapshotsBaseline;

/**
 * Scans the build directory for compiled SQLite database files matching `krl_v<version>.db`.
 * Returns sorted ascending array of timetable version numbers.
 */
export async function scanCompiledDatabaseVersions(
	buildDir: string,
): Promise<number[]> {
	try {
		const stat = await fs.stat(buildDir);
		if (!stat.isDirectory()) return [];
	} catch {
		return [];
	}

	const entries = await fs.readdir(buildDir);
	const versions: number[] = [];

	for (const entry of entries) {
		const match = /^krl_v(\d+)\.db$/.exec(entry);
		if (match) {
			versions.push(Number.parseInt(match[1], 10));
		}
	}

	return versions.sort((a, b) => a - b);
}

/**
 * Resolves the operational diagnostic baseline across SQLite compiled database
 * or raw snapshot captures without hardcoding version fallbacks or masking data errors.
 */
export async function resolveDiagnosticBaseline(
	options: DiagnosticBaselineOptions = {},
): Promise<ResolvedDiagnosticBaseline> {
	const cwd = options.cwd ?? process.cwd();
	const buildDir = resolveSafePath("data/build", cwd);
	const defaultRawDir = resolveSafePath("data/raw", cwd);

	// 1. Explicit DB path provided
	if (options.dbPath) {
		const resolvedDb = resolveSafePath(options.dbPath, cwd);
		let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
		try {
			stat = await fs.stat(resolvedDb);
		} catch {
			throw new Error(`Baseline database file not found: ${resolvedDb}`);
		}
		if (!stat.isFile()) {
			throw new Error(`Baseline database path is not a file: ${resolvedDb}`);
		}

		let version = options.version;
		if (version === undefined) {
			const db = new Database(resolvedDb, { readonly: true });
			try {
				const row = db
					.query<{ timetable_version: number }, []>(
						"SELECT timetable_version FROM trips ORDER BY timetable_version DESC LIMIT 1",
					)
					.get();
				if (!row) {
					throw new Error(`Baseline database contains no trips: ${resolvedDb}`);
				}
				version = row.timetable_version;
			} finally {
				db.close();
			}
		}

		return {
			source: "database",
			version,
			dbPath: resolvedDb,
		};
	}

	// 2. Explicit raw dataDir provided
	if (options.dataDir) {
		const resolvedRawDir = resolveSafePath(options.dataDir, cwd);
		let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
		try {
			stat = await fs.stat(resolvedRawDir);
		} catch {
			throw new Error(
				`Baseline raw data directory not found: ${resolvedRawDir}`,
			);
		}
		if (!stat.isDirectory()) {
			throw new Error(
				`Baseline data path is not a directory: ${resolvedRawDir}`,
			);
		}

		let version = options.version;
		const versions = await scanTimetableVersions(resolvedRawDir);
		if (version === undefined) {
			if (versions.length === 0) {
				throw new Error(
					`No timetable versions found in raw data directory: ${resolvedRawDir}`,
				);
			}
			version = versions[versions.length - 1];
		} else if (!versions.includes(version)) {
			throw new Error(
				`Timetable version ${version} not found in raw data directory: ${resolvedRawDir}`,
			);
		}

		return {
			source: "snapshots",
			version,
			dataDir: resolvedRawDir,
		};
	}

	// 3. Dynamic resolution: check database vs snapshots based on preference
	const preferDatabase = options.preferSource !== "snapshots";

	if (preferDatabase) {
		const dbResult = await tryResolveDatabase(buildDir, options.version);
		if (dbResult) return dbResult;

		const snapResult = await tryResolveSnapshots(
			defaultRawDir,
			options.version,
		);
		if (snapResult) return snapResult;
	} else {
		const snapResult = await tryResolveSnapshots(
			defaultRawDir,
			options.version,
		);
		if (snapResult) return snapResult;

		const dbResult = await tryResolveDatabase(buildDir, options.version);
		if (dbResult) return dbResult;
	}

	throw new Error(
		`No timetable baseline found for version ${options.version ?? "latest"} in build databases (${buildDir}) or raw snapshots (${defaultRawDir}).`,
	);
}

async function tryResolveDatabase(
	buildDir: string,
	targetVersion?: number,
): Promise<DatabaseBaseline | null> {
	if (targetVersion !== undefined) {
		const dbPath = path.join(buildDir, `krl_v${targetVersion}.db`);
		try {
			const stat = await fs.stat(dbPath);
			if (stat.isFile()) {
				return { source: "database", version: targetVersion, dbPath };
			}
		} catch {
			return null;
		}
		return null;
	}

	const versions = await scanCompiledDatabaseVersions(buildDir);
	if (versions.length > 0) {
		const latest = versions[versions.length - 1];
		const dbPath = path.join(buildDir, `krl_v${latest}.db`);
		return { source: "database", version: latest, dbPath };
	}

	return null;
}

async function tryResolveSnapshots(
	rawDir: string,
	targetVersion?: number,
): Promise<SnapshotsBaseline | null> {
	try {
		const stat = await fs.stat(rawDir);
		if (!stat.isDirectory()) return null;
	} catch {
		return null;
	}

	if (targetVersion !== undefined) {
		const versions = await scanTimetableVersions(rawDir);
		if (versions.includes(targetVersion)) {
			return { source: "snapshots", version: targetVersion, dataDir: rawDir };
		}
		return null;
	}

	const versions = await scanTimetableVersions(rawDir);
	if (versions.length > 0) {
		const latest = versions[versions.length - 1];
		return { source: "snapshots", version: latest, dataDir: rawDir };
	}

	return null;
}
