import type { CAC } from "cac";
import { executeDiff } from "@/diagnostic/cli-diff";
import { runAction } from "../shared/run";

interface DiffOptions {
	dataDir?: string;
	v1?: number | string;
	v2?: number | string;
	train?: string | string[];
	dayType?: string;
	detail?: boolean;
	git?: boolean;
}

/** cac passes positional args + options object as variadic action args. */
function extractArgs(actionArgs: unknown[]): {
	args: string[];
	options: DiffOptions;
} {
	const options = (actionArgs[actionArgs.length - 1] ?? {}) as DiffOptions;
	const args: string[] = [];
	for (const a of actionArgs.slice(0, -1)) {
		if (Array.isArray(a)) {
			for (const item of a) {
				if (typeof item === "string") args.push(item);
			}
		} else if (typeof a === "string") {
			args.push(a);
		}
	}
	return { args, options };
}

export function registerDiffCommand(cli: CAC): void {
	cli
		.command(
			"diff [...snapshots]",
			"Diff station catalogs, departure boards, or train itineraries (§8.1, §9)",
		)
		.option("--data-dir <path>", "Override raw data root directory", {
			default: "data/raw",
		})
		.option("--v1 <version>", "First timetable version to compare")
		.option("--v2 <version>", "Second timetable version to compare")
		.option(
			"--train <trainIds...>",
			"Trip IDs to diff itineraries (e.g. --train 5022D 5022E)",
		)
		.option("--day-type <type>", "Target day type for itinerary comparison")
		.option(
			"--detail",
			"Display full station-by-station and stop-by-stop listings",
		)
		.option(
			"--git",
			"Display raw git diff across snapshot directories (or boards)",
		)
		.action(async (...actionArgs: unknown[]) => {
			const { args, options } = extractArgs(actionArgs);
			await runAction("Diff", () => executeDiff(args, options));
		});
}
