# Design & Discovery Document — KRL Schedule Database

**Version:** 1.1  
---

## 1. Purpose & Deliverables

Ingest the current Kereta Commuter Indonesia (KRL) timetable edition from KCI's station-centric REST API into a normalized relational database, producing:

1. **Relational core** — stations, trips, and ordered stop-time sequences.
2. **Service calendar** per trip — resolved strictly via empirical set-difference across day-type captures (weekday, Saturday, Sunday) cross-referenced with national holidays.
3. **GTFS-compatible export** — `routes`, `trips`, `stop_times`, `calendar`, and `calendar_dates` (transfers deferred).
4. **Raw-response archive** — a deterministic, versioned snapshot archive of the upstream API responses (the API provides no revision history; our raw archive constitutes the permanent record of this edition).
5. **Export validation report** — integrity audit covering graph completeness, dead-band enforcement, sequence monotonicity, and calendar masks.

### Scope Boundaries
* **In Scope (v1.1):** Three day-type captures (weekday, Saturday, Sunday), a single enrichment census, offline validation/build pipeline, and GTFS export.
  - **Regional Scope:** Active initial scope is `jabodetabek` (`group_wil: 0`, covering 94 operational stations across Jabodetabek and the Merak branch).
  - **Yogyakarta–Solo Readiness:** The Yogyakarta–Solo & Prameks network (`group_wil: 6`, 17 stations) is fully supported by the API and schema, but decoupled via modular `region_scope` configuration to prevent cross-network invariant failure.
* **Dropped / Out of Scope:** PDF timetable schedule reconciliation and text-layer scraping. PDF timetable extraction has been dropped due to fragile layout formatting, manual publishing discrepancies, and high parsing maintenance overhead. The operational API is the sole source of truth.
* **Deferred:** Cloudflare D1 serving deployment and automated transfer graph generation (`transfers.txt`).

---

## 2. Source System: The API

The upstream system exposes three core HTTP JSON endpoints:
- **Base URL:** `https://www.kci.id`.
- **Network Headers:** Standard browser headers bypass gateway bot-management challenges:
  ```http
  User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
  Accept: application/json, text/plain, */*
  Referer: https://www.kci.id/
  ```
- **Response Envelope:** Standard JSON wrapper: `{ "status": 200, "data": [...] }` (with an optional `"message": "Success"` on station master).

```
                      ┌────────────────────────┐
                      │   GET /api/krl/stations│
                      └───────────┬────────────┘
                                  │ Station Master
                                  ▼
           ┌──────────────────────────────────────────────┐
           │ For each valid sta_id in active region_scope:│
           │ GET /api/krl/schedules?stationid={id}&...    │
           └──────────────────────┬───────────────────────┘
                                  │ Station Boards (Full Day Window)
                                  ▼
                     [ Discovered Train IDs ]
                                  │
                                  ▼
           ┌──────────────────────────────────────────────┐
           │ For each unique operational train_id:        │
           │ GET /api/krl/train-schedule?trainid={id}     │
           └──────────────────────┬───────────────────────┘
                                  │ Complete Itineraries
                                  ▼
                    [ Normalized Relational DB ]
```

### 2.1 `GET /api/krl/stations`
Station master catalog. Envelope: `{ status: 200, message: "Success", data: [...] }`. Fields: `sta_id`, `sta_name`, `group_wil`, `fg_enable`.

- **Regional Grouping (`group_wil`):** The upstream system cleanly partitions physical networks via `group_wil`:
  - `group_wil = 0`: Jabodetabek and Merak line stations (94 physical stations).
  - `group_wil = 6`: Yogyakarta–Solo and Kutoarjo Prameks stations (17 physical stations).
- **Ingestion Filter:** `sta_id NOT LIKE 'WIL%' AND group_wil IN (:allowed_groups)`. Rows starting with `WIL*` (`WIL0` Jabodetabek, `WIL1` Merak, `WIL6` Yogyakarta) represent regional dropdown section headers with `fg_enable=0`, not physical stations.
- **Physical Station Ingestion Rule:** Do **not** filter out `fg_enable=0`. Station `SG` ("SERANG") is flagged with `fg_enable=0` in the station master despite being fully operational (14 daily departures and active stops on Merak line itineraries). Restricting ingestion to `fg_enable=1` drops Serang and breaks referential integrity on Merak corridor trips.
- **Modular Scope Configuration:** By parameterizing the active scope (`region_scope`), `capture` queries 94 stations for Jabodetabek+Merak without touching Yogyakarta. Expanding to Yogyakarta later is a 1-line configuration update (`allowed_groups: [0, 6]`), with zero architectural rework.

