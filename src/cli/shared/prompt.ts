import * as readline from "node:readline/promises";

/** Ask a Y/n question on TTY. Empty input defaults to yes. */
export async function confirm(question: string): Promise<boolean> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = await rl.question(question);
		const trimmed = answer.trim().toLowerCase();
		return trimmed === "" || trimmed === "y" || trimmed === "yes";
	} finally {
		rl.close();
	}
}
