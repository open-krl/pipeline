// src/archive/itineraries.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveSafePath } from "../core/path";
import { itineraryPath } from "./layout";
import {
	type MultiObservationItinerary,
	MultiObservationItinerarySchema,
} from "./schemas";

export { itineraryPath as getItineraryPath };

/**
 * Reads and parses an existing MultiObservationItinerary envelope from disk.
 * Returns null if the file does not exist (ENOENT). Throws if corrupted or malformed.
 */
export async function readItineraryEnvelope(
	filePath: string,
): Promise<MultiObservationItinerary | null> {
	try {
		const content = await fs.readFile(filePath, "utf-8");
		return MultiObservationItinerarySchema.parse(JSON.parse(content));
	} catch (err) {
		if (
			err &&
			typeof err === "object" &&
			"code" in err &&
			(err as { code: string }).code === "ENOENT"
		) {
			return null;
		}
		throw new Error(
			`Failed to read or parse itinerary envelope at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Atomically writes a MultiObservationItinerary envelope to disk via temporary sibling rename.
 */
export async function writeItineraryEnvelope(
	filePath: string,
	envelope: MultiObservationItinerary,
): Promise<void> {
	MultiObservationItinerarySchema.parse(envelope);
	const dir = path.dirname(filePath);
	const filename = path.basename(filePath);
	const tmpFile = resolveSafePath(
		path.join(dir, `.tmp_${filename}_${Date.now()}`),
		dir,
	);

	await fs.writeFile(tmpFile, JSON.stringify(envelope, null, 2), "utf-8");
	await fs.rename(tmpFile, filePath);
}
