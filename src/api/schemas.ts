// src/api/schemas.ts
import * as z from "zod";

// ─── Station Master Schemas ──────────────────────────────────────────────────
export const StationItemSchema = z.object({
	sta_id: z.string().min(1),
	sta_name: z.string().min(1),
	group_wil: z.number().int(),
	fg_enable: z.literal([0, 1]),
});
export type StationItem = z.infer<typeof StationItemSchema>;

export const StationMasterResponseSchema = z.object({
	status: z.literal(200),
	message: z.string().optional(),
	data: z.array(StationItemSchema),
});
export type StationMasterResponse = z.infer<typeof StationMasterResponseSchema>;

// ─── Departure Board Schemas ─────────────────────────────────────────────────
export const DepartureBoardItemSchema = z.object({
	train_id: z.string().min(1),
	ka_name: z.string().min(1),
	route_name: z.string().min(1),
	dest: z.string().min(1),
	time_est: z
		.string()
		.regex(/^\d{2}:\d{2}:\d{2}$/, { error: "Expected HH:MM:SS" }),
	color: z.string().min(1),
	dest_time: z
		.string()
		.regex(/^\d{2}:\d{2}:\d{2}$/, { error: "Expected HH:MM:SS" }),
});
export type DepartureBoardItem = z.infer<typeof DepartureBoardItemSchema>;

export const DepartureBoardResponseSchema = z.object({
	status: z.literal(200),
	data: z.array(DepartureBoardItemSchema),
});
export type DepartureBoardResponse = z.infer<
	typeof DepartureBoardResponseSchema
>;

// ─── Train Itinerary Schemas ─────────────────────────────────────────────────
export const ItineraryStopSchema = z.object({
	train_id: z.string().min(1),
	ka_name: z.string().min(1),
	station_id: z.string().min(1),
	station_name: z.string().min(1),
	time_est: z
		.string()
		.regex(/^\d{2}:\d{2}:\d{2}$/, { error: "Expected HH:MM:SS" }),
	transit_station: z.boolean(),
	color: z.string().min(1),
	transit: z.union([z.string(), z.array(z.string())]),
});
export type ItineraryStop = z.infer<typeof ItineraryStopSchema>;

export const ItineraryResponseSchema = z.object({
	status: z.literal(200),
	data: z.array(ItineraryStopSchema),
});
export type ItineraryResponse = z.infer<typeof ItineraryResponseSchema>;

// ─── Multi-Observation Itinerary Storage Schema (§8.3) ──────────────────────
export const DayTypeSchema = z.enum([
	"weekday",
	"saturday",
	"sunday",
	"holiday",
]);
export type DayType = z.infer<typeof DayTypeSchema>;

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
	observations: z.record(DayTypeSchema, ItineraryObservationSchema),
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

// ─── Holiday File Schema ─────────────────────────────────────────────────────
export const HolidayItemSchema = z.object({
	holiday_date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Expected YYYY-MM-DD" }),
	name: z.string().min(1),
	is_collective_leave: z.boolean(),
});
export type HolidayItem = z.infer<typeof HolidayItemSchema>;

export const HolidayFileSchema = z.array(HolidayItemSchema);
