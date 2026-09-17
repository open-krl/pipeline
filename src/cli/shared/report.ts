const WIDTH = 62;

export function printSection(
	title: string,
	entries: Array<[string, string]>,
): void {
	const labelWidth = Math.max(...entries.map(([label]) => label.length));
	const header = `── ${title} `;
	console.log(`\n${header}${"─".repeat(Math.max(1, WIDTH - header.length))}`);
	for (const [label, value] of entries) {
		console.log(`${label.padEnd(labelWidth)}: ${value}`);
	}
	console.log("─".repeat(WIDTH));
}
