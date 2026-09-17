# Design & Discovery Document — KRL Schedule Database

**Version:** 1.6  
---

## 1. Purpose & Deliverables

Ingest the current Kereta Commuter Indonesia (KRL) timetable edition from KCI's station-centric REST API into a normalized relational database, producing:

1. **Relational core** — stations, trips, and ordered stop-time sequences.
2. **Service calendar** per trip — resolved via an evidence-graded fold over available day-type captures (weekday, Saturday, Sunday) cross-referenced with national holidays, producing provisional calendars at $N=1$ and fully resolved presence masks at $N=3$.
3. **GTFS-compatible export** — `routes`, `trips`, `stop_times`, `calendar`, and `calendar_dates` (transfers deferred).
4. **Raw-response archive** — a deterministic, versioned snapshot archive of the upstream API responses (the API provides no revision history; our raw archive constitutes the permanent record of this edition).
5. **Export validation report** — integrity audit covering graph completeness, dead-band enforcement, sequence monotonicity, calendar masks, and itinerary-board stop count congruence.

### Scope Boundaries
* **In Scope (v1.6):** Single-snapshot baseline bootstrap ($N \ge 1$), incremental evidence-graded multi-capture calendar enrichment (weekday, Saturday, Sunday), offline validation/build pipeline (pure functional fold), topological board reconstruction fallback, stratified verification spot-checks, and GTFS export.
  - **Regional Scope:** Active initial capture scope is `jabodetabek` (`group_wil: 0`, covering 94 operational stations across Jabodetabek and the Merak branch).
  - **Catalog Topology:** Upstream `/api/krl/stations` returns 114 entries: 3 regional dropdown headers (`WIL0`, `WIL1`, `WIL6`), 94 Jabodetabek stations (`group_wil: 0`), and 17 Yogyakarta–Solo stations (`group_wil: 6`), totaling 111 operational stations. During `build`, all 111 operational stations are folded into the relational catalog to guarantee global referential integrity across cross-network references, while departure board captures target the configured `region_scope`.
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
  Together with 3 non-station regional dropdown headers (`WIL0`, `WIL1`, `WIL6`), the catalog contains 114 entries with 111 operational stations.
- **Ingestion Filter:** `sta_id NOT LIKE 'WIL%' AND group_wil IN (:allowed_groups)`. Rows starting with `WIL*` represent regional dropdown section headers with `fg_enable=0`, not physical stations.
- **Physical Station Ingestion Rule:** Do **not** filter out `fg_enable=0`. Station `SG` ("SERANG") is flagged with `fg_enable=0` in the station master despite being fully operational (14 daily departures and active stops on Merak line itineraries). Restricting ingestion to `fg_enable=1` drops Serang and breaks referential integrity on Merak corridor trips.
- **Modular Scope Configuration:** By parameterizing the active scope (`region_scope`), `capture` queries 94 stations for Jabodetabek+Merak without touching Yogyakarta. Expanding to Yogyakarta later is a 1-line configuration update (`allowed_groups: [0, 6]`), with zero architectural rework. All 111 operational stations are retained during `build` to guarantee referential integrity across the entire national network.

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
- **Destination Name Sanitization & Bypass Stripping:** Upstream station departure boards and route names frequently append operational routing annotations (e.g., `ANGKE VIA PSE`, `JAKARTA KOTA VIA KPB`). These strings are sanitized by `cleanDestinationName` (`src/core/route.ts`), stripping `VIA ...` and trailing transit markers before resolving against the physical station catalog.
- **Symmetric Transliteration & Spelling Variants:** Historical Dutch colonial orthography and modern Indonesian spelling variants coexist in the KCI ecosystem (e.g., `PRIUK` vs `PRIOK` for Tanjung Priok, `oe` $\leftrightarrow$ `u`, `tj` $\leftrightarrow$ `c`, `dj` $\leftrightarrow$ `j`). Station resolution applies symmetric bi-directional phonetic transliteration (`src/core/route.ts`) so that departures and itineraries match regardless of spelling convention.

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
- **Presence Mask Model (`trip_calendar`):** Rather than forcing a rigid 3-value enum (`daily`, `weekday_only`, `weekend_only`) that cannot represent asymmetric service (such as Monday–Saturday runs without Sunday service on branch lines), calendar coverage is modeled as a presence mask over observed day types (`runs_weekday`, `runs_saturday`, `runs_sunday`). The diff *is* the data, cleanly representing all $2^3 = 8$ day-type permutations.
- **Evidence-Graded Calendar Resolution:** The service calendar is not a build prerequisite, but an evidence-graded fold recomputed across whatever same-edition snapshots exist in the raw archive. At $N=1$ capture (e.g., weekday only), trips are marked `calendar_state = 'provisional'` with observed-day coverage. Once all three day types (weekday, Saturday, Sunday) are captured, `calendar_state` advances to `'resolved'`.
- **GTFS Weekly Pattern vs. Date Exception Nuance:** In the GTFS transit specification, calendar representations are split into two complementary tiers:
  1. **Weekly Repeating Template (`calendar.txt`):** Governs recurring 7-day service masks (`monday` through `sunday`). Weekend non-operation (including for fakultatif trains) is structurally modeled here (`saturday = 0, sunday = 0`). Weekend dates are *never* injected into holiday lists.
  2. **Specific Date Overrides (`calendar_dates.txt`):** Governs individual date exceptions to the weekly template. Mid-week national holidays sourced from `data/holidays.json` that fall on Monday through Friday generate explicit cancellation records (`exception_type = 2`, service removed) for fakultatif runs. Holidays falling on a weekend emit no exception, as the service is already inactive by weekly schedule.

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
│ • Calendar Allocation (Progressive Presence Mask Fold & Holiday Audit) │
│ • Fakultatif Observation Status                                        │
│ • 404-Fallback Itinerary Reconstruction (via Board Synthesis)          │
└────────────────────────────────────────────────────────────────────────┘
```

| Classification | Attributes |
|---|---|
| **Direct API Attributes** | Station master (`sta_id`, `sta_name`, `group_wil`, `fg_enable`); station board departure times; destination name + arrival time; line name (`ka_name`); color code; `route_name`; ordered itinerary stops, times, and transit flags. |
| **Deterministic Derivations** | `base_train_no`, `revision`, and `F` parsed from `train_id`; origin and destination station names from `route_name`; service-day integer seconds; stop sequence index. |
| **Supplementary External Data** | Station coordinates (`lat`, `lon`) sourced from version-controlled `data/station_coordinates.csv` (generated via Overpass extraction script `scripts/fetch-station-coordinates.ts` and joined on `sta_id`). Applies empirical ticketing code overrides (`PCN` $\to$ `POC`, `TTI` $\to$ `THI`, `TOJ` $\to$ `TOJB`), canonical station code normalization (`GGL` $\to$ `GRG` per ADR 16), and missing-tag fallbacks (`BPR`, `JTK`). Filters 5 non-commuter heavy rail nodes (`GMR`, `JAKG`, `CGD`, `BOP`, Bandara Soekarno-Hatta). Statutory holiday schedules sourced from version-controlled `data/holidays.json` (ADR 15, mirroring the decoupled reference data pattern of ADR 13). |
| **Inferred (Requires Cross-Capture Logic)** | Origin/terminus resolved to station foreign keys; service calendar presence masks (via progressive fold over observed captures and holiday cross-reference); fakultatif operational status; candidate transfer edges. |
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
```

