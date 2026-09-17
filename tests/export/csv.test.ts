// tests/export/csv.test.ts
import { describe, expect, it } from "bun:test";
import { escapeCsvField, formatCsv } from "../../src/export/csv";

describe("src/export/csv — RFC 4180 Serializer", () => {
	it("escapes fields containing commas, quotes, and newlines", () => {
		expect(escapeCsvField("standard")).toBe("standard");
		expect(escapeCsvField(123)).toBe("123");
		expect(escapeCsvField("hello,world")).toBe('"hello,world"');
		expect(escapeCsvField('quote "test"')).toBe('"quote ""test"""');
		expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
		expect(escapeCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
		expect(escapeCsvField(null)).toBe("");
		expect(escapeCsvField(undefined)).toBe("");
	});

	it("formats empty rows with header line and CRLF", () => {
		const csv = formatCsv(["id", "name"], []);
		expect(csv).toBe("id,name\r\n");
	});

	it("formats structured rows with RFC 4180 CRLF delimiter", () => {
		const rows = [
			{ id: "MRI", name: "MANGGARAI", lat: -6.2098, lon: 106.8501 },
			{ id: "BKS", name: 'BEKASI, "CENTRAL"', lat: -6.2362, lon: 106.9987 },
		];
		const csv = formatCsv(["id", "name", "lat", "lon"], rows);
		expect(csv).toBe(
			'id,name,lat,lon\r\nMRI,MANGGARAI,-6.2098,106.8501\r\nBKS,"BEKASI, ""CENTRAL""",-6.2362,106.9987\r\n',
		);
	});
});
