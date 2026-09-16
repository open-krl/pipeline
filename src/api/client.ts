// src/api/client.ts
import {
	API_BASE_URL,
	API_HEADERS,
	CONCURRENCY,
	DEFAULT_TIME_WINDOW,
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
	retryBaseMs?: number;
	retryFactor?: number;
	maxRetries?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resilient HTTP client for KCI endpoints with concurrency pooling,
 * jittered exponential backoff, and Zod response validation.
 */
export class KciClient {
	readonly baseUrl: string;
	readonly fetchFn: FetchFunction;
	readonly boardSemaphore: AsyncSemaphore;
	readonly censusSemaphore: AsyncSemaphore;
	readonly retryBaseMs: number;
	readonly retryFactor: number;
	readonly maxRetries: number;

	constructor(options: KciClientOptions = {}) {
		this.baseUrl = (options.baseUrl ?? API_BASE_URL).replace(/\/+$/, "");
		this.fetchFn = options.fetchFn ?? fetch;
		this.boardSemaphore = new AsyncSemaphore(
			options.boardConcurrency ?? CONCURRENCY.captureBoards,
		);
		this.censusSemaphore = new AsyncSemaphore(
			options.censusConcurrency ?? CONCURRENCY.censusItineraries,
		);
		this.retryBaseMs = options.retryBaseMs ?? RETRY.baseMs;
		this.retryFactor = options.retryFactor ?? RETRY.factor;
		this.maxRetries = options.maxRetries ?? RETRY.maxRetries;
	}

	/**
	 * Executes an HTTP fetch with jittered exponential backoff retry.
	 */
	private async request(url: string, init?: RequestInit): Promise<Response> {
		let lastError: unknown;

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				const response = await this.fetchFn(url, {
					...init,
					headers: {
						...API_HEADERS,
						...(init?.headers ?? {}),
					},
				});

				// HTTP 429 Too Many Requests
				if (response.status === 429) {
					if (attempt === this.maxRetries) {
						throw new Error(
							`Rate limited (429) by upstream after ${attempt} retries: ${url}`,
						);
					}
					const retryAfterHeader = response.headers.get("retry-after");
					let delayMs = Math.round(
						this.retryBaseMs *
							this.retryFactor ** attempt *
							(0.8 + 0.4 * Math.random()),
					);
					if (retryAfterHeader) {
						const parsedSeconds = Number.parseInt(retryAfterHeader, 10);
						if (!Number.isNaN(parsedSeconds) && parsedSeconds > 0) {
							delayMs = parsedSeconds * 1000;
						}
					}
					await sleep(delayMs);
					continue;
				}

				// HTTP 5xx Server Errors
				if (response.status >= 500 && response.status <= 599) {
					if (attempt === this.maxRetries) {
						throw new Error(
							`Upstream server error (${response.status}) after ${attempt} retries: ${url}`,
						);
					}
					const delayMs = Math.round(
						this.retryBaseMs *
							this.retryFactor ** attempt *
							(0.8 + 0.4 * Math.random()),
					);
					await sleep(delayMs);
					continue;
				}

				return response;
			} catch (err: unknown) {
				lastError = err;
				// If this was an explicit retry-exhausted error thrown above, re-throw immediately
				if (
					err instanceof Error &&
					(err.message.startsWith("Upstream server error") ||
						err.message.startsWith("Rate limited"))
				) {
					throw err;
				}

				// Network / socket failure
				if (attempt === this.maxRetries) {
					throw new Error(
						`Network failure calling ${url} after ${attempt} retries: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}

				const delayMs = Math.round(
					this.retryBaseMs *
						this.retryFactor ** attempt *
						(0.8 + 0.4 * Math.random()),
				);
				await sleep(delayMs);
			}
		}

		throw lastError;
	}

	/**
	 * Fetches the master list of all stations from KCI (§2.1).
	 */
	async fetchStations(): Promise<StationMasterResponse> {
		const url = `${this.baseUrl}/api/krl/stations`;
		const response = await this.request(url);

		if (!response.ok) {
			throw new Error(
				`Failed to fetch stations: HTTP ${response.status} ${response.statusText}`,
			);
		}

		const data = await response.json();
		return StationMasterResponseSchema.parse(data);
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
		const url = `${this.baseUrl}/api/krl/schedules?stationid=${encodeURIComponent(
			stationId,
		)}&timefrom=${encodeURIComponent(timefrom)}&timeto=${encodeURIComponent(
			timeto,
		)}`;

		return this.boardSemaphore.run(async () => {
			const response = await this.request(url);

			if (!response.ok) {
				throw new Error(
					`Failed to fetch schedule for station ${stationId}: HTTP ${response.status} ${response.statusText}`,
				);
			}

			const data = await response.json();
			return DepartureBoardResponseSchema.parse(data);
		});
	}

	/**
	 * Fetches the complete itinerary stop list for a train, bounded by the census semaphore (§2.3).
	 * Returns null if the train does not exist or has no active schedule (HTTP 404).
	 */
	async fetchTrainSchedule(trainId: string): Promise<ItineraryResponse | null> {
		const url = `${this.baseUrl}/api/krl/train-schedule?trainid=${encodeURIComponent(
			trainId,
		)}`;

		return this.censusSemaphore.run(async () => {
			const response = await this.request(url);

			if (response.status === 404) {
				return null;
			}

			if (!response.ok) {
				throw new Error(
					`Failed to fetch itinerary for train ${trainId}: HTTP ${response.status} ${response.statusText}`,
				);
			}

			const data = await response.json();
			// Empty data array or null in payload represents no operational itinerary
			if (
				!data ||
				(Array.isArray(data.data) && data.data.length === 0) ||
				data.data === null
			) {
				return null;
			}

			return ItineraryResponseSchema.parse(data);
		});
	}
}