### Schema Rationale
1. **Full `trip_id` Primary Key:** The itinerary endpoint requires the exact alphanumeric identifier. Storing the full operational string ensures lossless joins against source payloads while maintaining revision records naturally across updates.
2. **Non-Unique `base_train_no` Index:** Multiple trips may legitimately share a base number (e.g., opposing weekend configurations, re-letterings, or split patterns). A non-unique index preserves structural identity without risking load-time primary key collisions.
3. **Composite `(trip_id, stop_sequence)`:** Time cannot serve as a primary ordering key due to exact ties, station dwells, and midnight crossings. Array sequence index is unambiguous, preserves circular routing topology, and maps directly to GTFS specifications.
4. **Integer Seconds Alongside Text Strings:** Text columns retain authentic timetable display times (`HH:MM:SS`). Integer seconds normalize times relative to the operational start-of-day, allowing simple arithmetic across midnight ($t \ge 86,400\text{ s}$).
5. **Traceability via `archive_commit`:** Every snapshot links directly to the git commit hash containing the canonical raw response payloads.
6. **No External PDF Staging Tables:** Dropping the brittle PDF reconciliation phase removes speculative text extraction tables (`pdf_trains`), maintaining a schema backed entirely by verified API data.
7. **Presence Mask Table (`trip_calendar`) vs. Enum:** Decoupling calendar presence from `trips` replaces a rigid 3-value enum with explicit presence flags (`runs_weekday`, `runs_saturday`, `runs_sunday`). This natively models all 8 day-type permutations (such as Monday–Saturday branch operations) and stores raw empirical evidence directly, allowing `build` to operate as an idempotent pure fold over $N \ge 1$ captures without in-place mutations.
8. **Quarantine Isolation (`quarantined_trips`):** Structural grammar failures (Invariant 7) or cross-capture attribute discrepancies (Invariant 12) are isolated into an auditable relational store rather than silently dropped, preserving total data capture without corrupting core schedule relations.
9. **Holidays Provenance (`data/holidays.json`):** Statutory holidays and collective leave (*cuti bersama*) decrees (*SKB 3 Menteri*) are version-controlled in `data/holidays.json` and ingested alongside schema migrations, maintaining offline reproducibility without runtime external network calls.
10. **Topological Board Reconstruction Fallback (`source = 'reconstructed'`):** When an itinerary is unavailable (upstream 404) or fails referential validation (Invariant 9), the build pipeline invokes `reconstructFromBoards` (`src/build/reconstruct.ts`) rather than discarding the service. It reconstructs the chronological stop sequence from station departure boards, selecting the snapshot candidate with the largest occurrence count, deriving transit intervals, and synthesizing the terminus arrival from `dest_time`.

