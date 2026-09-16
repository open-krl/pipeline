// src/api/client.ts
import ky, { isHTTPError } from "ky";
import {
	API_BASE_URL,
	API_HEADERS,
	CONCURRENCY,
	DEFAULT_TIME_WINDOW,
	PACING_MS,
	RETRY,
} from "../config";
import {
	type DepartureBoardResponse,
	DepartureBoardResponseSchema,
	type ItineraryResponse,
	ItineraryResponseSchema,
	type StationMasterResponse,
	StationMasterResponseSchema,
} from "./schemas";

/**
 * Lightweight in-memory asynchronous semaphore capping concurrent in-flight requests.
 */
export class AsyncSemaphore {
	private available: number;
	private queue: Array<() => void> = [];

	constructor(public readonly maxConcurrency: number) {
		if (maxConcurrency < 1) {
			throw new Error("maxConcurrency must be >= 1");
		}
		this.available = maxConcurrency;
	}

	get activeCount(): number {
		return this.maxConcurrency - this.available;
	}

	get pendingCount(): number {
		return this.queue.length;
	}

	async acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--;
			return;
		}
		return new Promise<void>((resolve) => {
			this.queue.push(resolve);
		});
	}

	release(): void {
		const next = this.queue.shift();
		if (next) {
			// Transfer permit directly to the queued waiter without incrementing available
			next();
		} else {
			this.available++;
		}
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}
}

