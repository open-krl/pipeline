// src/export/zip.ts
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { strToU8, zipSync } from "fflate";

export interface PackageZipResult {
	zipBuffer: Uint8Array;
	sha256: string;
	sizeBytes: number;
}

/**
 * Packages a dictionary of file names and string contents into a standard GTFS ZIP archive.
 */
export function createGtfsZip(files: Record<string, string>): PackageZipResult {
	const zipInput: Record<string, Uint8Array> = {};
	for (const [filename, content] of Object.entries(files)) {
		zipInput[filename] = strToU8(content);
	}

	// Use fixed DOS epoch mtime (1980-01-01) for deterministic ZIP bytes and SHA-256 digests
	const zipBuffer = zipSync(zipInput, {
		level: 9,
		mtime: new Date(1980, 0, 1),
	});
	const sha256 = crypto.createHash("sha256").update(zipBuffer).digest("hex");

	return {
		zipBuffer,
		sha256,
		sizeBytes: zipBuffer.byteLength,
	};
}

/**
 * Writes the ZIP buffer and its corresponding .sha256 file atomically to disk.
 */
export async function writeGtfsZip(
	destinationZipPath: string,
	zipBuffer: Uint8Array,
	sha256: string,
): Promise<void> {
	await fs.mkdir(path.dirname(destinationZipPath), { recursive: true });
	await fs.writeFile(destinationZipPath, zipBuffer);
	await fs.writeFile(
		`${destinationZipPath}.sha256`,
		`${sha256}  ${path.basename(destinationZipPath)}\n`,
	);
}