---

## 7. Validation Invariants

The ingestion engine executes thirteen assertions during the build process. Any invariant violation halts compilation and flags the capture:

1. **Intra-Trip Attribute Consistency:** Across all station boards where a `train_id` appears within a capture, `route_name`, `dest`, `dest_time`, and `color` must be byte-for-byte identical.
2. **Minimum Board Occurrence ($\ge 2$):** A valid operational trip must appear on at least two distinct station departure boards (origin and at least one upstream station; terminus has no departure entry). A single-station appearance signals a dropped upstream connection or API truncation.
3. **Dead-Band Assertion:** Zero scheduled departures may exist network-wide between 01:30:00 and 03:30:00.
4. **Board-Itinerary Time Congruence:** For every station board departure row, `time_est` must match the corresponding itinerary stop entry for that train, evaluated by truncating the itinerary time to whole minutes (`HH:MM:00` congruence against itinerary `HH:MM:SS`; see Section 12 for floor vs. round tolerance). Evaluated per snapshot during the fold. If scheduled stop times diverge between a station board departure and its itinerary stop array (or on unsampled date-aware weekend trips), this invariant fails immediately, directing remediation to the escalation path (`census --reprobe-all --day-type <day_type>`).
5. **Terminus Alignment:** The final scheduled stop in a train's itinerary must match the trip-level `dest` station and `dest_time` (evaluated by truncating itinerary terminus arrival time to whole minutes).
6. **Strict Monotonicity:** Stop sequences must exhibit strictly non-decreasing service-day seconds:
   $$\text{secs}_i \le \text{secs}_{i+1}$$
   Consecutive equal times are permitted (dwell); negative deltas trigger immediate invariant failure.
7. **Identifier Grammar Adherence:** 100% of discovered `train_id`s must conform to the regex `^(\d+)([A-E])?(F)?$`. Violations are isolated to quarantine tables.
8. **Cross-Capture Suffix Transition Bounds:** When comparing trip revisions across captures within the same timetable edition for a stable base number, operational suffix drift must advance incrementally ($\le +1$). Pairwise revision comparison is strictly evaluated across *same-day-type* captures (a weekend variant `5022E` vs weekday `5022D` is expected calendar variance, not edition drift). Vacuous at $N=1$ same-day-type capture.
9. **Referential Integrity on Inferred Stations:** All station identifiers extracted from `route_name` or itinerary entries must resolve against valid, non-header rows in the `stations` table (`sta_id NOT LIKE 'WIL%'`).
10. **Atomic Capture Integrity:** If any station board query experiences an unrecoverable failure or network timeout during a capture run, the entire capture is marked `degraded` and rejected for build purposes.
11. **Cross-Capture Edition Consistency:**
    - **Edition Family Membership:** All captures feeding an export within the same `region_scope` must share an identical station master payload hash (physical station catalog, `group_wil`, and `fg_enable` do not vary by day type). Weekend captures join the weekday edition family via this hash.
    - **Within-Day-Type Board Equality:** Station board response hash equality is enforced *only within the same day type* (e.g., comparing a Tuesday capture against a Thursday capture to detect mid-week revision drift). Cross-day-type differences (weekday vs. Saturday) are classified as *calendar evidence*, never edition drift.
    - **Failure Escalation:** Failure triggers the **New-Edition Runbook Branch** (Section 9): freeze the prior `timetable_version`, initialize `<version+1>`, and start a fresh capture campaign.
    - Vacuous at $N=1$ capture.
12. **Cross-Capture Trip-Attribute Consistency:** Across distinct same-edition captures, any identical `trip_id` must carry byte-for-byte identical trip-level attributes (`route_name_raw`, `headsign`, `dest_station_id`, `dest_time`, `origin_secs`, `color`). Any discrepancy signals conflicting operational variants sharing an ID across day types, triggering immediate isolation into `quarantined_trips` with both conflicting attribute sets recorded. Vacuous at $N=1$ capture.
13. **Board-Itinerary Stop Count Congruence:** For every operational trip with `source = 'itinerary'`, the count of station departure board rows across the entire network must strictly equal $\text{total\_stops} - 1$ (the terminus station publishes no departure row by construction; Section 2.2). Evaluated during the fold per trip per snapshot. Counting applies to board *departure rows* rather than distinct stations to properly account for loop-line double visits. For `source = 'reconstructed'` trips, this invariant is vacuous as stop counts are synthesized from board rows. Catches upstream itinerary truncation, phantom stops, or dropped intermediate station board departures at zero network cost.

---

## 8. Source-of-Truth Architecture: Raw-First, Git-Versioned

Because KCI does not serve historical timetable data, **our repository is the permanent archive**. The local database is an ephemeral, fully reproducible materialized view over raw payload artifacts.