### 2.2 `GET /api/krl/schedules?stationid=&timefrom=&timeto=`
Station departures board for a requested time window (`HH:MM`). Setting `timefrom=00:00&timeto=23:59` returns the complete repeating timetable pattern for that station in a single request. Envelope: `{ status: 200, data: [...] }`.

Fields per row: `train_id`, `ka_name`, `route_name`, `dest`, `time_est`, `color`, `dest_time`.

- `time_est`: Scheduled departure time at the queried station, formatted as `HH:MM:SS` (seconds are strictly `:00` across all board departures).
- `dest_time`: Scheduled arrival time at the terminus, formatted as `HH:MM:SS` (seconds are strictly `:00`).
- `ka_name`: Commercial corridor branding (e.g., `"COMMUTER LINE CIKARANG"`, `"COMMUTER LINE BOGOR"`, `"COMMUTER LINE RANGKASBITUNG"`, `"COMMUTERLINE MERAK"`).
- **Trip-Level Consistency:** `dest`, `dest_time`, `route_name`, `color`, and `ka_name` are identical across every station board row for a given `train_id`. These denormalized trip-level values serve as both validation invariants and reference anchors for midnight-wrap detection.
- **Departure-Only Boards:** Station boards publish departures only. A train terminating at station $X$ does *not* appear on station $X$'s board as an arrival (`dest == sta_name` yields 0 rows across all stations). Terminus arrival times must be sourced from upstream `dest_time` entries or from the train's full itinerary.
- **Sorting & Ties:** Boards are sorted by departure time with occasional exact ties (e.g., dual departures at Bekasi: 06:10, 08:03, 09:07, 17:52). Deterministic tie-breaking requires sorting by `time_est`, then `train_id`.
- **Exhaustive Discovery:** Boards are complete by construction: a train absent from a station's board does not call at that station. Aggregating all station boards provides a complete census of all active trips.

### 2.3 `GET /api/krl/train-schedule?trainid=`
Full, ordered itinerary for a specific train. Requires the **exact operational ID including any letter suffixes** (`5552` yields 404; `5552A` yields 200). Envelope: `{ status: 200, data: [...] }`.

Response: Ordered array, origin to terminus, both endpoints inclusive:
`station_id`, `station_name`, `time_est`, `transit_station` (bool), `color`, `transit` (`""` when empty; array of hex strings `["#ff8095", "#0000ff"]` when populated).

- **Sub-Minute Granularity:** Unlike station boards that truncate to whole minutes (`:00`), itinerary `time_est` values contain exact seconds (e.g., `15:41:30` at Rajawali for `5552A`).
- **Stop Sequence:** Array order is authoritative; it is the sole ground truth for physical stop sequence.
- **Display Metadata:** `transit` utilizes a legacy color palette unrelated to primary corridor colors; flags indicate interchange points for candidate transfer generation.

### 2.4 Behavioral Profile & Operating Model

- **No Live Day State:** The API exposes a static timetable document rather than a live-day feed. Rows contain no calendar dates, and the post-midnight departures (00:02–01:04) sit permanently at the head of every daily query.
- **System Overhead:** Endpoints exhibit an invariant 5–10 second latency per request regardless of parameter windowing, reflecting gateway and proxy overhead rather than backend query execution time.
- **Concurrency & Fan-Out:** Station-board fan-outs (~85 operational stations) and train-itinerary censuses (~1,000–1,500 trains) must run under controlled concurrency with persistent, resumable raw-file caching.

---

## 3. Reverse-Engineered Upstream Backend

Understanding the upstream data model allows us to predict edge-case behaviors and design resilient schemas:

