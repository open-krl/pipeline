import { type DayType, DayTypeSchema } from "@/archive/schemas";
import { type RegionScope, RegionScopeSchema } from "@/config";
import { resolveSafePath } from "@/core/path";

/** Print an error and exit(1). Use for user-facing input validation. */
export function exitError(message: string): never {
	console.error(`Error: ${message}`);
	process.exit(1);
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function parseDayType(value: string | undefined): DayType | undefined {
	if (value === undefined) return undefined;
	const res = DayTypeSchema.safeParse(value);
	if (!res.success) {
		exitError(
			`Invalid --day-type '${value}'. Allowed values: ${Object.values(DayTypeSchema.enum).join(", ")}`,
		);
	}
	return res.data;
}

export function parseRegion(
	value: string | undefined,
): RegionScope | undefined {
	if (value === undefined) return undefined;
	const res = RegionScopeSchema.safeParse(value);
	if (!res.success) {
		exitError(
			`Invalid --region '${value}'. Allowed values: ${Object.values(RegionScopeSchema.enum).join(", ")}`,
		);
	}
	return res.data;
}

export function parseDataDir(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		return resolveSafePath(value);
	} catch (err) {
		exitError(errorMessage(err));
	}
}

export function parseVersionArg(
	value: string | undefined,
	label = "version",
): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	const parsed = Number.parseInt(trimmed, 10);
	if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
		exitError(`Invalid ${label} '${value}'. Must be a positive integer.`);
	}
	return parsed;
}

export function parseToleranceSecs(
	value: string | number | undefined,
): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		exitError("--tolerance must be a non-negative number.");
	}
	return parsed;
}

/** Strictly validates YYYY-MM-DD (including real calendar dates) in WIB. */
export function parseIsoDate(value: string | undefined): Date | undefined {
	if (value === undefined) return undefined;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		exitError(`Invalid date format '${value}'. Expected YYYY-MM-DD.`);
	}
	const [y, m, d] = value.split("-").map(Number);
	const date = new Date(`${value}T00:00:00+07:00`);
	if (
		Number.isNaN(date.getTime()) ||
		date.getFullYear() !== y ||
		date.getMonth() + 1 !== m ||
		date.getDate() !== d
	) {
		exitError(`Invalid calendar date '${value}'.`);
	}
	return date;
}

export function parseStationCodes(
	value: string | undefined,
): string[] | undefined {
	if (!value) return undefined;
	return value
		.split(",")
		.map((s) => s.trim().toUpperCase())
		.filter(Boolean);
}
