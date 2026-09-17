import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type CaptureManifest,
	CaptureManifestSchema,
} from "../archive/schemas";
import { type CommitResult, commitPath } from "../core/git";
import { resolveSafePath } from "../core/path";

export type CommitSnapshotResult = CommitResult;

export interface CommitSnapshotOptions {
	snapshotDir: string;
	manifest?: CaptureManifest;
	cwd?: string;
}

/**
 * Formats standard Conventional Commit message for a captured raw snapshot.
 */
export function formatSnapshotCommitMessage(
	manifest: CaptureManifest,
	options: { coAuthor?: boolean } = {},
): string {
	const coAuthor = options.coAuthor ?? true;
	const footer = coAuthor
		? "\n\nGenerated with Antigravity\nCo-authored-by: gemini-code-assist[bot] <176961590+gemini-code-assist[bot]@users.noreply.github.com>"
		: "";

	return `chore(capture): record v${manifest.timetable_version} snapshot ${manifest.snapshot_id} (${manifest.day_type}, ${manifest.status})

Snapshot Date: ${manifest.snapshot_date}
Region Scope:  ${manifest.region_scope}
Station Hash:  ${manifest.station_master_hash.slice(0, 16)}...
Board Hash:    ${manifest.board_response_hash.slice(0, 16)}...
Status:        ${manifest.status}${footer}`;
}

/**
 * Atomically commits a raw capture snapshot directory.
 */
export async function commitCaptureSnapshot(
	options: CommitSnapshotOptions,
): Promise<CommitSnapshotResult> {
	const cwd = options.cwd ?? process.cwd();
	let resolvedSnapshotDir: string;
	try {
		resolvedSnapshotDir = resolveSafePath(options.snapshotDir, cwd);
	} catch (err) {
		return {
			committed: false,
			reason: `Invalid snapshot directory: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	let manifest = options.manifest;
	if (!manifest) {
		const manifestPath = resolveSafePath(
			path.join(resolvedSnapshotDir, "manifest.json"),
			resolvedSnapshotDir,
		);
		try {
			const content = await fs.readFile(manifestPath, "utf-8");
			manifest = CaptureManifestSchema.parse(JSON.parse(content));
		} catch (err) {
			return {
				committed: false,
				reason: `Failed to read snapshot manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	const commitMessage = formatSnapshotCommitMessage(manifest);
	return commitPath({
		path: resolvedSnapshotDir,
		message: commitMessage,
		cwd,
	});
}