```
┌────────────────────────────────────────────────────────┐
│ Inferred Upstream Architecture                         │
│                                                        │
│  stations                                              │
│  (sta_id, sta_name, group_wil, fg_enable)              │
│       │                                                │
│       ├─────────────────────────┐                      │
│       ▼                         ▼                      │
│  trips                     trip_stops                  │
│  (train_id [PK], ka_name,  (train_id [FK], seq,        │
│   route_name, dest,         station_id [FK], time_est, │
│   dest_time, color)         transit_flags)             │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### Inferred Tables
1. **`stations(sta_id, sta_name, group_wil, fg_enable)`**: Mirrors `GET /api/krl/stations`. Because `fg_enable=0` is used for dropdown separators and select stations, this table acts as both operational data and UI rendering configuration.
2. **`trips(train_id PK, ka_name, route_name, dest, dest_time, color)`**: Denormalized trip attributes return identically across all station board appearances, confirming they are stored once per trip and joined on query.
3. **`trip_stops(train_id, seq, station_id, time_est, transit flags)`**: Itineraries represent pre-sorted stop lists. Station boards represent view queries over `trip_stops` filtered by station and time window.

### Inferred Architectural Behaviors
- **Exact Operational Primary Key:** Upstream keys trips by full `train_id` (including operational suffixes). Re-lettering a trip (e.g., `5022C` $\to$ `5022D`) is an in-place replacement or insertion under a new key.
- **Heterogeneous Systems:** Itinerary serialization (`transit: "" | []`, legacy hex codes) differs substantially from station boards, indicating two distinct backend services or views querying different historical schemas.
- **Replace-in-Place Timetable Editions:** Revisions overwrite existing records without historical versioning. Archiving the raw responses is the only way to preserve a record of any timetable edition.

---

## 4. Domain Model

### 4.1 Train Identity: The Base-Number Model
Operational train identifiers are composed of a structural base number and operational revision/type markers:

```
                  Operational Identifier: 5022D
                  ┌─────────────────┬───┐
                  │      5022       │ D │
                  └────────┬────────┴─┬─┘
                           │          │
           Base Train Number          Operational Suffix
           (Persistent Identity)      (Schedule Revision)
```

| Train Base | Observed Revision | Operational Variant | Stop Profile |
|---|---|---|---|
| 5195 | `5195` | Base Schedule | Standard Run |
| 5022 | `5022D` | Operational Revision D | Standard Run |
| 5552 | `5552A` | Operational Revision A | Loop Branch Variant |

**Rules of Identity:**
1. **Base Number as Identity:** The base number represents the persistent identity of the service path. Suffix letters represent operational iterations or timetable revisions and convey no intrinsic schedule difference.
2. **Cross-Capture Identity Matching:** Identity across distinct capture runs or timetable versions cannot rely solely on raw suffix matching. Joins and path tracking utilize the **fingerprint**:
   $$\text{Fingerprint} = (\text{base\_train\_no}, \text{origin\_station}, \text{dest\_station}, \text{arrival\_time} \pm \text{tolerance})$$
3. **Identifier Grammar:** 100% of discovered IDs must conform to:
   $$\verb|^(\d+)([A-E])?(F)?$|$$
   Extracting `base_train_no`, `revision`, and optional `F` (fakultatif) flag. Any non-conforming identifier must be quarantined immediately.
4. **Permissible Revision Drift:** Across captures of the same timetable edition, suffix transitions for identical service paths must advance conservatively (e.g., Base $\to$ A, A $\to$ B). Sudden jumps or erratic mutations signal renumbered services requiring verification.

### 4.2 The Service Day & Time Arithmetic
The KRL operational day spans approximately 04:00 to 01:30 the following calendar morning. At Bekasi (BKS), for example, the observed operational dead band spans **01:04 to 04:12**, with the first morning departure at 04:12 and late-night trips departing between 00:02 and 01:04.

```
00:00        01:30                  04:00                                 24:00        25:30
  ├─── Tail ───┤────── Dead Band ─────├── Morning Peak ── Afternoon ── Night ──┼─── Tail ───┤
  │ (00:02-01:04)                     │ (04:12...)                             │ (24:02-25:04)
  └───────────────────────────────────┴────────────────────────────────────────┴────────────┘
  ▲ Clock Times < 03:30 mapped to Service Day Seconds (> 86,400)               ▲
```

- **Dead-Band Rule:** Clock departures between 00:00:00 and 03:30:00 belong to the previous calendar day's service pattern.
- **Service-Day Seconds:** Times are converted to integer seconds elapsed since the start of the service day ($00:00:00 = 0$). Clock times strictly below the dead-band cutoff ($< 12,600\text{ s}$) have $86,400\text{ s}$ added, transforming late-night tail runs into continuous offsets ($> 86,400\text{ s}$ / $> 24:00:00$).
- **Monotonic Array Walk:** For full itineraries, wrap detection operates via a sequential walk: if stop $i$ has $\text{time\_est} < \text{time\_est}_{i-1}$, it has crossed midnight and increments its day offset. (Identical consecutive times represent scheduled dwell, not a wrap).

### 4.3 `route_name` Parsing and Physical Routing
The API publishes route designations using concatenated tokens: `ORIGIN-TERMINUS[ VIA X]` (e.g., `KAMPUNGBANDAN-CIKARANG VIA PSE`).

- **Origin Station Extraction:** Origin station names can be extracted directly from the route prefix. Whitespace-stripped station matching (`sta_name.replace(/\s+/g, '')`) successfully matches 100% of origin and destination tokens across all observed patterns.
- **Routing Variants are Load-Bearing:** Route variants (`VIA X`) represent distinct physical paths that must be mapped to distinct GTFS patterns. For example, Bekasi to Kampung Bandan via Manggarai takes 59–63 minutes, whereas the path via Pasar Senen (`VIA PSE`) takes 45 minutes; unlabelled variants take the City Line (Rajawali–Kemayoran–Kramat).

```
   ┌────────────────────── via Pasar Senen (PSE) [45 min] ──────────────────────┐
   │                                                                            ▼
