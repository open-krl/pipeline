// src/core/logger.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveSafePath } from "./path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

export interface LogEntry {
	timestamp: string;
	level: LogLevel;
	scope: string;
	event: string;
	message: string;
	[key: string]: unknown;
}

export interface LoggerOptions {
	logFilePath?: string;
	minLevel?: LogLevel;
	enableConsole?: boolean;
	consoleMinLevel?: LogLevel;
}

export interface ScopedLogger {
	debug(event: string, message: string, data?: Record<string, unknown>): void;
	info(event: string, message: string, data?: Record<string, unknown>): void;
	warn(event: string, message: string, data?: Record<string, unknown>): void;
	error(event: string, message: string, data?: Record<string, unknown>): void;
}

export interface Stopwatch {
	readonly elapsedMs: number;
	readonly elapsedSecs: string;
}

/**
 * Creates a high-resolution performance stopwatch.
 */
export function startTimer(): Stopwatch {
	const start = performance.now();
	return {
		get elapsedMs() {
			return Math.round(performance.now() - start);
		},
		get elapsedSecs() {
			return ((performance.now() - start) / 1000).toFixed(1);
		},
	};
}

/**
 * Lightweight, zero-dependency dual-output logger emitting formatted messages
 * to standard streams and structured JSON Lines (.jsonl) to persistent log files.
 */
export class StructuredLogger {
	readonly logFilePath?: string;
	readonly minLevel: LogLevel;
	readonly consoleMinLevel: LogLevel;
	readonly enableConsole: boolean;

	private writeQueue: Promise<void> = Promise.resolve();
	private dirEnsured = false;

	constructor(options: LoggerOptions = {}) {
		this.logFilePath = options.logFilePath
			? resolveSafePath(options.logFilePath)
			: undefined;
		this.minLevel = options.minLevel ?? "info";
		this.consoleMinLevel = options.consoleMinLevel ?? "info";
		this.enableConsole = options.enableConsole ?? false;
	}

	private shouldLog(level: LogLevel, threshold: LogLevel): boolean {
		return LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY[threshold];
	}

	log(
		level: LogLevel,
		scope: string,
		event: string,
		message: string,
		data: Record<string, unknown> = {},
	): void {
		const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

		// 1. Console Output (if enabled and meets threshold)
		if (this.enableConsole && this.shouldLog(level, this.consoleMinLevel)) {
			const formatted = `[${timestamp}] [${level.toUpperCase().padEnd(5, " ")}] [${scope}] ${message}`;
			if (level === "error") {
				console.error(formatted);
			} else if (level === "warn") {
				console.warn(formatted);
			} else {
				console.log(formatted);
			}
		}

		// 2. File Output (if logFilePath configured and meets threshold)
		if (this.logFilePath && this.shouldLog(level, this.minLevel)) {
			const entry: LogEntry = {
				...data,
				timestamp,
				level,
				scope,
				event,
				message,
			};

			let line: string;
			try {
				line = JSON.stringify(entry);
			} catch (err) {
				console.warn("[Logger Warning] Failed to serialize log entry:", err);
				return;
			}

			this.appendLine(line);
		}
	}

	private appendLine(line: string): void {
		if (!this.logFilePath) return;

		this.writeQueue = this.writeQueue
			.then(async () => {
				if (!this.dirEnsured && this.logFilePath) {
					await fs.mkdir(path.dirname(this.logFilePath), { recursive: true });
					this.dirEnsured = true;
				}
				if (this.logFilePath) {
					await fs.appendFile(this.logFilePath, `${line}\n`, "utf-8");
				}
			})
			.catch((err) => {
				// Don't crash pipeline if disk logging fails
				console.warn(`[Logger Warning] Failed to write log entry:`, err);
			});
	}

	debug(
		scope: string,
		event: string,
		message: string,
		data?: Record<string, unknown>,
	): void {
		this.log("debug", scope, event, message, data);
	}

	info(
		scope: string,
		event: string,
		message: string,
		data?: Record<string, unknown>,
	): void {
		this.log("info", scope, event, message, data);
	}

	warn(
		scope: string,
		event: string,
		message: string,
		data?: Record<string, unknown>,
	): void {
		this.log("warn", scope, event, message, data);
	}

	error(
		scope: string,
		event: string,
		message: string,
		data?: Record<string, unknown>,
	): void {
		this.log("error", scope, event, message, data);
	}

	child(scope: string): ScopedLogger {
		return {
			debug: (event, message, data) => this.debug(scope, event, message, data),
			info: (event, message, data) => this.info(scope, event, message, data),
			warn: (event, message, data) => this.warn(scope, event, message, data),
			error: (event, message, data) => this.error(scope, event, message, data),
		};
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}
}

/**
 * Creates a default log file path under logs/ directory.
 * Example: logs/capture-v1-weekday-2026-09-17T06-50-00Z.jsonl
 */
export function generateDefaultLogPath(
	command: string,
	context: {
		version?: number;
		dayType?: string;
		now?: Date;
		baseDir?: string;
	} = {},
): string {
	const date = (context.now ?? new Date())
		.toISOString()
		.replace(/\.\d{3}Z$/, "Z")
		.replace(/[:]/g, "-");

	const parts = [command];
	if (context.version !== undefined) {
		parts.push(`v${context.version}`);
	}
	if (context.dayType) {
		parts.push(context.dayType);
	}
	parts.push(date);

	const logsDir = context.baseDir ? path.join(context.baseDir, "logs") : "logs";
	return path.join(logsDir, `${parts.join("-")}.jsonl`);
}

/**
 * Shared pipeline bootstrap: resolves an injected logger or creates one
 * (file-backed by default, silent with noLog). Returns the effective
 * logger and its resolved log file path.
 */
export function resolvePipelineLogging(params: {
	logger?: StructuredLogger;
	logFilePath?: string;
	noLog?: boolean;
	defaultLogName: string;
	context: Record<string, unknown>;
	baseDir?: string;
}): { logger: StructuredLogger; logFilePath?: string } {
	if (params.logger) {
		return { logger: params.logger, logFilePath: params.logger.logFilePath };
	}
	if (params.noLog) {
		return { logger: new StructuredLogger() };
	}
	const logFilePath =
		params.logFilePath ??
		generateDefaultLogPath(params.defaultLogName, {
			...params.context,
			baseDir: params.baseDir,
		});
	return { logger: new StructuredLogger({ logFilePath }), logFilePath };
}
