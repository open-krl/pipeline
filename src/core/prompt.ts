// src/core/prompt.ts
import * as readline from "node:readline/promises";

export type PromptFn = (
	question: string,
	defaultYes?: boolean,
) => Promise<boolean>;

/**
 * Interactive yes/no confirmation. Empty input accepts the default.
 * Non-TTY contexts (piped stdin, CI without a terminal) return the
 * default answer instead of hanging on stdin.
 */
export const confirm: PromptFn = async (question, defaultYes = false) => {
	if (!process.stdin.isTTY) {
		return defaultYes;
	}
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = await rl.question(
			`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `,
		);
		const trimmed = answer.trim().toLowerCase();
		if (trimmed === "") return defaultYes;
		return trimmed === "y" || trimmed === "yes";
	} finally {
		rl.close();
	}
};