[Kampung Bandan]                                                            [Bekasi]
   │                                                                            ▲
   └────── via City Line (Rajawali–Kemayoran–Kramat) [59–63 min] ───────────────┘
```

### 4.4 The Loop Line (Racket Route Topology)
While current KRL operational practice models the circular loop line as stitched single-pass journeys (e.g., `5552A` runs Kampung Bandan $\to$ Cikarang; `5505C` runs Cikarang $\to$ Kampung Bandan), the database model indexes stops using composite key `(timetable_version, trip_id, stop_sequence)`. This structural choice accommodates double-visit stations on circular patterns without violating relational integrity.

### 4.5 Service Calendar & Operational Markers
KRL denotes operational exceptions via several mechanisms:
- **`F` Suffix (Fakultatif):** Indicates services scheduled to run conditionally, routinely suspended on Saturdays, Sundays, and national holidays (e.g., `1163F`).
- **Unmarked Exceptions:** Specific lines (e.g., Rangkasbitung branch corridors) mark non-weekend runs using tabular operational policies rather than identifier suffixes. An `F` suffix is therefore sufficient to indicate non-daily service, but not necessary.
- **Empirical Calendar Determination:** Service calendar coverage (`daily`, `weekday_only`, `weekend_only`) is determined strictly via empirical set-difference across captures (Weekday vs. Saturday vs. Sunday). A reference Indonesian holidays table (`holidays`) accounts for statutory non-operational days. Snapshot day types are assigned strictly by calendar date against national holiday schedules, never inferred from snapshot payload content.

### 4.6 Stop-Time Semantics
The API provides exactly one scheduled time per stop:
- **Origin Station:** Represents scheduled **departure**.
- **Intermediate Stations:** Represents scheduled **departure**. Scheduled arrivals and dwell times are not published.
- **Terminus Station:** Sourced from `dest_time` or the final itinerary record; represents scheduled **arrival**.
- **GTFS Translation:** At origin, `arrival_time` is left blank or set equal to `departure_time`. At intermediate stops, `arrival_time` equals `departure_time`. At the terminus, `departure_time` is left blank or set equal to `arrival_time`.

---

## 5. Information Inventory

```
┌────────────────────────────────────────────────────────────────────────┐
│ DIRECT API ATTRIBUTES                                                  │
│ Station Master, Departures (time_est), Terminus Name, Terminus Time,   │
│ Line Name (ka_name), Route String, Hex Color, Stop Itinerary Order     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ DETERMINISTIC TRANSFORMATIONS                                          │
│ • Base Train Number & Suffix Parsing                                   │
│ • Origin/Destination Station ID Extraction                             │
│ • Dead-Band Service Day Seconds Calculation                            │
│ • Sequence Ordering (Array Index)                                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ INFERRED / DERIVED VIA CROSS-CAPTURE INTEGRATION                       │
│ • Station Foreign Key Resolution                                       │
│ • Calendar Allocation (Weekday / Saturday / Sunday Capture Diff)       │
│ • Fakultatif Observation Status                                        │
│ • 404-Fallback Itinerary Reconstruction (via Board Synthesis)          │
└────────────────────────────────────────────────────────────────────────┘
```

| Classification | Attributes |
|---|---|
| **Direct API Attributes** | Station master (`sta_id`, `sta_name`, `group_wil`, `fg_enable`); station board departure times; destination name + arrival time; line name (`ka_name`); color code; `route_name`; ordered itinerary stops, times, and transit flags. |
| **Deterministic Derivations** | `base_train_no`, `revision`, and `F` parsed from `train_id`; origin and destination station names from `route_name`; service-day integer seconds; stop sequence index. |
| **Supplementary External Data** | Station coordinates (`lat`, `lon`) sourced from version-controlled `data/station_coordinates.csv` and joined on `sta_id`. Statutory holiday schedules (`holidays`). |
| **Inferred (Requires Cross-Capture Logic)** | Origin/terminus resolved to station foreign keys; service calendar patterns (via multi-capture diff and holiday cross-reference); fakultatif operational status; candidate transfer edges. |
| **Unobtainable from Source** | Intermediate arrival times / dwell intervals; historical timetable revisions; real-time delay tracking. |

---

## 6. Relational Database Schema

The database target is SQLite, configured with strict typing, foreign-key enforcement, and write-ahead logging. Timestamps conform strictly to ISO-8601 UTC.

```sql
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
    service_pattern     TEXT CHECK (service_pattern IS NULL OR service_pattern IN ('daily', 'weekday_only', 'weekend_only')),
    source              TEXT NOT NULL CHECK (source IN ('itinerary', 'reconstructed')),
    itinerary_status    TEXT NOT NULL CHECK (itinerary_status IN ('200', '404', 'unprobed')),
    first_seen_snapshot INTEGER REFERENCES snapshots(snapshot_id),
    last_seen_snapshot  INTEGER REFERENCES snapshots(snapshot_id),
    PRIMARY KEY (timetable_version, trip_id)
) STRICT;

