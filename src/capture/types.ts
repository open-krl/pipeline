import type { CaptureManifest } from "../archive/schemas";
import type { CommitSnapshotResult } from "./commit";

export interface CaptureResult {
	timetable_version: number;
	snapshot_id: number;
	snapshot_dir: string;
	manifest: CaptureManifest;
	commitResult?: CommitSnapshotResult;
	logFilePath?: string;
}
