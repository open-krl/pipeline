// src/core/git.ts
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { type CaptureManifest, CaptureManifestSchema } from "../api/schemas";

const execFileAsync = promisify(execFile);

export interface GitExecOptions {
	cwd?: string;
}

/**
 * Checks if a working directory is inside a Git work tree.
 */
export async function isGitRepository(cwd = process.cwd()): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["rev-parse", "--is-inside-work-tree"],
			{ cwd },
		);
		return stdout.trim() === "true";
	} catch {
		return false;
	}
}

/**
 * Resolves the commit hash for a target ref (default HEAD).
 */
export async function getGitCommitHash(
	target = "HEAD",
	cwd = process.cwd(),
): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", target], {
			cwd,
		});
		return stdout.trim();
	} catch {
		return null;
	}
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
		? `\n\nGenerated with Antigravity\nCo-authored-by: gemini-code-assist[bot] <176961590+gemini-code-assist[bot]@users.noreply.github.com>`
		: "";

	return `chore(capture): record v${manifest.timetable_version} snapshot ${manifest.snapshot_id} (${manifest.day_type}, ${manifest.status})

Snapshot Date: ${manifest.snapshot_date}
Region Scope:  ${manifest.region_scope}
Station Hash:  ${manifest.station_master_hash.slice(0, 16)}...
Board Hash:    ${manifest.board_response_hash.slice(0, 16)}...
Status:        ${manifest.status}${footer}`;
}

/**
 * Formats standard Conventional Commit message for an itinerary census run.
 */
export function formatCensusCommitMessage(
	params: {
		timetableVersion: number;
		totalTrips: number;
		newlyProbed: number;
		failedCount: number;
	},
	options: { coAuthor?: boolean } = {},
): string {
	const coAuthor = options.coAuthor ?? true;
	const footer = coAuthor
		? `\n\nGenerated with Antigravity\nCo-authored-by: gemini-code-assist[bot] <176961590+gemini-code-assist[bot]@users.noreply.github.com>`
		: "";

	return `chore(census): record v${params.timetableVersion} itineraries census (${params.totalTrips} trips)

Total Trips:  ${params.totalTrips}
Newly Probed: ${params.newlyProbed}
Failed:       ${params.failedCount}${footer}`;
}

export interface CommitSnapshotOptions {
	snapshotDir: string;
	manifest?: CaptureManifest;
	cwd?: string;
}

export interface CommitSnapshotResult {
	committed: boolean;
	commitHash?: string;
	message?: string;
	reason?: string;
}

/**
 * Atomically commits a raw capture snapshot directory with strict path containment.
 */
export async function commitCaptureSnapshot(
	options: CommitSnapshotOptions,
): Promise<CommitSnapshotResult> {
	const cwd = options.cwd ?? process.cwd();

	// 1. Verify Git workspace
	if (!(await isGitRepository(cwd))) {
		return {
			committed: false,
			reason: "Not inside a Git repository",
		};
	}

	// 2. Resolve manifest
	const resolvedSnapshotDir = path.resolve(cwd, options.snapshotDir);
	let manifest = options.manifest;
	if (!manifest) {
		const manifestPath = path.join(resolvedSnapshotDir, "manifest.json");
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

	// 3. Compute relative path
	const relativeSnapshotDir = path.relative(cwd, resolvedSnapshotDir);

	// 4. Verify uncommitted changes exist in this snapshot
	try {
		const { stdout: statusOut } = await execFileAsync(
			"git",
			["status", "--porcelain", relativeSnapshotDir],
			{ cwd },
		);
		if (!statusOut.trim()) {
			return {
				committed: false,
				reason: "No uncommitted changes in snapshot directory",
			};
		}
	} catch (err) {
		return {
			committed: false,
			reason: `Failed to check git status: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// 5. Contamination Guard: Ensure no other files are already staged
	try {
		const { stdout: stagedBefore } = await execFileAsync(
			"git",
			["diff", "--cached", "--name-only"],
			{ cwd },
		);
		const alreadyStaged = stagedBefore.trim().split("\n").filter(Boolean);
		const unrelatedStaged = alreadyStaged.filter(
			(file) => !file.startsWith(relativeSnapshotDir),
		);
		if (unrelatedStaged.length > 0) {
			return {
				committed: false,
				reason: `Staging area contains ${unrelatedStaged.length} unrelated staged file(s) (${unrelatedStaged.slice(0, 3).join(", ")}...). Unstage them first.`,
			};
		}
	} catch (err) {
		return {
			committed: false,
			reason: `Failed to check staged files: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// 6. Explicitly stage ONLY the snapshot directory
	try {
		await execFileAsync("git", ["add", relativeSnapshotDir], { cwd });
	} catch (err) {
		return {
			committed: false,
			reason: `Failed to stage snapshot directory: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// 7. Defense-in-depth: audit staged set post-add
	try {
		const { stdout: stagedAfter } = await execFileAsync(
			"git",
			["diff", "--cached", "--name-only"],
			{ cwd },
		);
		const nowStaged = stagedAfter.trim().split("\n").filter(Boolean);
		const violatingFiles = nowStaged.filter(
			(file) => !file.startsWith(relativeSnapshotDir),
		);
		if (violatingFiles.length > 0) {
			// Rollback stage immediately
			await execFileAsync("git", ["restore", "--staged", relativeSnapshotDir], {
				cwd,
			});
			return {
				committed: false,
				reason: `Contamination guard triggered: found staged files outside snapshot directory (${violatingFiles.slice(0, 3).join(", ")}). Staging rolled back.`,
			};
		}
	} catch (err) {
		return {
			committed: false,
			reason: `Failed to verify staged diff: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// 8. Commit
	const commitMessage = formatSnapshotCommitMessage(manifest);
	try {
		await execFileAsync("git", ["commit", "-m", commitMessage], { cwd });
		const commitHash = await getGitCommitHash("HEAD", cwd);
		return {
			committed: true,
			commitHash: commitHash ?? undefined,
			message: commitMessage,
		};
	} catch (err) {
		// Attempt to unstage to avoid leaving a dirty index
		try {
			await execFileAsync("git", ["restore", "--staged", relativeSnapshotDir], {
				cwd,
			});
		} catch {
			// Ignore unstage error
		}
		return {
			committed: false,
			reason: `Git commit failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
