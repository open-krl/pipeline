import { sqliteTable, text, integer, real, primaryKey, index } from "drizzle-orm/sqlite-core";

export const stations = sqliteTable("stations", {
  sta_id: text("sta_id").primaryKey(),
  sta_name: text("sta_name").notNull(),
  group_wil: integer("group_wil").notNull(),
  fg_enable: integer("fg_enable").notNull(),
  lat: real("lat"),
  lon: real("lon"),
  first_seen: text("first_seen"),
  last_seen: text("last_seen"),
});

export const snapshots = sqliteTable("snapshots", {
  snapshot_id: integer("snapshot_id").primaryKey({ autoIncrement: true }),
  snapshot_date: text("snapshot_date").notNull(),
  day_type: text("day_type").notNull(),
  region_scope: text("region_scope").notNull(),
  fetched_at: text("fetched_at").notNull(),
  status: text("status").notNull(),
  timetable_version: integer("timetable_version").notNull(),
  archive_commit: text("archive_commit").notNull(),
});

export const trips = sqliteTable("trips", {
  timetable_version: integer("timetable_version").notNull(),
  trip_id: text("trip_id").notNull(),
  base_train_no: integer("base_train_no").notNull(),
  revision: text("revision"),
  line_name: text("line_name").notNull(),
  route_name_raw: text("route_name_raw").notNull(),
  headsign: text("headsign").notNull(),
  origin_station_id: text("origin_station_id"),
  dest_station_id: text("dest_station_id"),
  origin_time: text("origin_time").notNull(),
  dest_time: text("dest_time").notNull(),
  origin_secs: integer("origin_secs").notNull(),
  dest_secs: integer("dest_secs").notNull(),
  total_stops: integer("total_stops").notNull(),
  color: text("color").notNull(),
  is_fakultatif: integer("is_fakultatif"),
  source: text("source").notNull(),
  itinerary_status: text("itinerary_status").notNull(),
  first_seen_snapshot: integer("first_seen_snapshot"),
  last_seen_snapshot: integer("last_seen_snapshot"),
}, (t) => [
  primaryKey({ columns: [t.timetable_version, t.trip_id] }),
  index("idx_trips_base").on(t.base_train_no),
]);

export const tripCalendar = sqliteTable("trip_calendar", {
  timetable_version: integer("timetable_version").notNull(),
  trip_id: text("trip_id").notNull(),
  runs_weekday: integer("runs_weekday").notNull().default(0),
  runs_saturday: integer("runs_saturday").notNull().default(0),
  runs_sunday: integer("runs_sunday").notNull().default(0),
  captured_day_types: integer("captured_day_types").notNull(),
  calendar_state: text("calendar_state").notNull(),
}, (t) => [
  primaryKey({ columns: [t.timetable_version, t.trip_id] }),
]);

export const tripStops = sqliteTable("trip_stops", {
  timetable_version: integer("timetable_version").notNull(),
  trip_id: text("trip_id").notNull(),
  stop_sequence: integer("stop_sequence").notNull(),
  station_id: text("station_id").notNull(),
  time_raw: text("time_raw").notNull(),
  arrival_secs: integer("arrival_secs"),
  departure_secs: integer("departure_secs"),
  is_transit: integer("is_transit"),
}, (t) => [
  primaryKey({ columns: [t.timetable_version, t.trip_id, t.stop_sequence] }),
]);

export const holidays = sqliteTable("holidays", {
  holiday_date: text("holiday_date").primaryKey(),
  name: text("name").notNull(),
  is_collective_leave: integer("is_collective_leave").notNull().default(0),
});

export const quarantinedTrips = sqliteTable("quarantined_trips", {
  quarantine_id: integer("quarantine_id").primaryKey({ autoIncrement: true }),
  timetable_version: integer("timetable_version").notNull(),
  trip_id: text("trip_id").notNull(),
  day_type: text("day_type"),
  reason: text("reason").notNull(),
  raw_payload: text("raw_payload").notNull(),
  discovered_in: integer("discovered_in"),
  quarantined_at: text("quarantined_at").notNull(),
});
