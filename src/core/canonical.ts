// src/core/canonical.ts
import { createHash } from "node:crypto";

/**
 * Deterministically serializes any JavaScript object or value to JSON.
 * - Object keys are recursively sorted alphabetically.
 * - Array element ordering is strictly preserved (§8 contract).
 * - Primitives and nulls are serialized consistently via JSON.stringify.
 */
export function canonicalSerialize(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}

	if (Array.isArray(value)) {
		const items = value.map((item) => canonicalSerialize(item));
		return `[${items.join(",")}]`;
	}

	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const pairs = keys
		.filter((key) => record[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`);

	return `{${pairs.join(",")}}`;
}

/**
 * Computes a SHA-256 hex string digest of the input UTF-8 string.
 */
export function sha256(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Computes the canonical SHA-256 digest of an arbitrary data structure.
 */
export function payloadHash(value: unknown): string {
	return sha256(canonicalSerialize(value));
}