CREATE INDEX idx_trips_base ON trips (base_train_no);

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

CREATE TABLE holidays (
    holiday_date        TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    is_collective_leave INTEGER NOT NULL DEFAULT 0
) STRICT;
```

### Schema Rationale
1. **Full `trip_id` Primary Key:** The itinerary endpoint requires the exact alphanumeric identifier. Storing the full operational string ensures lossless joins against source payloads while maintaining revision records naturally across updates.
2. **Non-Unique `base_train_no` Index:** Multiple trips may legitimately share a base number (e.g., opposing weekend configurations, re-letterings, or split patterns). A non-unique index preserves structural identity without risking load-time primary key collisions.
3. **Composite `(trip_id, stop_sequence)`:** Time cannot serve as a primary ordering key due to exact ties, station dwells, and midnight crossings. Array sequence index is unambiguous, preserves circular routing topology, and maps directly to GTFS specifications.
4. **Integer Seconds Alongside Text Strings:** Text columns retain authentic timetable display times (`HH:MM:SS`). Integer seconds normalize times relative to the operational start-of-day, allowing simple arithmetic across midnight ($t \ge 86,400\text{ s}$).
5. **Traceability via `archive_commit`:** Every snapshot links directly to the git commit hash containing the canonical raw response payloads.
6. **No External PDF Staging Tables:** Dropping the brittle PDF reconciliation phase removes speculative text extraction tables (`pdf_trains`), maintaining a schema backed entirely by verified API data.

---

## 7. Validation Invariants

The ingestion engine executes eleven assertions during the build process. Any invariant violation halts compilation and flags the capture:

1. **Intra-Trip Attribute Consistency:** Across all station boards where a `train_id` appears, `route_name`, `dest`, `dest_time`, and `color` must be byte-for-byte identical.
2. **Minimum Board Occurrence ($\ge 2$):** A valid operational trip must appear on at least two distinct station departure boards (origin and at least one upstream station; terminus has no departure entry). A single-station appearance signals a dropped upstream connection or API truncation.
3. **Dead-Band Assertion:** Zero scheduled departures may exist network-wide between 01:30:00 and 03:30:00.
4. **Board-Itinerary Time Congruence:** For every station board row, `time_est` must match the corresponding itinerary stop entry for that train.
5. **Terminus Alignment:** The final scheduled stop in a train's itinerary must match the trip-level `dest_time` and `dest` station.
6. **Strict Monotonicity:** Stop sequences must exhibit strictly non-decreasing service-day seconds:
   $$\text{secs}_i \le \text{secs}_{i+1}$$
   Consecutive equal times are permitted (dwell); negative deltas trigger immediate invariant failure.
7. **Identifier Grammar Adherence:** 100% of discovered `train_id`s must conform to the regex `^(\d+)([A-E])?(F)?$`. Violations are isolated to quarantine tables.
8. **Cross-Capture Suffix Transition Bounds:** When comparing trip revisions across capture editions for a stable base number, operational suffix drift must advance incrementally ($\le +1$). Skipping revisions or unparseable mutations flags service path changes.
9. **Referential Integrity on Inferred Stations:** All station identifiers extracted from `route_name` or itinerary entries must resolve against valid, non-header rows in the `stations` table (`sta_id NOT LIKE 'WIL%'`).
10. **Atomic Capture Integrity:** If any station board query experiences an unrecoverable failure or network timeout during a capture run, the entire capture is marked `degraded` and rejected for build purposes.
11. **Cross-Capture Edition Consistency:** All captures feeding an export within the same `region_scope` must share an identical timetable edition hash. Hashing is scoped to the active region's stations, ensuring an upstream schedule revision in Yogyakarta does not invalidate a concurrent Jabodetabek campaign. If an upstream timetable change occurs mid-campaign within the active scope, the run must be aborted and restarted.

---

## 8. Source-of-Truth Architecture: Raw-First, Git-Versioned

Because KCI does not serve historical timetable data, **our repository is the permanent archive**. The local database is an ephemeral, fully reproducible materialized view over raw payload artifacts.

```
┌────────────────────────────────────────────────────────┐
│ API Extraction Engine                                  │
└───────────┬────────────────────────────────┬───────────┘
            │                                │
            ▼                                ▼
