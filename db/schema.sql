-- Canonical schema. Section 10: version-controlled SQL DDL is the source of truth.
-- Drizzle table definitions in src/db/tables.ts are a typed mirror; constraints live HERE only.
-- The DB is a derived, ephemeral artifact: build recreates it from scratch every run,
-- so there is no migration journal — schema.sql is applied wholesale. (Section 8)

PRAGMA journal_mode = WAL;

CREATE TABLE stations (
    sta_id      TEXT PRIMARY KEY,
    sta_name    TEXT NOT NULL,
    group_wil   INTEGER NOT NULL,
    fg_enable   INTEGER NOT NULL CHECK (fg_enable IN (0, 1)),
    lat         REAL,                                -- WGS-84 latitude (from station_coordinates.csv)
    lon         REAL,                                -- WGS-84 longitude (from station_coordinates.csv)
    first_seen  TEXT,
    last_seen   TEXT
) STRICT;

-- Ingestion batch tracking; links each run directly to its git archive payload
CREATE TABLE snapshots (
    snapshot_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date     TEXT NOT NULL,
    day_type          TEXT NOT NULL CHECK (day_type IN ('weekday', 'saturday', 'sunday', 'holiday')),
    region_scope      TEXT NOT NULL CHECK (region_scope IN ('jabodetabek', 'yogyakarta', 'all')),
    fetched_at        TEXT NOT NULL CHECK (fetched_at = strftime('%Y-%m-%dT%H:%M:%SZ', fetched_at)),
    status            TEXT NOT NULL CHECK (status IN ('complete', 'degraded')),
    timetable_version INTEGER NOT NULL,
    archive_commit    TEXT NOT NULL
) STRICT;

CREATE TABLE trips (
    timetable_version   INTEGER NOT NULL,
    trip_id             TEXT NOT NULL,     -- Full operational ID: '5022D', '5552A', '1163F'
    base_train_no       INTEGER NOT NULL,  -- Parsed base integer; indexed cross-source join key
    revision            TEXT CHECK (revision IS NULL OR length(revision) = 1),
    line_name           TEXT NOT NULL,     -- Sourced from ka_name
    route_name_raw      TEXT NOT NULL,
    headsign            TEXT NOT NULL,     -- Destination display string
    origin_station_id   TEXT REFERENCES stations(sta_id),
    dest_station_id     TEXT REFERENCES stations(sta_id),
    origin_time         TEXT NOT NULL,     -- Display 'HH:MM:SS'
    dest_time           TEXT NOT NULL,     -- Display 'HH:MM:SS'
    origin_secs         INTEGER NOT NULL,  -- Service-day seconds (supports >86400)
    dest_secs           INTEGER NOT NULL,
    total_stops         INTEGER NOT NULL,  -- Total stop events
    color               TEXT NOT NULL,     -- Line color hex
    is_fakultatif       INTEGER CHECK (is_fakultatif IN (0, 1)),
    source              TEXT NOT NULL CHECK (source IN ('itinerary', 'reconstructed')),
    itinerary_status    TEXT NOT NULL CHECK (itinerary_status IN ('200', '404', 'unprobed')),
    first_seen_snapshot INTEGER REFERENCES snapshots(snapshot_id),
    last_seen_snapshot  INTEGER REFERENCES snapshots(snapshot_id),
    PRIMARY KEY (timetable_version, trip_id)
) STRICT;

CREATE INDEX idx_trips_base ON trips (base_train_no);

-- Service calendar presence mask; pure fold over captured snapshots in active edition
CREATE TABLE trip_calendar (
    timetable_version   INTEGER NOT NULL,
    trip_id             TEXT NOT NULL,
    runs_weekday        INTEGER NOT NULL DEFAULT 0,  -- Present in ≥1 weekday capture
    runs_saturday       INTEGER NOT NULL DEFAULT 0,  -- Present in ≥1 Saturday capture
    runs_sunday         INTEGER NOT NULL DEFAULT 0,  -- Present in ≥1 Sunday capture
    captured_day_types  INTEGER NOT NULL,            -- Count of distinct day types observed at build (1 to 3)
    calendar_state      TEXT NOT NULL CHECK (calendar_state IN ('provisional', 'resolved')),
    PRIMARY KEY (timetable_version, trip_id),
    FOREIGN KEY (timetable_version, trip_id) REFERENCES trips (timetable_version, trip_id)
) STRICT;

CREATE TABLE trip_stops (
    timetable_version INTEGER NOT NULL,
    trip_id           TEXT NOT NULL,
    stop_sequence     INTEGER NOT NULL,   -- 1 = Origin; strictly ordered by itinerary array index
    station_id        TEXT NOT NULL REFERENCES stations(sta_id),
    time_raw          TEXT NOT NULL,      -- Display string 'HH:MM:SS'
    arrival_secs      INTEGER,            -- NULL at origin stop
    departure_secs    INTEGER,            -- NULL at terminus stop
    is_transit        INTEGER CHECK (is_transit IN (0, 1)),
    PRIMARY KEY (timetable_version, trip_id, stop_sequence),
    FOREIGN KEY (timetable_version, trip_id) REFERENCES trips (timetable_version, trip_id)
) STRICT;

-- National statutory holidays and cuti bersama, populated from version-controlled data/holidays.json
CREATE TABLE holidays (
    holiday_date        TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    is_collective_leave INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Quarantined entities failing identifier grammar (Inv 7) or cross-capture attribute consistency (Inv 12)
CREATE TABLE quarantined_trips (
    quarantine_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    timetable_version   INTEGER NOT NULL,
    trip_id             TEXT NOT NULL,
    day_type            TEXT CHECK (day_type IS NULL OR day_type IN ('weekday', 'saturday', 'sunday', 'holiday')),
    reason              TEXT NOT NULL CHECK (reason IN ('malformed_identifier', 'attribute_conflict', 'invariant_violation')),
    raw_payload         TEXT NOT NULL,  -- Canonical JSON payload representation of the offending entity
    discovered_in       INTEGER REFERENCES snapshots(snapshot_id),
    quarantined_at      TEXT NOT NULL CHECK (quarantined_at = strftime('%Y-%m-%dT%H:%M:%SZ', quarantined_at))
) STRICT;
