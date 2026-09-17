// src/export/csv.ts

/**
 * Escapes a single field according to RFC 4180:
 * - If the value contains comma, quote, or newline, wrap in double quotes and escape internal quotes as "".
 */
export function escapeCsvField(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	const str = String(value);
	if (
		str.includes(",") ||
		str.includes('"') ||
		str.includes("\n") ||
		str.includes("\r")
	) {
		return `"${str.replaceAll('"', '""')}"`;
	}
	return str;
}

/**
 * Serializes an array of records into standard RFC 4180 CSV string with CRLF line endings.
 */
export function formatCsv<T>(columns: (keyof T & string)[], rows: T[]): string {
	const headerLine = columns.map(escapeCsvField).join(",");
	const dataLines = rows.map((row) =>
		columns
			.map((col) => escapeCsvField((row as Record<string, unknown>)[col]))
			.join(","),
	);

	if (dataLines.length === 0) {
		return `${headerLine}\r\n`;
	}

	return `${headerLine}\r\n${dataLines.join("\r\n")}\r\n`;
}
