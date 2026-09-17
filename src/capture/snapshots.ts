// src/capture/snapshots.ts
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { CaptureManifest } from "../api/schemas";
import { resolveSafePath } from "../core/path";
import { scanSnapshots, scanTimetableVersions } from "./capture";

const execFileAsync = promisify(execFile);

export interface SnapshotEntry {
	version: number;
	snapshotId: number;
	manifest: CaptureManifest;
	snapshotDir: string;
	gitCommit: string | null;
}

export interface ListSnapshotsOptions {
	dataDir?: string;
	version?: number;
}

/**
 * Resolves the latest git commit affecting a snapshot directory.
 */
export async function resolveSnapshotCommit(
	snapshotDir: string,
	cwd = process.cwd(),
): Promise<string | null> {
	try {
		const safeSnapshotDir = resolveSafePath(snapshotDir, cwd);
		const relativePath = path.relative(cwd, safeSnapshotDir);
		const { stdout } = await execFileAsync(
			"git",
			["log", "-n", "1", "--format=%h", "--", relativePath],
			{ cwd },
		);
		const hash = stdout.trim();
		return hash.length > 0 ? hash : null;
	} catch {
		return null;
	}
}

/**
 * Gathers metadata and git status for all captured snapshots on disk.
 */
export async function getSnapshotList(
	options: ListSnapshotsOptions = {},
	cwd = process.cwd(),
): Promise<SnapshotEntry[]> {
	const dataDir = resolveSafePath(options.dataDir ?? "data/raw", cwd);
	const allVersions = await scanTimetableVersions(dataDir);
	const targetVersions =
		options.version !== undefined
			? allVersions.filter((v) => v === options.version)
			: allVersions;

	const entries: SnapshotEntry[] = [];

	for (const version of targetVersions) {
		const snapshots = await scanSnapshots(dataDir, version);
		for (const snap of snapshots) {
			const snapshotDir = resolveSafePath(
				path.join(dataDir, String(version), "captures", String(snap.id)),
				dataDir,
			);
			const gitCommit = await resolveSnapshotCommit(snapshotDir, cwd);
			entries.push({
				version,
				snapshotId: snap.id,
				manifest: snap.manifest,
				snapshotDir,
				gitCommit,
			});
		}
	}

	return entries;
}

/**
 * Formats snapshot entries into a clean ASCII table.
 */
export function formatSnapshotTable(entries: SnapshotEntry[]): string {
	if (entries.length === 0) {
		return "No timetable snapshots found.";
	}

	const headers = [
		"Snapshot",
		"Date",
		"Day Type",
		"Status",
		"Region",
		"Board Hash",
		"Commit",
	];

	const rows = entries.map((e) => [
		`v${e.version}/${e.snapshotId}`,
		e.manifest.snapshot_date,
		e.manifest.day_type,
		e.manifest.status,
		e.manifest.region_scope,
		`${e.manifest.board_response_hash.slice(0, 8)}...`,
		e.gitCommit ?? "(uncommitted)",
	]);

	// Compute column widths
	const colWidths = headers.map((h, i) => {
		const maxRowLen = rows.reduce((max, r) => Math.max(max, r[i].length), 0);
		return Math.max(h.length, maxRowLen);
	});

	const formatRow = (cols: string[]) =>
		cols.map((c, i) => c.padEnd(colWidths[i])).join("  ");

	const divider = colWidths.map((w) => "─".repeat(w)).join("──");

	return [formatRow(headers), divider, ...rows.map((r) => formatRow(r))].join(
		"\n",
	);
}
