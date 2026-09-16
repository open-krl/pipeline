// tests/core/path.test.ts
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resolveSafePath } from "../../src/core/path";

describe("src/core/path", () => {
	it("resolves a relative path within the default cwd boundary", () => {
		const safe = resolveSafePath("data/raw");
		expect(safe).toBe(path.resolve(process.cwd(), "data/raw"));
	});

	it("resolves targetPath when it points to base directory itself", () => {
		const safe = resolveSafePath(".", process.cwd());
		expect(safe).toBe(path.resolve(process.cwd()));
	});

	it("resolves nested paths within a custom base directory", () => {
		const baseDir = path.resolve(process.cwd(), "scratch");
		const safe = resolveSafePath("sub/dir/file.json", baseDir);
		expect(safe).toBe(path.resolve(baseDir, "sub/dir/file.json"));
	});

	it("throws an error when target traverses out of base directory via parent dots", () => {
		const baseDir = path.resolve(process.cwd(), "scratch");
		expect(() => resolveSafePath("../package.json", baseDir)).toThrow(
			/Security violation: path '\.\.\/package\.json' resolves outside permitted boundary/,
		);
	});

	it("throws an error when an absolute path outside base directory is passed", () => {
		const baseDir = path.resolve(process.cwd(), "scratch");
		expect(() => resolveSafePath("/etc/passwd", baseDir)).toThrow(
			/Security violation: path '\/etc\/passwd' resolves outside permitted boundary/,
		);
	});
});