```
┌────────────────────────────────────────────────────────┐
│ API Extraction Engine (capture / census)               │
└───────────┬────────────────────────────────┬───────────┘
            │                                │
            ▼                                ▼
┌────────────────────────┐      ┌────────────────────────┐
│ Station Boards Payloads│      │ Train Itinerary Arrays │
└───────────┬────────────┘      └────────────┬───────────┘
            │                                │
            ▼                                ▼
┌────────────────────────────────────────────────────────┐
│ Deterministic Serializer & Manifest Generator          │
│ • Keys sorted alphabetically                           │
│ • Array order strictly preserved                       │
│ • Writes content hashes to manifest.json               │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ Git Commit (versioned capture snapshots on disk)       │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ Build Engine & Invariant Validator                     │
│ • Populates archive_commit via local git log           │
│ • Evaluates 13 validation invariants                   │
│ • Generates SQLite database + GTFS Feed completely     │
│   offline from committed disk files                    │
└────────────────────────────────────────────────────────┘
```

- **Deterministic Payload Serialization:** Responses are serialized with sorted object keys while strictly maintaining array ordering (since itinerary stop sequence is semantic data).
- **Offline Reproducibility:** The `build` step operates exclusively against committed raw files on disk. Compilation, validation, schema migrations, and GTFS exports can be rerun arbitrarily without touching the upstream network.

### 8.1 Filesystem Archive Layout
Raw responses are structured deterministically on disk within git-tracked directories:

```
data/raw/
  └── <timetable_version>/
      ├── captures/
      │   └── <snapshot_id>/
      │       ├── manifest.json       # Snapshot metadata contract
      │       ├── stations.json       # Station master response
      │       └── boards/
      │           ├── BKS.json        # Departure board per station
      │           └── ...
      └── itineraries/
          ├── 5552A.json              # Multi-observation envelope keyed by day_type
          └── ...
```

**`timetable_version` Assignment Rule:** During `capture`, the engine queries the station master for the active `region_scope` and inspects existing capture manifests under `data/raw/`. Version assignment follows a two-tier check:
1. **Station Catalog Gate:** If `station_master_hash` differs from the active edition manifest, a physical network catalog mutation is detected, prompting to initialize `<timetable_version + 1>`.
2. **Board Signature Drift Gate:** If `station_master_hash` matches, `capture` completes the station departure board fan-out in memory and computes `board_response_hash`. If an existing snapshot of the **same day type** exists in `<timetable_version>`, the hashes are compared. A mismatch indicates an unannounced mid-edition timetable revision, prompting the operator before writing or committing: *"Board signature diverges from active edition baseline for day type. Suspected new timetable edition. Increment version? [y/N]"*.
3. **Explicit Override:** Operators can explicitly force a clean edition increment via `capture --new-version` (e.g. for announced GAPEKA timetable overhauls).

### 8.2 The Capture Manifest Contract (`manifest.json`)
Every capture execution writes an authoritative metadata contract to `manifest.json`, eliminating implicit CLI assumptions:
```json
{
  "timetable_version": 1,
  "snapshot_id": 1,
  "snapshot_date": "2026-09-17",
  "day_type": "weekday",
  "region_scope": "jabodetabek",
  "station_master_hash": "b2f8a1c9...",
  "board_response_hash": "c4d3e2a1...",
  "fetched_at": "2026-09-17T03:00:00Z",
  "status": "complete"
}
```

- **Authoritative Snapshot ID:** The `snapshot_id` written in `manifest.json` is authoritative across the pipeline and directly populates `snapshots.snapshot_id` and all downstream foreign key references, overriding arbitrary SQLite autoincrements.
- **Resolution of `archive_commit` (Avoiding Self-Referential Hash Paradox):** Because `manifest.json` is itself committed to git, embedding `commit_hash` inside the manifest would create an unsolvable self-referential hash paradox (a commit hash computed over a tree containing its own hash). `manifest.json` therefore records only pure content hashes. The database column `snapshots.archive_commit` is populated at **`build` time** via local git interrogation (`git log -n 1 --format=%H -- data/raw/<version>/captures/<snapshot_id>`), preserving deterministic, offline reproducibility.
- **Canonical Board Hashing:** The `board_response_hash` is computed deterministically: station board JSON responses within the capture are sorted alphabetically by `sta_id`, serialized with sorted object keys, concatenated, and hashed via SHA-256.

### 8.3 Multi-Observation Itinerary Envelope
To avoid file overwrite collisions or folder restructuring if an identical `train_id` is observed across multiple day types, itineraries are addressed by `train_id` with an explicit observations map:
```json
{
  "train_id": "5552A",
  "observations": {
    "weekday": {
      "fetched_at": "2026-09-17T03:15:00Z",
      "payload_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "stops": [ ... ]
    }
  }
}
```
- **Canonical Payload Hash:** `payload_hash` is computed strictly over the stops array using the canonical serializer (alphabetically sorted object keys, array order strictly preserved): `sha256(canonicalSerialize(stops))`. Probes and diffs compare payload hashes, preventing false positives caused by `fetched_at` timestamp deltas or JS engine key ordering.
- **Delta Storage:** Delta census runs on weekends write directly into `observations[day_type]`, preserving historical weekday payloads without file moves or directory migrations.

