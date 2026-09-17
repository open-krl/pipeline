#!/usr/bin/env bun
import { cac } from "cac";
import { registerBuildCommand } from "./commands/build";
import { registerCalendarCommand } from "./commands/calendar";
import { registerCaptureCommand } from "./commands/capture";
import { registerCensusCommand } from "./commands/census";
import { registerCommitSnapshotCommand } from "./commands/commit-snapshot";
import { registerDetectCommand } from "./commands/detect";
import { registerDiffCommand } from "./commands/diff";
import { registerExportCommand } from "./commands/export";
import { registerListSnapshotsCommand } from "./commands/list-snapshots";
import { errorMessage } from "./shared/parse";

export function createCli() {
	const cli = cac("krl");

	registerCaptureCommand(cli);
	registerCommitSnapshotCommand(cli);
	registerListSnapshotsCommand(cli);
	registerCensusCommand(cli);
	registerBuildCommand(cli);
	registerExportCommand(cli);
	registerDiffCommand(cli);
	registerCalendarCommand(cli);
	registerDetectCommand(cli);

	cli.help();
	cli.version("0.1.0");

	return cli;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
	const cli = createCli();
	try {
		cli.parse(argv, { run: false });

		if (cli.options.help || cli.options.version) {
			return;
		}

		if (!cli.matchedCommand) {
			if (cli.args.length > 0) {
				console.error(
					`Unknown command: '${cli.args[0]}'. Use --help for usage.`,
				);
				process.exit(1);
			}
			cli.outputHelp();
			process.exit(0);
		}

		await cli.runMatchedCommand();
	} catch (error) {
		console.error(`Error: ${errorMessage(error)}`);
		process.exit(1);
	}
}

if (import.meta.main) {
	runCli();
}
