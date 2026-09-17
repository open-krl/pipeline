// src/archive/layout.ts
import * as path from "node:path";
import { resolveSafePath } from "../core/path";

/**
 * Returns safe path to version directory: <dataDir>/<version>
 */
export function versionDir(dataDir: string, version: number): string {
	const safeDataDir = resolveSafePath(dataDir);
	return resolveSafePath(path.join(safeDataDir, String(version)), safeDataDir);
}

/**
 * Returns safe path to captures root directory: <dataDir>/<version>/captures
 */
export function capturesDir(dataDir: string, version: number): string {
	const vDir = versionDir(dataDir, version);
	return resolveSafePath(path.join(vDir, "captures"), vDir);
}

/**
 * Returns safe path to specific snapshot directory: <dataDir>/<version>/captures/<snapshotId>
 */
export function snapshotDir(
	dataDir: string,
	version: number,
	snapshotId: number,
): string {
	const cDir = capturesDir(dataDir, version);
	return resolveSafePath(path.join(cDir, String(snapshotId)), cDir);
}

/**
 * Returns safe path to boards directory: <dataDir>/<version>/captures/<snapshotId>/boards
 */
export function boardsDir(
	dataDir: string,
	version: number,
	snapshotId: number,
): string {
	const sDir = snapshotDir(dataDir, version, snapshotId);
	return resolveSafePath(path.join(sDir, "boards"), sDir);
}

/**
 * Returns safe path to specific board JSON: <dataDir>/<version>/captures/<snapshotId>/boards/<stationId>.json
 */
export function boardFilePath(
	dataDir: string,
	version: number,
	snapshotId: number,
	stationId: string,
): string {
	const bDir = boardsDir(dataDir, version, snapshotId);
	return resolveSafePath(path.join(bDir, `${stationId}.json`), bDir);
}

/**
 * Returns safe path to stations catalog JSON: <dataDir>/<version>/captures/<snapshotId>/stations.json
 */
export function stationsPath(
	dataDir: string,
	version: number,
	snapshotId: number,
): string {
	const sDir = snapshotDir(dataDir, version, snapshotId);
	return resolveSafePath(path.join(sDir, "stations.json"), sDir);
}

/**
 * Returns safe path to snapshot manifest JSON: <dataDir>/<version>/captures/<snapshotId>/manifest.json
 */
export function manifestPath(
	dataDir: string,
	version: number,
	snapshotId: number,
): string {
	const sDir = snapshotDir(dataDir, version, snapshotId);
	return resolveSafePath(path.join(sDir, "manifest.json"), sDir);
}

/**
 * Returns safe path to itineraries root directory: <dataDir>/<version>/itineraries
 */
export function itinerariesDir(dataDir: string, version: number): string {
	const vDir = versionDir(dataDir, version);
	return resolveSafePath(path.join(vDir, "itineraries"), vDir);
}

/**
 * Returns safe path to specific itinerary JSON file: <itinerariesDir>/<trainId>.json
 * Train IDs with special characters (like slashes) are URL-encoded.
 */
export function itineraryPath(itinerariesDir: string, trainId: string): string {
	const safeFilename = `${encodeURIComponent(trainId)}.json`;
	return resolveSafePath(
		path.join(itinerariesDir, safeFilename),
		itinerariesDir,
	);
}

/**
 * Returns safe path to logs root directory: <baseDir>/logs
 */
export function logsDir(baseDir = process.cwd()): string {
	const safeBase = resolveSafePath(baseDir);
	return resolveSafePath(path.join(safeBase, "logs"), safeBase);
}
