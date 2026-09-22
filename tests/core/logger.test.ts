// tests/core/logger.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	generateDefaultLogPath,
	type LogEntry,
	StructuredLogger,
	startTimer,
} from "@/core/logger";

const TEST_LOG_DIR = path.resolve(process.cwd(), "scratch/test_logs");

describe("src/core/logger", () => {
	beforeEach(async () => {
		await fs.rm(TEST_LOG_DIR, { recursive: true, force: true });
		await fs.mkdir(TEST_LOG_DIR, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(TEST_LOG_DIR, { recursive: true, force: true });
	});

	it("appends structured JSONL records to log file", async () => {
		const logFile = path.join(TEST_LOG_DIR, "test.jsonl");
		const logger = new StructuredLogger({ logFilePath: logFile });

		logger.info("census", "run_started", "Starting census crawl", {
			version: 1,
			dayType: "weekday",
		});
		logger.warn("http", "retry", "Server 500 retry", {
			attempt: 1,
			url: "https://example.com",
		});
		logger.error("census", "train_failed", "Train 123 failed", {
			trainId: "123",
			reason: "Timeout",
		});

		await logger.flush();

		const content = await fs.readFile(logFile, "utf-8");
		const lines = content.trim().split("\n");
		expect(lines.length).toBe(3);

		const entry1: LogEntry = JSON.parse(lines[0]);
		expect(entry1.level).toBe("info");
		expect(entry1.scope).toBe("census");
		expect(entry1.event).toBe("run_started");
		expect(entry1.message).toBe("Starting census crawl");
		expect(entry1.version).toBe(1);
		expect(entry1.dayType).toBe("weekday");
		expect(entry1.timestamp).toBeDefined();

		const entry2: LogEntry = JSON.parse(lines[1]);
		expect(entry2.level).toBe("warn");
		expect(entry2.event).toBe("retry");
		expect(entry2.attempt).toBe(1);

		const entry3: LogEntry = JSON.parse(lines[2]);
		expect(entry3.level).toBe("error");
		expect(entry3.event).toBe("train_failed");
		expect(entry3.trainId).toBe("123");
	});

	it("filters out logs below minLevel", async () => {
		const logFile = path.join(TEST_LOG_DIR, "filter.jsonl");
		const logger = new StructuredLogger({
			logFilePath: logFile,
			minLevel: "warn",
		});

		logger.debug("api", "debug_event", "Debug message");
		logger.info("api", "info_event", "Info message");
		logger.warn("api", "warn_event", "Warn message");
		logger.error("api", "error_event", "Error message");

		await logger.flush();

		const content = await fs.readFile(logFile, "utf-8");
		const lines = content.trim().split("\n");
		expect(lines.length).toBe(2);

		const entry1: LogEntry = JSON.parse(lines[0]);
		expect(entry1.level).toBe("warn");

		const entry2: LogEntry = JSON.parse(lines[1]);
		expect(entry2.level).toBe("error");
	});

	it("supports scoped child loggers", async () => {
		const logFile = path.join(TEST_LOG_DIR, "child.jsonl");
		const logger = new StructuredLogger({ logFilePath: logFile });
		const child = logger.child("capture");

		child.info("station_ok", "Station MRI succeeded", {
			stationId: "MRI",
			departures: 120,
		});

		await logger.flush();

		const content = await fs.readFile(logFile, "utf-8");
		const entry: LogEntry = JSON.parse(content.trim());
		expect(entry.scope).toBe("capture");
		expect(entry.event).toBe("station_ok");
		expect(entry.stationId).toBe("MRI");
		expect(entry.departures).toBe(120);
	});

	it("automatically creates parent directories for log file", async () => {
		const nestedLogFile = path.join(
			TEST_LOG_DIR,
			"deep/nested/dir/nested.jsonl",
		);
		const logger = new StructuredLogger({ logFilePath: nestedLogFile });

		logger.info("test", "test_event", "Nested log write");
		await logger.flush();

		const exists = await fs
			.access(nestedLogFile)
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(true);
	});

	it("startTimer measures elapsed duration accurately", async () => {
		const timer = startTimer();
		await new Promise((r) => setTimeout(r, 25));

		expect(timer.elapsedMs).toBeGreaterThanOrEqual(20);
		expect(timer.elapsedMs).toBeLessThan(10000);
		expect(timer.elapsedSecs).toMatch(/^\d+\.\d$/);
	});

	it("preserves logger-owned fields when metadata collides with schema keys", async () => {
		const logFile = path.join(TEST_LOG_DIR, "reserved.jsonl");
		const logger = new StructuredLogger({ logFilePath: logFile });

		logger.info("test_scope", "valid_event", "Message", {
			level: "error",
			scope: "overwritten_scope",
			event: "overwritten_event",
			customField: "preserved",
		});

		await logger.flush();

		const content = await fs.readFile(logFile, "utf-8");
		const entry: LogEntry = JSON.parse(content.trim());
		expect(entry.level).toBe("info");
		expect(entry.scope).toBe("test_scope");
		expect(entry.event).toBe("valid_event");
		expect(entry.customField).toBe("preserved");
	});

	it("gracefully ignores non-serializable metadata without throwing", async () => {
		const logFile = path.join(TEST_LOG_DIR, "circular.jsonl");
		const logger = new StructuredLogger({ logFilePath: logFile });

		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(() => {
			logger.info("test", "circular_event", "Should not throw", circular);
		}).not.toThrow();

		await logger.flush();
	});

	it("generates structured default log path", () => {
		const fixedDate = new Date("2026-09-17T06:50:00.000Z");
		const pathWeekday = generateDefaultLogPath("census", {
			version: 1,
			dayType: "weekday",
			now: fixedDate,
		});
		expect(pathWeekday).toBe(
			"logs/census-v1-weekday-2026-09-17T06-50-00Z.jsonl",
		);

		const pathCapture = generateDefaultLogPath("capture", {
			now: fixedDate,
		});
		expect(pathCapture).toBe("logs/capture-2026-09-17T06-50-00Z.jsonl");
	});
});
