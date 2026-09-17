import { KciClient } from "../api/client";
import type { DayType } from "../archive/schemas";
import { DEFAULT_REGION_SCOPE, type RegionScope } from "../config";
import { formatDateWib, resolveDayType } from "../core/calendar";
import { generateDefaultLogPath, StructuredLogger } from "../core/logger";
import { resolveSafePath } from "../core/path";
import { loadHolidays } from "../db/holidays";
import { defaultPrompt, type PromptFn } from "./prompt";

export interface CaptureOptions {
	client?: KciClient;
	dataDir?: string;
	holidaysPath?: string;
	dayType?: DayType;
	region?: RegionScope;
	newVersion?: boolean;
	yes?: boolean;
	now?: Date;
	promptFn?: PromptFn;
	commit?: boolean;
	noCommit?: boolean;
	logger?: StructuredLogger;
	logFilePath?: string;
	noLog?: boolean;
}

/**
 * Normalizes capture options into resolved operational parameters.
 */
export function resolveCaptureContext(options: CaptureOptions) {
	const dataDir = resolveSafePath(options.dataDir ?? "data/raw");
	const regionScope = options.region ?? DEFAULT_REGION_SCOPE;
	const now = options.now ?? new Date();
	const prompt = options.promptFn ?? defaultPrompt;
	const holidays = loadHolidays(options.holidaysPath);
	const snapshotDate = formatDateWib(now);
	const resolvedDayType = options.dayType ?? resolveDayType(now, holidays);

	let logger = options.logger;
	let logFilePath = options.logFilePath;
	if (!logger && !options.noLog) {
		logFilePath =
			options.logFilePath ??
			generateDefaultLogPath("capture", {
				dayType: resolvedDayType,
				now,
				baseDir: options.dataDir ? dataDir : undefined,
			});
		logger = new StructuredLogger({ logFilePath });
	} else if (!logger) {
		logger = new StructuredLogger();
	}
	logFilePath = logger.logFilePath;

	const client = options.client ?? new KciClient({ logger });

	return {
		dataDir,
		client,
		regionScope,
		now,
		prompt,
		snapshotDate,
		resolvedDayType,
		newVersion: Boolean(options.newVersion),
		yes: Boolean(options.yes),
		commit: options.commit,
		noCommit: Boolean(options.noCommit),
		logger,
		logFilePath,
	};
}

export type CaptureContext = ReturnType<typeof resolveCaptureContext>;
