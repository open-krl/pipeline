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

	it("parses export positional version and flag options", () => {
		const cli = createCli();
		const parsed = cli.parse(
			[
				"bun",
				"src/cli.ts",
				"export",
				"1",
				"--db-path",
				"data/custom.db",
				"--out-dir",
				"data/custom-out",
				"--start-date",
				"2026-09-16",
				"--end-date",
				"2026-12-31",
				"--require-resolved-calendar",
				"--require-census-complete",
				"--require-holiday-coverage",
				"--dump-csv",
				"data/custom-csv",
			],
			{ run: false },
		);

		expect(cli.matchedCommand?.name).toBe("export");
		expect(parsed.args[0]).toBe("1");
		expect(parsed.options.dbPath).toBe("data/custom.db");
		expect(parsed.options.outDir).toBe("data/custom-out");
		expect(parsed.options.startDate).toBe("2026-09-16");
		expect(parsed.options.endDate).toBe("2026-12-31");
		expect(parsed.options.requireResolvedCalendar).toBe(true);
		expect(parsed.options.requireCensusComplete).toBe(true);
		expect(parsed.options.requireHolidayCoverage).toBe(true);
		expect(parsed.options.dumpCsv).toBe("data/custom-csv");
	});

	it("parses calendar positional arguments and options", () => {
		const cli = createCli();
		const parsed = cli.parse(
			[
				"bun",
				"src/cli.ts",
				"calendar",
				"2",
				"--data-dir",
				"data/custom-raw",
				"--db-path",
				"data/build/krl_v2.db",
				"--tolerance",
				"600",
				"--detail",
				"--json",
			],
			{ run: false },
		);

		expect(cli.matchedCommand?.name).toBe("calendar");
		expect(parsed.args[0]).toBe("2");
		expect(parsed.options.dataDir).toBe("data/custom-raw");
		expect(parsed.options.dbPath).toBe("data/build/krl_v2.db");
		expect(parsed.options.tolerance).toBe(600);
		expect(parsed.options.detail).toBe(true);
		expect(parsed.options.json).toBe(true);
	});

	it("parses detect positional arguments and options", () => {
		const cli = createCli();
		const parsed = cli.parse(
			[
				"bun",
				"src/cli.ts",
				"detect",
				"1",
				"--date",
				"2026-09-17",
				"--day-type",
				"weekday",
				"--db-path",
				"data/build/krl_v1.db",
				"--data-dir",
				"data/raw",
				"--raw",
				"--stations",
				"MRI,BKS",
				"--holidays-path",
				"data/holidays.json",
				"--tolerance",
				"900",
				"--fail-on-drift",
				"--json",
			],
			{ run: false },
		);

		expect(cli.matchedCommand?.name).toBe("detect");
		expect(parsed.args[0]).toBe("1");
		expect(parsed.options.date).toBe("2026-09-17");
		expect(parsed.options.dayType).toBe("weekday");
		expect(parsed.options.dbPath).toBe("data/build/krl_v1.db");
		expect(parsed.options.dataDir).toBe("data/raw");
		expect(parsed.options.raw).toBe(true);
		expect(parsed.options.stations).toBe("MRI,BKS");
		expect(parsed.options.holidaysPath).toBe("data/holidays.json");
		expect(parsed.options.tolerance).toBe(900);
		expect(parsed.options.failOnDrift).toBe(true);
		expect(parsed.options.json).toBe(true);
	});
});