---

## 9. Operational Model

Execution runs via a local TypeScript/Bun CLI toolchain requiring zero long-running background daemons.

```
       ┌───────────┐
       │  capture  │ Independent run (any day, idempotent, N ≥ 1)
       └─────┬─────┘
             │
             ▼
       ┌───────────┐
       │  census   │ Stratified spot-check + incremental delta enrichment
       └─────┬─────┘
             │
             ▼
       ┌───────────┐
       │   build   │ Pure functional fold over N ≥ 1 snapshots in archive
       └─────┬─────┘ (13 Invariants, DB compilation, provisional/resolved calendar)
             │
             ▼
       ┌───────────┐
       │  export   │ Compiles GTFS (--require-census-complete, --require-resolved-calendar)
       └───────────┘

  Out-of-DAG Operational Tools:
  • calendar: Pure read-only set-difference inspection & empirical verification report.
  • detect:   Out-of-band operational probe run ad-hoc against live station boards for drift.
```

### Stage Contracts

| Stage | Input | Output | Applicability Condition | Purity |
|---|---|---|---|---|
| `capture` | `holidays.json`, config | Git commit + raw payload files + `manifest.json` | Any day, independent | Side-effectful, idempotent |
| `census` | $\ge 1$ snapshot | Itinerary raw payloads (multi-observation envelope) | Any time; incremental, resumable | Side-effectful, cache-keyed |
| `build` | Archive + config | SQLite DB (`trip_calendar`, `quarantined_trips`) | $\ge 1$ complete snapshot, same edition | **Pure fold, deterministic** |
| `export` | DB + config | GTFS CSVs + validation report | Any build | Pure |
| `calendar` | DB / Archive | Set-difference report & diff table | $\ge 2$ same-edition day types | Pure, read-only (out-of-DAG) |
| `detect` | 3 corridor hub boards | Drift report vs. active edition day type | Any time post-build | Side-effectful probe (out-of-DAG) |

### CLI Command Reference
- **`capture`**: Evaluates the current date against `data/holidays.json`, displays the calculated `day_type`, prompts for user confirmation, queries the station master, and fans out across all station departure boards (~85 stations, concurrency 5, ~3 minutes total). Computes `station_master_hash` and `board_response_hash`, verifies against existing same-day-type manifests in the active version to detect schedule edition drift before disk write, emits `manifest.json`, and commits raw payloads to git. Supports `--new-version` to explicitly bootstrap a fresh timetable edition (e.g., for published GAPEKA revisions).
- **`census`**: Reads all discovered `train_id` values across existing snapshot captures, checks the local payload cache, and issues requests for missing itineraries (~1,000–1,500 calls, concurrency 4, ~35–40 minutes). Resumable and incremental; fetches only unprobed IDs.
  - **Stratified Spot-Check:** When executing against an existing cache on a subsequent day type, `census` runs an automated stratified probe (~30–45 s) sampling 5 representative services: 1 Bogor trunk train, 1 Cikarang trunk train, 1 loop-line train (racket topology), 1 branch line train (Rangkasbitung or Merak), and 1 fakultatif (`F`-suffix) train. (For `F`-suffix trains on weekends, an upstream 404 or departure board absence represents expected operational suspension, not hash divergence). It compares canonical `payload_hash` values against cached weekday observations. If no divergence is detected in sampled strata, delta census proceeds for newly discovered `train_id`s. If divergence is detected, the runbook escalation path is engaged.
  - **CLI Flags:**
    - `--reprobe-all`: Force-queries all active trains under the queried day type, populating day-specific `observations[day_type]`.
    - `--day-type <type>`: Explicitly overrides or sets the target day-type context (`weekday`, `saturday`, `sunday`, `holiday`). When supplied, the engine validates that a completed capture manifest (`manifest.json` with `status: "complete"`) exists under `data/raw/<version>/captures/` for that `day_type` before issuing network itinerary probes, preventing orphaned day-type observations.
- **`build`**: Pure functional fold over all raw committed snapshots for the active edition. Evaluates all 13 validation invariants (including Board-Itinerary Stop Count Congruence), populates relational tables, isolates defective entities into `quarantined_trips`, reconciles 404 itineraries via topological reconstruction, resolves `snapshots.archive_commit` via local git history, and computes `trip_calendar` presence masks (`calendar_state = 'provisional'` when $<3$ day types observed; `'resolved'` when weekday, Saturday, and Sunday are all captured). Fully offline, idempotent, and executed within a single atomic transaction.
- **`export`**: Compiles GTFS specification CSV files (`agency`, `stops`, `routes`, `trips`, `stop_times`, `calendar`, `calendar_dates`) and produces an export summary and validation report. In provisional calendar states, exports conservative observed-day masks. Supports release-gate flags:
  - `--require-resolved-calendar`: Enforces that all 3 day types (weekday, Saturday, Sunday) have been folded into `trip_calendar` with `calendar_state = 'resolved'`.
  - `--require-census-complete`: Asserts that zero discovered trips remain with `itinerary_status = 'unprobed'`, preventing incomplete stop sequences from entering production feeds.
  - `--require-holiday-coverage`: Asserts that the export feed validity horizon does not extend past the latest statutory date defined in `data/holidays.json`. When omitted, emits a visible audit warning if feed dates exceed covered holiday decrees.
