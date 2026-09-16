// tests/core/git.test.ts

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { CaptureManifest } from "../../src/api/schemas";
import {
	commitCaptureSnapshot,
	formatCensusCommitMessage,
	formatSnapshotCommitMessage,
	getGitCommitHash,
	isGitRepository,
} from "../../src/core/git";

const execFileAsync = promisify(execFile);

describe("src/core/git", () => {
	const sampleManifest: CaptureManifest = {
		timetable_version: 1,
		snapshot_id: 1,
		snapshot_date: "2026-09-16",
		day_type: "weekday",
		region_scope: "jabodetabek",
		station_master_hash: "abcd1234efgh567890",
		board_response_hash: "1234567890abcdef12",
		fetched_at: "2026-09-16T10:00:00Z",
		status: "complete",
	};

	it("formats standard snapshot commit message with metadata and co-author footer", () => {
		const message = formatSnapshotCommitMessage(sampleManifest);
		expect(message).toContain(
			"chore(capture): record v1 snapshot 1 (weekday, complete)",
		);
		expect(message).toContain("Snapshot Date: 2026-09-16");
		expect(message).toContain("Region Scope:  jabodetabek");
		expect(message).toContain("Station Hash:  abcd1234efgh5678...");
		expect(message).toContain("Board Hash:    1234567890abcdef...");
		expect(message).toContain("Status:        complete");
		expect(message).toContain("Generated with Antigravity");
		expect(message).toContain(
			"Co-authored-by: gemini-code-assist[bot] <176961590+gemini-code-assist[bot]@users.noreply.github.com>",
		);
	});

	it("formats snapshot commit message without co-author when disabled", () => {
		const message = formatSnapshotCommitMessage(sampleManifest, {
			coAuthor: false,
		});
		expect(message).toContain(
			"chore(capture): record v1 snapshot 1 (weekday, complete)",
		);
		expect(message).not.toContain("Co-authored-by");
	});

	it("formats standard census commit message with metadata", () => {
		const message = formatCensusCommitMessage({
			timetableVersion: 1,
			totalTrips: 1158,
			newlyProbed: 1158,
			failedCount: 0,
		});
		expect(message).toContain(
			"chore(census): record v1 itineraries census (1158 trips)",
		);
		expect(message).toContain("Total Trips:  1158");
		expect(message).toContain("Newly Probed: 1158");
		expect(message).toContain("Failed:       0");
		expect(message).toContain("Co-authored-by: gemini-code-assist[bot]");
	});

	describe("isolated git sandbox repository", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "krl-git-test-"));
			await execFileAsync("git", ["init"], { cwd: tempDir });
			await execFileAsync("git", ["config", "user.name", "KRL Test Bot"], {
				cwd: tempDir,
			});
			await execFileAsync(
				"git",
				["config", "user.email", "bot@krl-test.local"],
				{ cwd: tempDir },
			);
		});

		afterEach(async () => {
			await fs.rm(tempDir, { recursive: true, force: true });
		});

		it("correctly identifies git repository", async () => {
			expect(await isGitRepository(tempDir)).toBe(true);
			const nonGitDir = await fs.mkdtemp(
				path.join(os.tmpdir(), "krl-non-git-"),
			);
			try {
				expect(await isGitRepository(nonGitDir)).toBe(false);
			} finally {
				await fs.rm(nonGitDir, { recursive: true, force: true });
			}
		});

		it("returns false if snapshot directory has no uncommitted changes", async () => {
			const snapshotDir = path.join(tempDir, "data/raw/1/captures/1");
			await fs.mkdir(snapshotDir, { recursive: true });
			await fs.writeFile(
				path.join(snapshotDir, "manifest.json"),
				JSON.stringify(sampleManifest, null, 2),
			);

			// Commit it first
			await execFileAsync("git", ["add", "."], { cwd: tempDir });
			await execFileAsync("git", ["commit", "-m", "initial commit"], {
				cwd: tempDir,
			});

			// Now attempt commitCaptureSnapshot when already clean
			const result = await commitCaptureSnapshot({
				snapshotDir,
				manifest: sampleManifest,
				cwd: tempDir,
			});
			expect(result.committed).toBe(false);
			expect(result.reason).toContain("No uncommitted changes");
		});

		it("refuses to commit if staging area contains unrelated staged files", async () => {
			const snapshotDir = path.join(tempDir, "data/raw/1/captures/1");
			await fs.mkdir(snapshotDir, { recursive: true });
			await fs.writeFile(
				path.join(snapshotDir, "manifest.json"),
				JSON.stringify(sampleManifest, null, 2),
			);

			// Stage an unrelated file first
			const unrelatedFile = path.join(tempDir, "src/unrelated.ts");
			await fs.mkdir(path.dirname(unrelatedFile), { recursive: true });
			await fs.writeFile(unrelatedFile, "console.log('unrelated');");
			await execFileAsync("git", ["add", "src/unrelated.ts"], {
				cwd: tempDir,
			});

			const result = await commitCaptureSnapshot({
				snapshotDir,
				manifest: sampleManifest,
				cwd: tempDir,
			});

			expect(result.committed).toBe(false);
			expect(result.reason).toContain("unrelated staged file");

			// Verify unrelated file remains staged and untouched
			const { stdout } = await execFileAsync(
				"git",
				["diff", "--cached", "--name-only"],
				{ cwd: tempDir },
			);
			expect(stdout.trim()).toBe("src/unrelated.ts");
		});

		it("refuses to commit if staging area contains sibling snapshot with prefix collision", async () => {
			const snapshotDir1 = path.join(tempDir, "data/raw/1/captures/1");
			const snapshotDir10 = path.join(tempDir, "data/raw/1/captures/10");
			await fs.mkdir(snapshotDir1, { recursive: true });
			await fs.mkdir(snapshotDir10, { recursive: true });
			await fs.writeFile(
				path.join(snapshotDir1, "manifest.json"),
				JSON.stringify(sampleManifest, null, 2),
			);
			await fs.writeFile(
				path.join(snapshotDir10, "manifest.json"),
				JSON.stringify({ ...sampleManifest, snapshot_id: 10 }, null, 2),
			);

			// Stage sibling snapshot 10 (e.g. data/raw/1/captures/10/manifest.json)
			await execFileAsync("git", ["add", "data/raw/1/captures/10"], {
				cwd: tempDir,
			});

			const result = await commitCaptureSnapshot({
				snapshotDir: snapshotDir1,
				manifest: sampleManifest,
				cwd: tempDir,
			});

			expect(result.committed).toBe(false);
			expect(result.reason).toContain("unrelated staged file");
		});

		it("successfully and atomically commits snapshot directory", async () => {
			const snapshotDir = path.join(tempDir, "data/raw/1/captures/1");
			await fs.mkdir(path.join(snapshotDir, "boards"), { recursive: true });
			await fs.writeFile(
				path.join(snapshotDir, "manifest.json"),
				JSON.stringify(sampleManifest, null, 2),
			);
			await fs.writeFile(
				path.join(snapshotDir, "stations.json"),
				JSON.stringify({ status: 200, data: [] }),
			);
			await fs.writeFile(
				path.join(snapshotDir, "boards/MRI.json"),
				JSON.stringify({ status: 200, data: [] }),
			);

			// Also leave an unstaged unrelated file in working tree
			const unrelatedUnstaged = path.join(tempDir, "src/unrelated.ts");
			await fs.mkdir(path.dirname(unrelatedUnstaged), { recursive: true });
			await fs.writeFile(unrelatedUnstaged, "console.log('unstaged');");

			const result = await commitCaptureSnapshot({
				snapshotDir,
				manifest: sampleManifest,
				cwd: tempDir,
			});

			expect(result.committed).toBe(true);
			expect(result.commitHash).toBeDefined();

			// Verify commit hash matches HEAD
			const headHash = await getGitCommitHash("HEAD", tempDir);
			expect(result.commitHash).toBe(headHash ?? undefined);

			// Verify commit log contains only snapshot files
			const { stdout: commitFiles } = await execFileAsync(
				"git",
				["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"],
				{ cwd: tempDir },
			);
			const committedList = commitFiles.trim().split("\n");
			expect(committedList).toHaveLength(3);
			expect(committedList).toContain("data/raw/1/captures/1/manifest.json");
			expect(committedList).toContain("data/raw/1/captures/1/stations.json");
			expect(committedList).toContain("data/raw/1/captures/1/boards/MRI.json");
			expect(committedList).not.toContain("src/unrelated.ts");

			// Verify unrelated file remains untracked in working tree
			const { stdout: status } = await execFileAsync(
				"git",
				["status", "--porcelain", "-uall"],
				{ cwd: tempDir },
			);
			expect(status.trim()).toBe("?? src/unrelated.ts");
		});
	});
});