┌────────────────────────┐      ┌────────────────────────┐
│ Station Boards Payloads│      │ Train Itinerary Arrays │
└───────────┬────────────┘      └────────────┬───────────┘
            │                                │
            ▼                                ▼
┌────────────────────────────────────────────────────────┐
│ Deterministic Serializer                               │
│ • Keys sorted alphabetically                           │
│ • Array order strictly preserved                       │
│ • Git Commit (archive_commit hash generated)           │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ Build Engine & Invariant Validator                     │
│ Generates SQLite database + GTFS Feed completely       │
│ offline from committed disk files                      │
└────────────────────────────────────────────────────────┘
```

- **Deterministic Payload Serialization:** Responses are serialized with sorted object keys while strictly maintaining array ordering (since itinerary stop sequence is semantic data).
- **Offline Reproducibility:** The `build` step operates exclusively against committed raw files on disk. Compilation, validation, schema migrations, and GTFS exports can be rerun arbitrarily without touching the upstream network.

---

## 9. Operational Model

Execution runs via a local TypeScript/Bun CLI toolchain requiring zero long-running background daemons.

```
       ┌───────────┐
       │  capture  │ x 3 runs (Weekday, Saturday, Sunday)
       └─────┬─────┘
             │
             ▼
       ┌───────────┐
       │  census   │ x 1 run (Fetch itineraries for all unique IDs)
       └─────┬─────┘
             │
             ▼
       ┌───────────┐
       │   build   │ Run offline (Invariants, DB loading, fallback)
       └─────┬─────┘
             │
             ▼
       ┌───────────┐
       │  export   │ Generate GTFS feed and validation report
       └─────┬─────┘
             │
             ▼
       ┌───────────┐
       │  detect   │ (Optional) Diff single board months later for drift
       └───────────┘
