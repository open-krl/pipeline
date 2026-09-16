// src/core/trainid.ts

/**
 * Identifier Grammar (§4.1):
 * Matches base train number, optional revision letter (A-E), and optional fakultatif flag (F).
 */
export const TRAIN_ID_GRAMMAR = /^(\d+)([A-E])?(F)?$/;

export interface ParsedTrainId {
	trip_id: string;
	base_train_no: number;
	revision: string | null;
	is_fakultatif: boolean;
}

/**
 * Parses an operational train identifier into structured components.
 * Returns null if the identifier violates the grammar (enabling quarantine isolation).
 */
export function parseTrainId(rawId: string): ParsedTrainId | null {
	if (typeof rawId !== "string") {
		return null;
	}

	const match = TRAIN_ID_GRAMMAR.exec(rawId.trim());
	if (!match) {
		return null;
	}

	const [, baseStr, revision, fakultatif] = match;
	const baseNum = Number.parseInt(baseStr, 10);
	if (Number.isNaN(baseNum) || baseNum <= 0) {
		return null;
	}

	return {
		trip_id: rawId.trim(),
		base_train_no: baseNum,
		revision: revision ?? null,
		is_fakultatif: fakultatif === "F",
	};
}
