// scripts/probe-user-agents.ts
import { parseArgs } from "node:util";
import { API_BASE_URL, DEFAULT_USER_AGENT } from "@/config";

interface UserAgentCandidate {
	id: string;
	label: string;
	userAgent: string;
}

interface ProbeEndpoint {
	id: string;
	name: string;
	path: string;
}

interface ProbeResult {
	endpointId: string;
	uaId: string;
	status: number | "TIMEOUT" | "ERROR";
	statusText: string;
	latencyMs: number;
	contentType: string;
	cfMitigated?: string;
	cfRay?: string;
	isTurnstileChallenge: boolean;
	errorMessage?: string;
}

const CANDIDATE_USER_AGENTS: UserAgentCandidate[] = [
	{
		id: "pipeline-default",
		label: "Pipeline Default (RFC 9110)",
		userAgent: DEFAULT_USER_AGENT,
	},
	{
		id: "generic-mozilla",
		label: "Generic Mozilla/5.0",
		userAgent: "Mozilla/5.0",
	},
	{
		id: "chrome-desktop",
		label: "Chrome 130 (Windows 10)",
		userAgent:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
	},
	{
		id: "safari-desktop",
		label: "Safari 17 (macOS Sonoma)",
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
	},
	{
		id: "firefox-desktop",
		label: "Firefox 130 (Linux)",
		userAgent:
			"Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
	},
	{
		id: "mobile-chrome",
		label: "Chrome Mobile (Android)",
		userAgent:
			"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
	},
	{
		id: "mobile-safari",
		label: "Safari Mobile (iOS)",
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
	},
	{
		id: "curl",
		label: "cURL 8.5.0",
		userAgent: "curl/8.5.0",
	},
	{
		id: "python-requests",
		label: "Python Requests 2.31",
		userAgent: "python-requests/2.31.0",
	},
	{
		id: "mobile-kai-app",
		label: "KAI Access / KRL App",
		userAgent: "KRLAccess/1.0",
	},
	{
		id: "empty-ua",
		label: "Empty / Missing UA",
		userAgent: "",
	},
];

const TARGET_ENDPOINTS: ProbeEndpoint[] = [
	{
		id: "stations",
		name: "Station Catalog",
		path: "/api/krl/stations",
	},
	{
		id: "schedules",
		name: "Station Schedule (MRI)",
		path: "/api/krl/schedules?stationid=MRI&timefrom=00:00&timeto=23:59",
	},
	{
		id: "train-schedule",
		name: "Train Itinerary (5022D)",
		path: "/api/krl/train-schedule?trainid=5022D",
	},
];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeSingle(
	baseUrl: string,
	endpoint: ProbeEndpoint,
	candidate: UserAgentCandidate,
	timeoutMs: number,
): Promise<ProbeResult> {
	const url = `${baseUrl.replace(/\/+$/, "")}${endpoint.path}`;
	const headers: Record<string, string> = {
		Accept: "application/json, text/plain, */*",
		Referer: "https://www.kci.id/",
	};

	if (candidate.userAgent) {
		headers["User-Agent"] = candidate.userAgent;
	}

	const startTime = performance.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, {
			method: "GET",
			headers,
			signal: controller.signal,
		});

		const latencyMs = Math.round(performance.now() - startTime);
		const contentType = response.headers.get("content-type") ?? "unknown";
		const cfMitigated = response.headers.get("cf-mitigated") ?? undefined;
		const cfRay = response.headers.get("cf-ray") ?? undefined;

		let isTurnstileChallenge = false;
		if (response.status === 403 || cfMitigated === "challenge") {
			const bodyText = await response.text();
			isTurnstileChallenge =
				bodyText.includes("Just a moment...") ||
				bodyText.includes("challenges.cloudflare.com");
		}

		return {
			endpointId: endpoint.id,
			uaId: candidate.id,
			status: response.status,
			statusText: response.statusText,
			latencyMs,
			contentType,
			cfMitigated,
			cfRay,
			isTurnstileChallenge,
		};
	} catch (error) {
		const latencyMs = Math.round(performance.now() - startTime);
		const isTimeout =
			error instanceof Error &&
			(error.name === "AbortError" || error.name === "TimeoutError");

		return {
			endpointId: endpoint.id,
			uaId: candidate.id,
			status: isTimeout ? "TIMEOUT" : "ERROR",
			statusText: isTimeout ? "Request Aborted/Timeout" : "Network Error",
			latencyMs,
			contentType: "none",
			isTurnstileChallenge: false,
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timer);
	}
}