- **`calendar`**: (Out-of-DAG read-only tool) Pretty-prints the three-way set-difference across day types for human review, outputting empirical schedule identity statistics (verifying static vs. date-aware behavior).
- **`detect`**: (Out-of-DAG operational monitor) Probes a 3-station signature representing key corridor families—Manggarai (Central/Bogor), Bekasi (Cikarang), and Rangkasbitung (Western branch)—and compares the live departures against the active database edition filtered for **today's specific day type** (`trip_calendar[day_type] == 1`). Eliminates false positives from weekend calendar variance and avoids spatial blind spots on branch lines in ~15 seconds.

### Auxiliary Tooling
- **`scripts/fetch-station-coordinates.ts`**: Standalone extraction script executed via Bun. Queries the public Overpass API using strict spatial bounding and negative operator/mode filters, resolves OSM tagging inconsistencies, and generates the canonical `data/station_coordinates.csv` file for offline `build` and `export` runs.

### Phased Runbook (v1.5)
1. **Day-1 Baseline Bootstrap:** Execute `capture` on a confirmed standard working day (Tuesday, Wednesday, or Thursday). Run `census` for discovered trains, followed immediately by `build` and `export`. A complete, functional SQLite database and provisional weekday GTFS feed are operational on day one.
2. **Weekend Enrichment (Order-Free, Incremental):** Execute `capture` on the subsequent Saturday and Sunday. Run `census` (executes the stratified spot-check in ~45 s, then fetches only newly discovered delta trains).
   - **Escalation Path (If Divergence Detected):** If the stratified spot-check detects payload hash divergence on active runs, execute `census --reprobe-all --day-type <saturday|sunday>` to populate day-specific observations before building.
3. **Pure Re-Fold & Calendar Resolution:** Re-run `build`. The engine refolds all available snapshots, promoting `trip_calendar.calendar_state` to `'resolved'` once all three day types are present, evaluating all 13 structural invariants.
   - **Build Divergence Escalation:** If `build` halts on Invariant 4 due to board-itinerary stop-time divergence on unsampled weekend trips, execute `census --reprobe-all --day-type <saturday|sunday>` to populate day-specific observations for the divergent day type, then re-run `build`.
   - **New-Edition Runbook Branch (Invariant 11 Failure):** If `build` halts on Invariant 11 (detecting an upstream station catalog mutation or mid-week timetable edition revision), the current edition family cannot be merged. The operator freezes `data/raw/<version>`, creates `data/raw/<version+1>`, and bootstraps a fresh capture sequence starting from Step 1.
4. **Final Export & Diff Verification:** Run `calendar` to print the empirical verification report. Run `export --require-resolved-calendar --require-census-complete` to emit the production GTFS archive.

### Failure Policy
Transient network failures during `capture` or `census` trigger exponential backoff retry. Unrecoverable failures mark the affected capture run as `degraded`. Degraded captures are retained in the raw archive for diagnostic purposes but are strictly barred from the `build` process.

