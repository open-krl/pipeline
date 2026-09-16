// scripts/fetch-holidays.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as z from "zod";

const HolidayApiItemSchema = z.object({
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Expected date format YYYY-MM-DD" }),
	name: z.string(),
	is_civic: z.boolean().optional(),
	is_religious: z.boolean().optional(),
	is_cuti_bersama: z.boolean(),
});

const HolidayApiResponseSchema = z.object({
	metadata: z
		.object({
			year: z.union([z.number(), z.string()]),
			timezone: z.string().optional(),
		})
		.passthrough()
		.optional(),
	data: z.array(HolidayApiItemSchema),
});

export interface HolidayRecord {
	holiday_date: string;
	name: string;
	is_collective_leave: boolean;
}

function getCurrentYearWib(): number {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Jakarta",
		year: "numeric",
	});
	return Number.parseInt(formatter.format(new Date()), 10);
}

async function main() {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			year: { type: "string" },
		},
		strict: true,
	});

	const year = values.year
		? Number.parseInt(values.year, 10)
		: getCurrentYearWib();
	if (Number.isNaN(year) || year < 2000 || year > 2100) {
		throw new Error(`Invalid year parameter: ${values.year}`);
	}

	const endpoint = `https://api.kemendesa.link/libur-nasional/api/holidays/${year}.json`;
	console.log(`Fetching ${year} statutory holidays from ${endpoint}...`);

	const response = await fetch(endpoint, {
		headers: {
			"User-Agent": "KRL-Schedule-Pipeline/1.5 (github.com/invictus-navarchus)",
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(
			`Failed to fetch holidays: HTTP ${response.status} ${response.statusText}`,
		);
	}

	const rawJson = await response.json();
	const parsed = HolidayApiResponseSchema.safeParse(rawJson);
	if (!parsed.success) {
		console.error(
			"API response schema validation failed:",
			parsed.error.issues,
		);
		throw new Error("Invalid response format from holiday API");
	}

	const rawHolidays = parsed.data.data;
	const holidays: HolidayRecord[] = rawHolidays
		.map((item) => ({
			holiday_date: item.date,
			name: item.name.trim(),
			is_collective_leave: item.is_cuti_bersama,
		}))
		.sort((a, b) => a.holiday_date.localeCompare(b.holiday_date));

	const targetPath = join(import.meta.dir, "../data/holidays.json");
	writeFileSync(targetPath, `${JSON.stringify(holidays, null, 2)}\n`, "utf8");

	const statutoryCount = holidays.filter((h) => !h.is_collective_leave).length;
	const collectiveCount = holidays.filter((h) => h.is_collective_leave).length;

	console.log(
		`Successfully wrote ${holidays.length} holidays to data/holidays.json`,
	);
	console.log(
		`  - Statutory national holidays (active in GTFS): ${statutoryCount}`,
	);
	console.log(
		`  - Collective leave (cuti bersama, inert in GTFS): ${collectiveCount}`,
	);
}

main().catch((err) => {
	console.error("❌ Error fetching holidays:", err);
	process.exit(1);
});