async function main() {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			endpoint: { type: "string" },
			pacing: { type: "string" },
			timeout: { type: "string" },
			json: { type: "boolean" },
		},
		strict: true,
	});

	const pacingMs = values.pacing ? Number.parseInt(values.pacing, 10) : 500;
	const timeoutMs = values.timeout
		? Number.parseInt(values.timeout, 10)
		: 10000;
	const isJson = values.json ?? false;

	const endpoints = values.endpoint
		? TARGET_ENDPOINTS.filter((e) =>
				e.id.toLowerCase().includes(values.endpoint!.toLowerCase()),
			)
		: TARGET_ENDPOINTS;

	if (endpoints.length === 0) {
		console.error(`Unknown endpoint filter: "${values.endpoint}"`);
		console.error(
			`Available endpoints: ${TARGET_ENDPOINTS.map((e) => e.id).join(", ")}`,
		);
		process.exit(1);
	}

	if (!isJson) {
		console.log(
			`🔍 Starting User-Agent probe against KCI API (${API_BASE_URL})`,
		);
		console.log(
			`  Endpoints: ${endpoints.map((e) => e.id).join(", ")} | Candidates: ${CANDIDATE_USER_AGENTS.length}`,
		);
		console.log(`  Pacing: ${pacingMs}ms | Timeout: ${timeoutMs}ms\n`);
	}

	const results: ProbeResult[] = [];

	for (const endpoint of endpoints) {
		if (!isJson) {
			console.log(`📡 Probing Endpoint: [${endpoint.name}] (${endpoint.path})`);
		}

		for (const candidate of CANDIDATE_USER_AGENTS) {
			const res = await probeSingle(
				API_BASE_URL,
				endpoint,
				candidate,
				timeoutMs,
			);
			results.push(res);

			if (!isJson) {
				const statusBadge =
					res.status === 200
						? "✅ 200 OK"
						: res.status === 403
							? res.isTurnstileChallenge
								? "🛑 403 (CF Turnstile Challenge)"
								: "🚫 403 Forbidden"
							: res.status === 429
								? "⏳ 429 Rate Limited"
								: `⚠️  ${res.status}`;

				const cfInfo = res.cfRay ? `[CF-Ray: ${res.cfRay}]` : "";
				console.log(
					`   ${candidate.label.padEnd(28)} -> ${statusBadge.padEnd(35)} (${res.latencyMs}ms) ${cfInfo}`,
				);
			}

			if (pacingMs > 0) {
				await sleep(pacingMs);
			}
		}

		if (!isJson) {
			console.log("");
		}
	}

	if (isJson) {
		console.log(JSON.stringify(results, null, 2));
		return;
	}

	// Print summary statistics
	const total = results.length;
	const passed200 = results.filter((r) => r.status === 200).length;
	const forbidden403 = results.filter((r) => r.status === 403).length;
	const turnstileCount = results.filter((r) => r.isTurnstileChallenge).length;
	const rateLimited429 = results.filter((r) => r.status === 429).length;
	const errors = results.filter(
		(r) => r.status === "ERROR" || r.status === "TIMEOUT",
	).length;

	console.log("=".repeat(60));
	console.log("PROBE SUMMARY");
	console.log("=".repeat(60));
	console.log(`Total Requests Sent : ${total}`);
	console.log(`Successful (200 OK)  : ${passed200}`);
	console.log(
		`Forbidden (403)      : ${forbidden403} (${turnstileCount} Cloudflare Turnstile managed challenges)`,
	);
	console.log(`Rate-limited (429)   : ${rateLimited429}`);
	console.log(`Network/Timeout Errors: ${errors}`);
	console.log("=".repeat(60));

	if (passed200 > 0) {
		console.log("\n💡 Working User-Agents:");
		const successfulUaIds = new Set(
			results.filter((r) => r.status === 200).map((r) => r.uaId),
		);
		for (const uaId of successfulUaIds) {
			const candidate = CANDIDATE_USER_AGENTS.find((c) => c.id === uaId);
			if (candidate) {
				console.log(`   - ${candidate.label}: "${candidate.userAgent}"`);
			}
		}
	} else if (turnstileCount > 0) {
		console.log(
			"\n⚠️  All or most tested requests triggered Cloudflare Turnstile / Managed Challenges.",
		);
		console.log(
			"   This usually indicates IP reputation / ASN filtering or TLS fingerprint mismatch at the Cloudflare edge,",
		);
		console.log("   independent of the specific User-Agent string provided.");
	}
}

main().catch((err) => {
	console.error("❌ Fatal error running user-agent probe:", err);
	process.exit(1);
});