export type FetchFunction = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface KciClientOptions {
	baseUrl?: string;
	fetchFn?: FetchFunction;
	boardConcurrency?: number;
	censusConcurrency?: number;
	pacingMs?: number;
	retryBaseMs?: number;
	retryFactor?: number;
	maxRetries?: number;
	timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry on timeouts, rate limits, and all 5xx — mirroring the old manual loop. */
const RETRYABLE_STATUS_CODES = [
	408,
	413,
	429,
	...Array.from({ length: 100 }, (_, i) => 500 + i),
];

type Ky = ReturnType<typeof ky.create>;

/**
 * Resilient HTTP client for KCI endpoints built on `ky`, with concurrency
 * pooling, pacing, jittered exponential backoff, and schema-validated responses.
 */
export class KciClient {
	readonly baseUrl: string;
	readonly fetchFn: FetchFunction;
	readonly boardSemaphore: AsyncSemaphore;
	readonly censusSemaphore: AsyncSemaphore;
	readonly pacingMs: number;
	readonly retryBaseMs: number;
	readonly retryFactor: number;
	readonly maxRetries: number;
	readonly timeoutMs: number;

	private readonly ky: Ky;

	constructor(options: KciClientOptions = {}) {
		this.baseUrl = `${(options.baseUrl ?? API_BASE_URL).replace(/\/+$/, "")}/`;
		this.fetchFn = options.fetchFn ?? fetch;
		this.boardSemaphore = new AsyncSemaphore(
			options.boardConcurrency ?? CONCURRENCY.captureBoards,
		);
		this.censusSemaphore = new AsyncSemaphore(
			options.censusConcurrency ?? CONCURRENCY.censusItineraries,
		);
		this.pacingMs = options.pacingMs ?? PACING_MS;
		this.retryBaseMs = options.retryBaseMs ?? RETRY.baseMs;
		this.retryFactor = options.retryFactor ?? RETRY.factor;
		this.maxRetries = options.maxRetries ?? RETRY.maxRetries;
		this.timeoutMs = options.timeoutMs ?? 15000;

		this.ky = ky.create({
			baseUrl: this.baseUrl,
			fetch: this.fetchFn,
			headers: { ...API_HEADERS },
			timeout: this.timeoutMs,
			retry: {
				limit: this.maxRetries,
				methods: ["get"],
				statusCodes: RETRYABLE_STATUS_CODES,
				// Honors Retry-After / rate-limit headers automatically, clamped:
				afterStatusCodes: [429],
				maxRetryAfter: RETRY.maxDelayMs,
				// attemptCount starts at 1, so retryFactor ** (attemptCount - 1)
				// matches the old attempt-from-0 exponent.
				delay: (attemptCount) =>
					this.retryBaseMs * this.retryFactor ** (attemptCount - 1),
				// Same 80–120% jitter the manual loop applied.
				jitter: (delay) => delay * (0.8 + Math.random() * 0.4),
				// The old loop retried timeouts (AbortSignal.timeout => network error).
				retryOnTimeout: true,
			},
			hooks: {
				beforeRetry: [
					({ request, error, retryCount }) => {
						const detail = isHTTPError(error)
							? error.response.status === 429
								? "[RATE LIMIT] 429"
								: `[SERVER ERROR ${error.response.status}]`
							: `[NETWORK ERROR] ${error instanceof Error ? error.message : String(error)}`;

						console.warn(
							`${detail} on ${request.url} - retrying (attempt ${retryCount}/${this.maxRetries})...`,
						);
					},
				],
			},
		});
	}

	/** Re-creates an HTTPError with the friendly, contextual message the old client produced. */
	private contextualize(error: unknown, context: string): Error {
		if (isHTTPError(error)) {
			return new Error(
				`Failed to ${context}: HTTP ${error.response.status} ${error.response.statusText}`,
				{ cause: error },
			);
		}
		return error instanceof Error ? error : new Error(String(error));
	}

	private async pace(): Promise<void> {
		if (this.pacingMs > 0) {
			await sleep(this.pacingMs);
		}
	}

	/**
	 * Fetches the master list of all stations from KCI (§2.1).
	 */
	async fetchStations(): Promise<StationMasterResponse> {
		try {
			return await this.ky
				.get("api/krl/stations")
				.json(StationMasterResponseSchema);
		} catch (error) {
			throw this.contextualize(error, "fetch stations");
		}
	}

	/**
	 * Fetches the departure board for a single station, bounded by the board semaphore (§2.2).
	 */
	async fetchStationSchedule(
		stationId: string,
		options?: { timefrom?: string; timeto?: string },
	): Promise<DepartureBoardResponse> {
		const timefrom = options?.timefrom ?? DEFAULT_TIME_WINDOW.timefrom;
		const timeto = options?.timeto ?? DEFAULT_TIME_WINDOW.timeto;

		return this.boardSemaphore.run(async () => {
			await this.pace();
			try {
				return await this.ky
					.get("api/krl/schedules", {
						searchParams: { stationid: stationId, timefrom, timeto },
					})
					.json(DepartureBoardResponseSchema);
			} catch (error) {
				throw this.contextualize(
					error,
					`fetch schedule for station ${stationId}`,
				);
			}
		});
	}

	/**
	 * Fetches the complete itinerary stop list for a train, bounded by the census semaphore (§2.3).
	 * Returns null if the train does not exist or has no active schedule (HTTP 404).
	 */
	async fetchTrainSchedule(trainId: string): Promise<ItineraryResponse | null> {
		return this.censusSemaphore.run(async () => {
			await this.pace();

			try {
				// Let 404 through as a response; everything else still throws (after retries).
				const response = await this.ky.get("api/krl/train-schedule", {
					searchParams: { trainid: trainId },
					throwHttpErrors: (status) => status !== 404,
				});

				if (response.status === 404) {
					return null;
				}

				const data: unknown = await response.json();

				// Empty data array or null in payload represents no operational itinerary
				if (
					!data ||
					(typeof data === "object" &&
						"data" in data &&
						((data as { data: unknown }).data === null ||
							(Array.isArray((data as { data: unknown }).data) &&
								(data as { data: unknown[] }).data.length === 0)))
				) {
					return null;
				}

				return ItineraryResponseSchema.parse(data);
			} catch (error) {
				throw this.contextualize(error, `fetch itinerary for train ${trainId}`);
			}
		});
	}
}
