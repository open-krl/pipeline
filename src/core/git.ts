// src/core/git.ts
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { resolveSafePath } from "./path";

const execFileAsync = promisify(execFile);

interface GitExecOptions {
	cwd?: string;
}

export interface CommitPathOptions {
	path: string;
	message: string;
	cwd?: string;
}

export interface CommitResult {
	committed: boolean;
	commitHash?: string;
	message?: string;
	reason?: string;
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
 * Resolves the latest commit hash that touched a specific file or directory path.
 * Runs `git log -n 1 --format=%H -- <targetPath>`. Returns null if path has no commit.
 */
export async function getGitCommitForPath(
	targetPath: string,
	cwd = process.cwd(),
): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			[
				"--literal-pathspecs",
				"log",
				"-n",
				"1",
				"--format=%H",
				"--",
				targetPath,
			],
			{ cwd },
		);
		const hash = stdout.trim();
		return hash || null;
	} catch {
		return null;
	}
}

/**
 * Atomically stages and commits a specific directory or file path to git
 * with strict containment and contamination guards.
 */
export async function commitPath(
	options: CommitPathOptions,
): Promise<CommitResult> {
	const cwd = options.cwd ?? process.cwd();

	// 1. Verify Git workspace
	if (!(await isGitRepository(cwd))) {
		return {
			committed: false,
			reason: "Not inside a Git repository",
		};
	}

	// 2. Resolve safe path
	let resolvedTarget: string;
	try {
		resolvedTarget = resolveSafePath(options.path, cwd);
	} catch (err) {
		return {
			committed: false,
			reason: `Invalid path: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// 3. Compute relative path
	const relativeTarget = path.relative(cwd, resolvedTarget);

	// 4. Verify uncommitted changes exist in target path
	try {
		const { stdout: statusOut } = await execFileAsync(
			"git",
			["status", "--porcelain", "--", relativeTarget],
			{ cwd },
		);
		if (!statusOut.trim()) {
			return {
				committed: false,
				reason: `No uncommitted changes in path: ${relativeTarget}`,
			};
		}
	} catch (err) {
		return {
			committed: false,
			reason: `Failed to check git status: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// 5. Contamination Guard: Ensure no other files are already staged
	const normalizedTarget = relativeTarget.split(path.sep).join("/");
	const isInsideTarget = (file: string) =>
		file === normalizedTarget || file.startsWith(`${normalizedTarget}/`);

	try {
		const { stdout: stagedBefore } = await execFileAsync(
			"git",
			["diff", "--cached", "--name-only"],
			{ cwd },
		);
		const alreadyStaged = stagedBefore.trim().split("\n").filter(Boolean);
		const unrelatedStaged = alreadyStaged.filter(
			(file) => !isInsideTarget(file),
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

	// 6. Explicitly stage ONLY the target path
	try {
		await execFileAsync("git", ["add", "--", relativeTarget], { cwd });
	} catch (err) {
		return {
			committed: false,
			reason: `Failed to stage path: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// 7. Audit staged set post-add
	try {
		const { stdout: stagedAfter } = await execFileAsync(
			"git",
			["diff", "--cached", "--name-only"],
			{ cwd },
		);
		const nowStaged = stagedAfter.trim().split("\n").filter(Boolean);
		const violatingFiles = nowStaged.filter((file) => !isInsideTarget(file));
		if (violatingFiles.length > 0) {
			// Rollback stage immediately
			await execFileAsync(
				"git",
				["restore", "--staged", "--", relativeTarget],
				{ cwd },
			);
			return {
				committed: false,
				reason: `Contamination guard triggered: found staged files outside target directory (${violatingFiles.slice(0, 3).join(", ")}). Staging rolled back.`,
			};
		}
	} catch (err) {
		return {
			committed: false,
			reason: `Failed to verify staged diff: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// 8. Commit
	try {
		await execFileAsync("git", ["commit", "-m", options.message], { cwd });
		const commitHash = await getGitCommitHash("HEAD", cwd);
		return {
			committed: true,
			commitHash: commitHash ?? undefined,
			message: options.message,
		};
	} catch (err) {
		try {
			await execFileAsync(
				"git",
				["restore", "--staged", "--", relativeTarget],
				{ cwd },
			);
		} catch {
			// Ignore unstage error
		}
		return {
			committed: false,
			reason: `Git commit failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
