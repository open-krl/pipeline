// src/core/path.ts
import * as path from "node:path";

/**
 * Resolves a path relative to a base directory (defaulting to process.cwd()),
 * ensuring the resulting absolute path stays strictly within the base directory boundary.
 *
 * Neutralizes SAST Rule S2083 (Path Traversal) by guaranteeing path containment.
 *
 * @param targetPath The user-supplied or relative path to resolve and validate.
 * @param baseDir The root boundary directory (defaults to process.cwd()).
 * @returns The safe, fully-resolved absolute path.
 * @throws Error if the resolved path escapes the base directory boundary.
 */
export function resolveSafePath(
	targetPath: string,
	baseDir: string = process.cwd(),
): string {
	const resolvedBase = path.resolve(baseDir);
	const resolvedTarget = path.resolve(resolvedBase, targetPath);

	if (
		resolvedTarget !== resolvedBase &&
		!resolvedTarget.startsWith(resolvedBase + path.sep)
	) {
		throw new Error(
			`Security violation: path '${targetPath}' resolves outside permitted boundary '${resolvedBase}'`,
		);
	}

	return resolvedTarget;
}