```

### CLI Command Reference
- **`capture`**: Evaluates the current date against the `holidays` table, displays the calculated `day_type`, prompts for user confirmation, queries the station master, and fans out across all station departure boards (~85 stations, concurrency 5, ~3 minutes total). Commits raw payloads to git.
- **`census`**: Reads all discovered `train_id` values across existing snapshot captures, checks the local payload cache, and issues requests for missing itineraries (~1,000–1,500 calls, concurrency 4, ~35–40 minutes). Resumable at any point.
- **`build`**: Executes database migrations, evaluates all 11 validation invariants, reconciles 404 itineraries via topological reconstruction, and populates the SQLite tables inside a single atomic transaction.
- **`export`**: Compiles GTFS specification CSV files (`agency`, `stops`, `routes`, `trips`, `stop_times`, `calendar`, `calendar_dates`) and produces an export summary and validation report.
- **`detect`**: Probes a single reference station board (e.g., Manggarai or Bekasi) and compares the resulting signature with the active database edition to detect unannounced timetable revisions.

### Phased Runbook
1. **Weekday Capture:** Execute `capture` on a confirmed standard working day (Tuesday, Wednesday, or Thursday). Verify baseline parameters (Serang operational status, time precision, dead-band boundaries).
2. **Weekend Captures:** Execute `capture` on the subsequent Saturday and Sunday.
3. **Capture Differentiation:** Execute three-way set-difference to categorize `daily`, `weekday_only`, and `weekend_only` runs.
4. **Enrichment Census:** Run `census` once to resolve complete itineraries for all unique discovered trains.
5. **Build & Export:** Execute `build` to generate the normalized SQLite database, followed by `export` to produce production GTFS feeds.

### Failure Policy
Transient network failures during `capture` or `census` trigger exponential backoff retry. Unrecoverable failures mark the affected capture run as `degraded`. Degraded captures are retained in the raw archive for diagnostic purposes but are strictly barred from the `build` process.

### GTFS Mapping Specifications
- **`agency.txt`**: Kereta Commuter Indonesia (KCI).
- **`stops.txt`**: Keyed by `stop_id` = `sta_id`; `stop_name` = `sta_name`; `stop_lat` and `stop_lon` populated directly from `data/station_coordinates.csv`. Missing coordinates produce soft warnings during `build` and a validation error on `export`.
- **`routes.txt`**: Mapped from commercial `ka_name` strings (e.g., Cikarang Line, Bogor Line).
- **`trips.txt`**: Keyed by `trip_id`; `trip_headsign` maps to `headsign`; routing variations retain explicit pattern signatures.
- **`stop_times.txt`**: Stop times derived from integer service-day seconds formatted as `HH:MM:SS` (values past 23:59:59 format continuously as `24:XX:XX`, conforming to GTFS standard).
- **`calendar.txt` / `calendar_dates.txt`**: Service intervals populated via multi-capture diffing and cross-referenced with statutory holidays.

---

## 10. Implementation Posture

- **Runtime & Toolchain:** TypeScript running on the Bun runtime for performant native execution.
- **Data Layer:** SQLite operated via Drizzle ORM. DDL migrations are version-controlled SQL files enforcing table-level invariants (`STRICT`, `CHECK`, foreign-key cascade constraints).
- **Boundary Validation:** Zod schemas validate all input at network and file-system boundaries:
  - Network JSON payloads.
  - Archive reads.
  - Runtime configuration objects.
- **Domain Core:** Pure, side-effect-free functions govern domain logic (time arithmetic, array monotonicity walks, string normalization, and invariant assertions). Core logic is verified using property-based testing.

---

## 11. Architectural Decision Records (ADRs)

| # | Architecture Decision | Alternative Evaluated | Justification |
|---|---|---|---|
| **1** | **Hybrid Ingestion Pipeline** (Station boards for discovery, itineraries for sequence enrichment). | Board-only ingestion; itinerary-only scraping. | Station boards guarantee completeness across the network; itineraries provide millisecond-precision stop sequences and terminus ground truth. |
| **2** | **Full String `trip_id` Keying** (Preserve raw IDs like `5022D`). | Stripping suffix letters to store integer base keys. | Upstream endpoints query exact alphanumeric strings. Preserving suffixes exposes revision states naturally without losing raw traceability. |
| **3** | **Non-Unique Index on `base_train_no`**. | Unique constraint on base numbers. | Weekend and holiday timetable variations may run over identical base numbers. Enforcing uniqueness would reject valid operational schedules. |
| **4** | **Composite Ordering Key `(trip_id, stop_sequence)`**. | Keying by `(trip_id, station_id)` or `(trip_id, departure_time)`. | Accommodates loop configurations, handles dual-departure ties, and maps cleanly to GTFS sequence requirements. |
| **5** | **Dual Time Representations** (Text display string alongside Integer Service-Day Seconds). | Storing native SQL `TIME` or single epoch timestamps. | Eliminates date parsing complexities and provides clean arithmetic for trips running past midnight ($t \ge 86,400\text{ s}$). |
| **6** | **Explicit Snapshot & Version Metadata**. | Flat single-state database tables. | Timetable variations, station additions, and train cancellations can only be tracked across distinct versioned snapshots. |
| **7** | **Empirical Calendar Resolution via Capture Diffing (PDF Dropped)**. | Parsing published PDF schedules or inferring calendar purely from `F` suffixes. | PDF timetable parsing was evaluated and explicitly dropped: the document layouts are fragile, unstandardized across revisions, and prone to publication drift. Multi-capture API diffing directly reflects operational reality without parser brittleness. |
| **8** | **Raw-First Archival Storage** (Git-committed JSON payloads). | Direct-to-database ingestion with ephemeral HTTP drops. | Upstream maintains no public historical record. Archiving raw responses ensures total reproducibility and eliminates network costs during development. |
| **9** | **Resumable Local Census Caching**. | Re-scraping itineraries on every run. | High upstream request latencies (5–10 s) make full re-scraping prohibitive; file caches allow progressive, interruptible enrichment. |
| **10** | **Timetable Document Model**. | Real-time event stream ingestion. | The API acts as an undated document server; single full-day queries capture the entirety of a repeating operational schedule. |
| **11** | **Embedded SQLite Engine (STRICT Mode)**. | Centralized PostgreSQL instance. | Minimizes operational overhead, avoids database server maintenance, and aligns with potential edge deployment targets (Cloudflare D1). |
| **12** | **Region-Scoped Ingestion & Fingerprinting**. | Global monolithic capture across all stations nationwide. | KCI operates two geographically disjoint commuter networks (Jabodetabek/Merak with `group_wil: 0` vs Yogyakarta/Solo with `group_wil: 6`). Regional scoping decouples capture campaigns, isolates edition hash validation (Invariant 11), and allows expanding to Yogyakarta later via a single configuration parameter without invalidating historical snapshots. |
| **13** | **Supplementary Station Coordinates via Decoupled CSV**. | Relying solely on API attributes or hardcoding coordinates in migrations. | GTFS `stops.txt` strictly mandates `stop_lat` and `stop_lon`, which the upstream REST API does not publish. Maintaining coordinates in a version-controlled `data/station_coordinates.csv` joined on `sta_id` during `build` cleanly decouples manual/external geospatial enrichment from upstream API captures while guaranteeing reproducible offline builds. |

---

## 12. Verification Matrix & Open Tests

| Verification Area | Empirical Test | Status | Architectural Resolution |
|---|---|:---:|---|
| **Backend Static vs. Date-Aware State** | Three-way diff between Weekday, Saturday, and Sunday captures. | In Progress | Authoritative calendar source: empirical three-way diffing across day types resolves service patterns. PDF parsing is discarded. |
| **Terminus Board Rows** | Queried major hub boards (Tanah Abang, Manggarai, Bekasi) using `dest == sta_name`. | **Verified** ✅ | Yields 0 records. Station boards are confirmed departure-only. Terminus arrivals are derived from `dest_time`. |
| **Time Granularity** | Compared board payload times against train-schedule itinerary times. | **Verified** ✅ | Station boards round departures to `:00`. Itineraries expose exact sub-minute seconds (e.g., `15:41:30`). Both stored. |
| **Station Dropdown Headers** | Verified structural headers starting with `WIL%` in station master. | **Verified** ✅ | Rows are UI section headers with `fg_enable=0`. Filtered via `sta_id NOT LIKE 'WIL%'`. |
| **Operational Flag Exceptions** | Inspected Serang station (`SG`) configuration. | **Verified** ✅ | Serang has `fg_enable=0` despite operating 14 daily departures. Schema must never filter on `fg_enable=1`. |
| **Line Brand Extraction** | Cross-referenced `ka_name` across corridor payloads. | **Verified** ✅ | Consistently carries clean commercial designations (`"COMMUTER LINE CIKARANG"`). Mapped directly to `trips.line_name`. |
| **Transit Field Typings** | Inspected itinerary payloads for transfer interchange representations. | **Verified** ✅ | Returns `""` (empty string) when absent, or `string[]` of hex color codes when present. Normalized via Zod at boundary. |
| **Weekday Uniformity** | Comparative diff between Tuesday and Thursday board captures. | Open | Assumed identical based on operational domain standards; verifiable via multi-day capture comparison. |
| **Itinerary Census Coverage** | Total network itinerary census probe. | Open | Determines whether the fallback reconstruction path remains an exceptional fallback or a standard path. |
| **Annual Holiday Rules** | Cross-check national SKB 3 Menteri holiday decrees against captured dates. | Open | Requires annual maintenance of the `holidays` configuration table. |

---

## 13. Architectural Summary

```
                      DATA INTEGRITY SAFEGUARDS
                      
   API Source                                      Storage Core
┌──────────────┐                                ┌────────────────┐
│  Raw JSON    │──( Deterministic Serialization )──▶ Git Archive  │
└──────────────┘                                └───────┬────────┘
                                                        │
                                                        ▼
┌──────────────┐                                ┌────────────────┐
│ 11 Build-Time│◀──────( Invariant Engine )──────│ SQLite STRICT  │
│  Assertions  │                                │  Database Core │
└──────────────┘                                └───────┬────────┘
                                                        │
                                                        ▼
                                                ┌────────────────┐
                                                │  GTFS Export   │
                                                └────────────────┘
```

The system guarantees schedule correctness through four complementary design layers:
- **Exhaustive Discovery:** Departure boards provide complete spatial and temporal coverage of the active network without relying on heuristic ID guessing.
- **Authoritative Enrichment:** Stop sequences and sub-minute arrival timings are populated directly from official itinerary arrays.
- **Fail-Fast Invariant Suite:** Eleven strict structural invariants prevent corrupted, drifted, or truncated upstream data from silently landing in release builds.
- **Permanent Archival Foundation:** Committing deterministic, raw JSON payloads decouples downstream data modeling from the upstream collection process, ensuring full reproducibility regardless of external API lifecycles.