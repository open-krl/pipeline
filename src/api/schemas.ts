// src/api/schemas.ts
import * as z from "zod";

// ─── Station Master Schemas ──────────────────────────────────────────────────
const StationItemSchema = z.object({
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
const DepartureBoardItemSchema = z.object({
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
