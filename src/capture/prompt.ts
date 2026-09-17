import * as readline from "node:readline/promises";

export type PromptFn = (
	question: string,
	defaultYes?: boolean,
) => Promise<boolean>;

/**
 * Standard CLI prompt helper using node:readline.
 * Non-TTY contexts fall back to the default answer.
 */
export const defaultPrompt: PromptFn = async (question, defaultYes = false) => {
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
