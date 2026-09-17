// src/archive/schemas.ts
import * as z from "zod";
import { ItineraryStopSchema } from "../api/schemas";
import {
	type DayType,
	DayTypeSchema,
	HolidayFileSchema,
	type HolidayItem,
	HolidayItemSchema,
} from "../core/calendar";

export type { DayType, HolidayItem };
export { DayTypeSchema, HolidayFileSchema, HolidayItemSchema };

// ─── Multi-Observation Itinerary Storage Schema (§8.3) ──────────────────────
export const ItineraryObservationSchema = z.object({
	fetched_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, {
		error: "Expected ISO-8601 UTC timestamp",
	}),
	payload_hash: z
		.string()
		.length(64, { error: "Expected 64-char SHA-256 hex digest" }),
	stops: z.array(ItineraryStopSchema),
});
export type ItineraryObservation = z.infer<typeof ItineraryObservationSchema>;

export const MultiObservationItinerarySchema = z.object({
	train_id: z.string().min(1),
	observations: z.partialRecord(DayTypeSchema, ItineraryObservationSchema),
});
export type MultiObservationItinerary = z.infer<
	typeof MultiObservationItinerarySchema
>;

// ─── Manifest Contract Schema (§8.2) ─────────────────────────────────────────
export const CaptureManifestSchema = z.object({
	timetable_version: z.number().int().positive(),
	snapshot_id: z.number().int().positive(),
	snapshot_date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Expected YYYY-MM-DD" }),
	day_type: DayTypeSchema,
	region_scope: z.enum(["jabodetabek", "yogyakarta", "all"]),
	station_master_hash: z.string().length(64),
	board_response_hash: z.string().length(64),
	fetched_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, {
		error: "Expected ISO-8601 UTC timestamp",
	}),
	status: z.enum(["complete", "degraded"]),
});
export type CaptureManifest = z.infer<typeof CaptureManifestSchema>;