### GTFS Mapping Specifications
- **`agency.txt`**: Kereta Commuter Indonesia (KCI).
- **`stops.txt`**: Keyed by `stop_id` = `sta_id`; `stop_name` = `sta_name`; `stop_lat` and `stop_lon` populated directly from `data/station_coordinates.csv`. Missing coordinates produce soft warnings during `build` and a validation error on `export`.
- **`routes.txt`**: Mapped from commercial `ka_name` strings (e.g., Cikarang Line, Bogor Line).
- **`trips.txt`**: Keyed by `trip_id`; `trip_headsign` maps to `headsign`; routing variations retain explicit pattern signatures.
- **`stop_times.txt`**: Stop times derived from integer service-day seconds formatted as `HH:MM:SS` (values past 23:59:59 format continuously as `24:XX:XX`, conforming to GTFS standard).
- **`calendar.txt` (Weekly Repeating Patterns) / `calendar_dates.txt` (Specific Date Overrides)**: `calendar.txt` maps recurring weekly service intervals directly from `trip_calendar` presence masks. Under provisional state, masks activate observed day types only (`monday..friday = 1, saturday = 0, sunday = 0`), preventing false transit claims. `calendar_dates.txt` maps date-specific overrides: statutory national holidays from `data/holidays.json` that fall on active weekdays emit `exception_type = 2` (service removed) for fakultatif services. Weekend dates are structurally handled in `calendar.txt` and are never written to `calendar_dates.txt`.

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
| **14** | **Single-Snapshot Bootstrap with Incremental Calendar Resolution**. | (a) Retaining 3-capture build precondition; (b) Mutable incremental DB update command. | `build` accepts any $N \ge 1$ complete same-edition snapshots. The service calendar is an evidence-graded pure fold recomputed on every build, not a campaign precondition. Edition family membership is determined by region-scoped station-master hash; board hash equality is enforced strictly within day types. Itineraries use multi-observation addressing and stratified spot-checking. Eliminates campaign deadlock, enables Day-1 working GTFS exports, and preserves deterministic offline rebuilds. |
| **15** | **Decoupled Statutory Holidays Reference Data (`data/holidays.json`)**. | Querying external holiday APIs at runtime or hardcoding calendar exceptions in application code. | National statutory holidays and cuti bersama decrees change annually by government decree and are not published by KCI's API endpoints. Maintaining holiday definitions in version-controlled `data/holidays.json` (mirroring the decoupled reference data pattern of ADR 13) preserves deterministic offline builds, eliminates runtime network dependencies, and provides an auditable source of truth for GTFS `calendar_dates.txt` generation. |
| **16** | **Canonical Station Code Normalization for Upstream Anomalies (`GGL` $\to$ `GRG`)**. | Querying `GGL` directly or mutating raw upstream station catalogs. | KCI's `/api/krl/stations` catalog advertises Grogol as `GGL`. However, the departure board endpoint `/api/krl/schedules` returns 404 for `GGL`, train itinerary stops (`/api/krl/train-schedule`) use `GRG`, and official KCI published timetable PDFs print `GRG`. Ingestion normalizes `GGL` $\to$ `GRG` for departure boards, itineraries, and GIS coordinates, while preserving the raw unmutated upstream payload in `stations.json`. |
| **17** | **Trip-Scoped Diversion Override for Unmigrated Train 5169D (`KAT` $\to$ `SUDB`)**. | Global station aliasing in `STATION_CODE_OVERRIDES` or mutating raw capture files. | On September 1, 2026, KAI Commuter temporarily suspended passenger boarding at Stasiun Karet (`KAT`) and diverted all 264 suburban Cikarang Line services to Stasiun BNI City (`SUDB`). Upstream updated 263 itineraries but missed train `5169D` (still emitting `KAT`), while omitting `KAT` from `stations.json`. To prevent corrupting distinct physical station identities for non-passenger or future services, the override is strictly scoped to `5169D` via `TRIP_STATION_OVERRIDES`, leaving the global station catalog pristine and compiling 100% of revenue trips cleanly (documented in `docs/anomalies/karet-bni-city-diversion.md`). |
| **18** | **Destination Bypass Routing Normalization & Symmetric Transliteration**. | Quarantining trips with route bypass suffixes or strict exact-match station naming. | Departure boards frequently append routing annotations (`VIA PSE`, `VIA KPB`) and employ alternate historical spelling conventions (`PRIUK` vs `PRIOK`, `oe` $\leftrightarrow$ `u`). Implementing `cleanDestinationName` and symmetric transliteration in `src/core/route.ts` rescues 124 trips from quarantine without sacrificing referential integrity. |
| **19** | **Topological Board Reconstruction Fallback for Defective/Missing Itineraries**. | Dropping trips with 404 itineraries or corrupt sequences. | When full itinerary arrays are unavailable upstream or violate referential integrity, station departure boards provide an empirical topological trace. The build engine reconstructs the chronological stop sequence by sorting observed departure times across candidate snapshots, picking the candidate snapshot with the largest occurrence count, deriving transit intervals, and computing terminus arrival from `dest_time`. |

---

## 12. Verification Matrix & Open Tests

