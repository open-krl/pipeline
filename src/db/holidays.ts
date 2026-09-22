// src/db/holidays.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HolidayFileSchema, type HolidayItem } from "../core/calendar";

/**
 * Loads and validates version-controlled statutory holidays from data/holidays.json (ADR 15).
 */
export function loadHolidays(filePath?: string): HolidayItem[] {
	const resolvedPath =
		filePath ?? join(import.meta.dir, "../../data/holidays.json");
	const rawContent = readFileSync(resolvedPath, "utf8");
	const parsedJson = JSON.parse(rawContent);

	const validated = HolidayFileSchema.safeParse(parsedJson);
	if (!validated.success) {
		throw new Error(
			`Invalid holidays.json structure: ${JSON.stringify(validated.error.issues)}`,
		);
	}

	return validated.data;
}
