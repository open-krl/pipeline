// tests/cli.test.ts
import { describe, expect, it } from "bun:test";
import { createCli } from "../src/cli";

describe("src/cli — CAC architecture", () => {
	it("registers all expected commands and upcoming milestone stubs", () => {
		const cli = createCli();
		const commandNames = cli.commands.map((c) => c.name);

		expect(commandNames).toContain("capture");
		expect(commandNames).toContain("commit-snapshot");
		expect(commandNames).toContain("list-snapshots");
		expect(commandNames).toContain("census");
		expect(commandNames).toContain("build");
		expect(commandNames).toContain("export");
		expect(commandNames).toContain("calendar");
		expect(commandNames).toContain("detect");
	});

	it("parses capture options correctly with defaults", () => {
		const cli = createCli();
		const parsed = cli.parse(
			[
				"bun",
				"src/cli.ts",
				"capture",
				"--day-type",
				"sunday",
				"--new-version",
				"--yes",
			],
			{ run: false },
		);

		expect(cli.matchedCommand?.name).toBe("capture");
		expect(parsed.options.dayType).toBe("sunday");
		expect(parsed.options.region).toBe("jabodetabek");
		expect(parsed.options.newVersion).toBe(true);
		expect(parsed.options.yes).toBe(true);
		expect(parsed.options.dataDir).toBe("data/raw");
		expect(parsed.options.commit).toBeUndefined();
	});

	it("parses commit and no-commit flags on capture", () => {
		const cli1 = createCli();
		const parsed1 = cli1.parse(["bun", "src/cli.ts", "capture", "--commit"], {
			run: false,
		});
		expect(parsed1.options.commit).toBe(true);

		const cli2 = createCli();
		const parsed2 = cli2.parse(
			["bun", "src/cli.ts", "capture", "--no-commit"],
			{ run: false },
		);
		expect(parsed2.options.commit).toBe(false);
	});

	it("parses commit-snapshot positional arguments and options", () => {
		const cli = createCli();
		const parsed = cli.parse(
			[
				"bun",
				"src/cli.ts",
				"commit-snapshot",
				"2",
				"5",
				"--data-dir",
				"data/custom",
			],
			{ run: false },
		);

		expect(cli.matchedCommand?.name).toBe("commit-snapshot");
		expect(parsed.args[0]).toBe("2");
		expect(parsed.args[1]).toBe("5");
		expect(parsed.options.dataDir).toBe("data/custom");
	});

	it("parses list-snapshots positional version argument", () => {
		const cli = createCli();
		const parsed = cli.parse(["bun", "src/cli.ts", "list-snapshots", "3"], {
			run: false,
		});

		expect(cli.matchedCommand?.name).toBe("list-snapshots");
		expect(parsed.args[0]).toBe("3");
	});

	it("parses census positional version and flag options", () => {
		const cli = createCli();
		const parsed = cli.parse(
			[
				"bun",
				"src/cli.ts",
				"census",
				"1",
				"--day-type",
				"saturday",
				"--reprobe-all",
				"--commit",
			],
			{ run: false },
		);

		expect(cli.matchedCommand?.name).toBe("census");
		expect(parsed.args[0]).toBe("1");
		expect(parsed.options.dayType).toBe("saturday");
		expect(parsed.options.reprobeAll).toBe(true);
		expect(parsed.options.commit).toBe(true);

		const cli2 = createCli();
		const parsed2 = cli2.parse(
			["bun", "src/cli.ts", "census", "--timetable-version", "5"],
			{ run: false },
		);
		expect(parsed2.options.timetableVersion).toBe(5);
	});

	it("parses build positional version and path options", () => {
		const cli = createCli();
		const parsed = cli.parse(
			[
				"bun",
				"src/cli.ts",
				"build",
				"1",
				"--data-dir",
				"data/custom-raw",
				"--out-dir",
				"data/custom-build",
				"--db-path",
				"custom.db",
			],
			{ run: false },
		);

		expect(cli.matchedCommand?.name).toBe("build");
		expect(parsed.args[0]).toBe("1");
		expect(parsed.options.dataDir).toBe("data/custom-raw");
		expect(parsed.options.outDir).toBe("data/custom-build");
		expect(parsed.options.dbPath).toBe("custom.db");
	});

	it("executes milestone stub commands cleanly", async () => {
		const logs: string[] = [];
		const origLog = console.log;
		console.log = (msg: string) => logs.push(msg);

		try {
			for (const cmd of ["export", "calendar", "detect"]) {
				const cli = createCli();
				cli.parse(["bun", "src/cli.ts", cmd], { run: false });
				await cli.runMatchedCommand();
			}
			expect(logs.length).toBe(3);
			expect(logs[0]).toContain("export");
			expect(logs[1]).toContain("calendar");
			expect(logs[2]).toContain("detect");
		} finally {
			console.log = origLog;
		}
	});
});