| Verification Area | Empirical Test | Status | Architectural Resolution |
|---|---|:---:|---|
| **Upstream Station Code Divergence (`GGL` vs `GRG`)** | Queried Grogol station schedules via both `GGL` and `GRG` and checked itinerary stop sequences. | **Verified** ✅ | `/api/krl/schedules?stationid=GGL` returns 404, while `stationid=GRG` returns 200 with complete departures. Itineraries and published PDFs exclusively use `GRG`. Normalized at ingestion boundary via `STATION_CODE_OVERRIDES` (`GGL` $\to$ `GRG`, ADR 16). |
| **Backend Static vs. Date-Aware State** | Three-way diff between Weekday, Saturday, and Sunday captures. | Assumed Resolvable Post-Hoc | Decoupled from build gating. Evaluated via stratified spot-checks during weekend captures and full presence mask folding; the pipeline emits the static vs. date-aware verdict as a build report artifact once $\ge 2$ day types are captured. |
| **Terminus Board Rows** | Queried major hub boards (Tanah Abang, Manggarai, Bekasi) using `dest == sta_name`. | **Verified** ✅ | Yields 0 records. Station boards are confirmed departure-only. Terminus arrivals are derived from `dest_time`. |
| **Time Granularity** | Compared board payload times against train-schedule itinerary times. | **Verified** ✅ | Station boards round departures to `:00`. Itineraries expose exact sub-minute seconds (e.g., `15:41:30`). Both stored. |
| **Station Dropdown Headers** | Verified structural headers starting with `WIL%` in station master. | **Verified** ✅ | Rows are UI section headers with `fg_enable=0`. Filtered via `sta_id NOT LIKE 'WIL%'`. |
| **Operational Flag Exceptions** | Inspected Serang station (`SG`) configuration. | **Verified** ✅ | Serang has `fg_enable=0` despite operating 14 daily departures. Schema must never filter on `fg_enable=1`. |
| **Line Brand Extraction** | Cross-referenced `ka_name` across corridor payloads. | **Verified** ✅ | Consistently carries clean commercial designations (`"COMMUTER LINE CIKARANG"`). Mapped directly to `trips.line_name`. |
| **Transit Field Typings** | Inspected itinerary payloads for transfer interchange representations. | **Verified** ✅ | Returns `""` (empty string) when absent, or `string[]` of hex color codes when present. Normalized via Zod at boundary. |
| **Geospatial Coordinate Coverage** | Cross-referenced OSM railway stations against KCI master (`group_wil: 0`, 94 stations). | **Verified** ✅ | 100% of physical Jabodetabek and Merak stations mapped to WGS-84 coordinates in `data/station_coordinates.csv`. Non-commuter lines (MRT, LRT, Whoosh, freight, regional) and non-stop stations (Gambir) explicitly filtered via `scripts/fetch-station-coordinates.ts`. |
| **Board-Itinerary Stop Count Integrity** | Compare board departure appearances against itinerary total stops ($\text{appearances} == \text{total\_stops} - 1$). | **Verified by Construction** ✅ | Enforced network-wide as Invariant 13. Evaluates during offline fold at zero network cost, detecting upstream itinerary truncation or phantom stops. |
| **Board Departure Minute Truncation** | Compare sub-minute itinerary departure times (e.g., `15:41:30`) against station board departure strings across multiple stations to determine whether upstream displays use `floor()`, `round()`, or an operational ceiling. | **Verified** ✅ | Invariant 4 tolerates $\pm 60$s window, successfully reconciling truncated board `:00` times against sub-minute itinerary timestamps across all corridor stations. |
| **Loop-Line Double-Visit Board Rows** | Verify whether trains calling twice at interchange loop stations (e.g., Kampung Bandan `KPB` or Jatinegara `JNG`) generate two distinct departure board rows for the same `train_id`. | **Open** ⏳ | Invariant 13 counts board departure rows (not distinct stations). If upstream collapses loop double-visits into a single board row, the invariant reconciles loop topology via itinerary sequence inspection. |
| **Weekday Uniformity** | Comparative diff between Tuesday and Thursday board captures. | **Open** ⏳ | Assumed identical based on operational domain standards; verifiable via multi-day capture comparison. |
| **Itinerary Census Coverage** | Total network itinerary census probe. | **Verified** ✅ | 100% of discovered passenger revenue trains probed. Fallback topological reconstruction serves strictly as a defensive boundary guard (0 reconstructed trips on Timetable v1 baseline). |
| **Karet vs. BNI City Upstream Defect** | Check train `5169D` itinerary stops against active station catalog. | **Verified** ✅ | KAI Commuter Sept 1, 2026 diversion suspended Karet; unmigrated record emitted `KAT`. Resolved via `KAT` $\to$ `SUDB` in `TRIP_STATION_OVERRIDES` via `resolveTripStationCode` scoped strictly to train `5169D` (ADR 17). |
| **Destination Bypass Suffixes & Spelling** | Match board route destinations against physical station catalog. | **Verified** ✅ | Stripped `VIA ...` bypass annotations and applied symmetric transliteration (`PRIUK` $\leftrightarrow$ `PRIOK`), rescuing 124 trips (ADR 18). |
| **Live Timetable v1 Build Baseline** | Execute `krl build 1` on committed snapshot and itinerary census. | **Verified** ✅ | 1,139 trips compiled with 100% full itinerary fidelity; 0 reconstructed trips; 19 quarantined trips (12 deadheads, 7 regional diesel trains); 111 operational stations folded. |
| **Annual Holiday Coverage** | Cross-check national SKB 3 Menteri holiday decrees against feed dates. | **Enforced by Gate** ✅ | Governed by `--require-holiday-coverage` export gate and audit warnings, preventing uncovered holiday exceptions from silently entering GTFS feeds. Sourced from version-controlled `data/holidays.json`. |

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
│ 13 Build-Time│◀──────( Invariant Engine )──────│ SQLite STRICT  │
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
- **Fail-Fast Invariant Suite:** Thirteen strict structural invariants prevent corrupted, drifted, or truncated upstream data from silently landing in release builds.
- **Permanent Archival Foundation:** Committing deterministic, raw JSON payloads decouples downstream data modeling from the upstream collection process, ensuring full reproducibility regardless of external API lifecycles.