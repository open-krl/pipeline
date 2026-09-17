import { errorMessage } from "./parse";

/** Wrap a command action: on failure print `<label> failed: ...` and exit(1). */
export async function runAction(
	label: string,
	action: () => Promise<void>,
): Promise<void> {
	try {
		await action();
	} catch (err) {
		console.error(`${label} failed: ${errorMessage(err)}`);
		process.exit(1);
	}
}
