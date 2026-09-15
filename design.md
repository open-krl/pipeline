# Design & Discovery Document — KRL Schedule Database

*Supersedes v2 entirely. Both of v2's errors shared one root cause: reading a **document server** as a **data stream**. Four supersessions, each evidence-justified:*

1. **§2.4/§3.2/§6.5 (v2) — the schedules endpoint serves a timetable document, not a live day.** Every `time_est` row is a *pattern* fact, not a dated event: rows carry no date, the post-midnight tail sits identically at the top of every day's board, and the full-day window returns the complete repeating pattern. v2's collection consequences — "a complete service day = snapshot D's body + snapshot D+1's head," consecutive-capture requirements — are **retracted**. The dead-band rule survives as **time arithmetic** (stamping clock times into service-day seconds), which is all GTFS ever needed.
2. **§7.11/§8 (v2) — one-shot operation, not a monitoring station.** Three day-type captures + one itinerary census, run manually, ever. The "periodic canary" becomes an optional manual edition check. No schedule, no daemon, no recurring job.
3. **§5 (v2) — SQLite target, not PostgreSQL.** Deployment simplicity and a Cloudflare D1 serving path. Type enforcement moves from engine to discipline: STRICT tables, CHECK constraints, FK pragma per connection, canonical UTC timestamps, validation at every boundary.
4. **§10 (v2) — the static-vs-date-aware test is no longer a pending probe; it *is* the capture plan.** The three captures perform the test and simultaneously constitute the dataset for either outcome.

---

## 1. Purpose & Deliverables

Ingest KRL's current timetable edition from a station-centric REST API into a normalized relational database, producing:

1. **Relational core** — stations, trips, ordered stop-time sequences.
2. **Service calendar** per trip — the hardest deliverable; strategy branch-gated on the capture diff (§12).
3. **GTFS-compatible export** — routes, trips, stop_times, calendar, calendar_dates (transfers deferred).
4. **A raw-response archive** — KRL serves no history; this archive is the only record of this edition that will ever exist. Not a longitudinal record: one edition, three day-type views, unless a future revision prompts a re-run.
5. **A reconciliation report** against the official PDF timetable — semantic reference, not completeness oracle.

**v1 scope ("done"):** three captures, one census, build, export, report. **Parked:** D1 publish; PDF-scrape calendar extraction (invoked only if the diff says the backend is static); transfer graph.

## 2. Source System: The API

Three endpoints, confirmed from direct inspection of live responses and operator requests:
- **Base URL:** `https://www.kci.id` (redirected from `commuterline.id` or called directly).
- **Network Headers:** Cloudflare bot management is bypassed using standard browser headers (`User-Agent: Mozilla/5.0...`, `Accept: application/json, text/plain, */*`, and `Referer: https://www.kci.id/`).
- **Response Envelope:** Wrapped JSON: `{ status: 200, data: [...] }`, with `message: "Success"` optionally present on station master. Payloads are archived verbatim. Everything below is field-level semantics.

### 2.1 `GET /api/krl/stations` ✅
Station master. Envelope: `{ status: 200, message: "Success", data: [...] }`. Fields: `sta_id`, `sta_name`, `group_wil`, `fg_enable`.
- **Ingestion filter:** `sta_id NOT LIKE 'WIL%'`. `WIL*` rows (`WIL0` Jabodetabek, `WIL1` Merak, `WIL6` Yogyakarta) are regional dropdown section headers rendered with `fg_enable=0`, not physical stations.
- **Critical discovery — do NOT filter on `fg_enable=1`:** Station `SG` ("SERANG") has `fg_enable=0` in the station master despite being a fully operational station (verified: 14 daily departures in `/api/krl/schedules?stationid=SG` and stops on Merak line itineraries). Using `fg_enable=1` as an ingestion gate drops Serang and breaks foreign keys on Merak line trips.
- **`group_wil` semantics:** `group_wil=6` identifies Yogyakarta–Solo stations (17 stations). However, Merak line stations are coded `group_wil=0` (identical to Jabodetabek). Thus, `group_wil=0` cannot isolate Jabodetabek from Merak.

### 2.2 `GET /api/krl/schedules?stationid=&timefrom=&timeto=` ✅
One station's departures board for the requested window (`HH:MM`; `00:00–23:59` returns the full pattern in one call, verified). Envelope: `{ status: 200, data: [...] }`. Fields per row: `train_id`, `ka_name`, `route_name`, `dest`, `time_est`, `color`, `dest_time`.

- `time_est` = **departure at the queried station** — formatted as `HH:MM:SS` (seconds strictly `:00` across all board departures).
- `dest_time` = **arrival at the terminus** — formatted as `HH:MM:SS` (seconds strictly `:00`).
- `ka_name` = **commercial corridor name** — confirmed (e.g. `"COMMUTER LINE CIKARANG"`, `"COMMUTER LINE BOGOR"`, `"COMMUTER LINE RANGKASBITUNG"`, `"COMMUTERLINE MERAK"`).
- `dest`, `dest_time`, `route_name`, `color`, `ka_name` are **identical across every station's row for a given train** — denormalized trip-level data; both a validation invariant and the anchor for midnight-wrap detection.
- **Departure-only boards**: Boards list departures only. A train terminating at station `X` does **not** appear on station `X`'s board as an arrival (`dest == station_name` yields 0 rows across all tested boards). Terminus arrival times are obtained strictly from `dest_time` on upstream departures or from the train itinerary.
- Board is time-sorted with **exact ties** (BKS: 06:10, 08:03, 09:07, 17:52 each carry two trains) — deterministic tie-breaking (`time_est`, then `train_id`) wherever we sort.
- Boards are **complete by construction**: a train absent from a station's board does not serve that station. This makes the board fan-out the discovery backbone of the whole system.

### 2.3 `GET /api/krl/train-schedule?trainid=` ✅
Full ordered itinerary for one train. Requires the **exact operational ID including suffix** — `5552` → 404, `5552A` → 200 (confirmed, load-bearing). Envelope: `{ status: 200, data: [...] }`. Response: ordered array, origin→terminus, both endpoints inclusive: `station_id`, `station_name`, `time_est`, `transit_station` (bool), `color`, `transit` (`""` when empty, `string[]` of connecting line hex colors when populated, e.g. `["#ff8095", "#0000ff"]`).

- **Sub-minute granularity**: Unlike station boards which round to `:00`, itinerary `time_est` contains **exact seconds / sub-minute precision** (e.g. `15:41:30` at Rajawali for `5552A`).
- **Array order is authoritative** — the only source of stop sequence.
- **Coverage unmeasured** (census pending); hypothesis: every board train has an itinerary. A 404-fallback reconstruction path exists regardless, with provenance.
- `transit` uses a **legacy color palette** unrelated to board colors — display metadata, never a key. Flags identify transfer points → candidate transfers material (deferred).

### 2.4 Behavioral profile & operating model

- No auth, plain GET/JSON. Base URL: `https://www.kci.id`. Cloudflare bot management is bypassed by sending standard browser headers (`User-Agent` and `Referer: https://www.kci.id/`).
- **5–10 s latency per call, param-independent** — per-request overhead, not query cost. Consequences: concurrency-limited fan-out; the census is a **one-time, resumable, cache-backed cost** (~1,000–1,500 calls, once per edition, ever).
- **No date parameter exists in the frontend; no history is served.** The server holds the current edition only.
- **Operating model (strong prior, from domain knowledge): the API is a timetable document server.** Same schedule every weekday; weekends may differ. The tail rows at board top (00:02–01:04 at BKS) are the *pattern's own tail*, not yesterday's leftovers — under a live-board reading they would need date stamps to be interpretable across captures, and none exist. Confirmation: the three-capture diff (§9). Free optional corroboration: fetch one board twice in one day and diff.

## 3. Reverse-Engineered Backend

What their system must look like to produce the observed responses. This section exists because inference *predicts* behavior we depend on.

**Inferred store:**

| Inferred table | Evidence |
|---|---|
| `stations(sta_id, sta_name, group_wil, fg_enable)` | Endpoint 2.1 verbatim; `fg_enable=0` rows render as dropdown separators ⇒ the table doubles as frontend UI config |
| `trips(train_id PK, ka_name, route_name, dest, dest_time, color)` | Board's trip-level fields identical across every station ⇒ stored once per trip, joined onto each board row; `dest_time` is the terminus arrival held at trip level |
| `trip_stops(train_id, seq, station_id, time_est, transit flags)` | Itinerary is an ordered, both-endpoints-inclusive array; boards are per-station time-windows over the same stop rows |

**Behavioral inferences:**

1. **The full `train_id` (suffix included) is their primary key.** The 404/200 asymmetry on `5552`/`5552A` proves exact-match keying. Corollary: re-lettering (5022C→D) is a row replacement — which predicts 404s can become 200s as the backend updates, and old suffixes may 404 after a revision. *(High confidence.)*
2. **Two data paths feed the two schedule endpoints.** The itinerary path carries a legacy color palette and a lax serialization (`transit: "" | []`) that the board path doesn't share ⇒ different table or service, older schema. Prediction: itinerary quirks evolve independently of board changes. *(Medium-high.)*
3. **Latency is gateway overhead** — bot management, cold start, or upstream proxy. Prediction: latency won't shrink with smaller windows; concurrency is the only lever. *(High.)*
4. **Edition-scoped, replace-in-place content.** No date params, no history ⇒ revisions overwrite. Our archive is the only record of any captured edition. *(High.)*
5. **Document, not stream** — §2.4's prior; the captures decide. *(Strong prior, pending the diff.)*

## 4. Domain Model

### 4.1 Train identity: the base-number model ⭐
The central discovery. `train_id` is a two-part identifier whose parts behave differently:

| Train | PDF prints (Feb 2026 ed.) | API runs | Stop mapping |
|---|---|---|---|
| 5195 | `5195` | `5195` | identical |
| 5022 | `5022C` | `5022D` | **identical** |
| 5552 | `5552` | `5552A` | **identical** |

**Rule: the base number is persistent identity; the suffix letter is mutable state.** Corollaries:

- Suffixes carry **zero reliable schedule signal** — never infer sameness/difference of times from letters; verify with the fingerprint **(terminus station, arrival time ± tolerance)**.
- Expected letter distance API−PDF ∈ {0, +1}; anything else is a mis-join or renumbering → auto-flag.
- Grammar (100% of 749 observed unique IDs conform): `^(\d+)([A-E])?(F)?$` → `base_train_no`, `revision`, F-flag (F recoverable from the full ID; the F *column* is a derived observation, §6.6). Unparseable IDs → quarantine, never silent coercion.
- Cross-source joins use base number **plus fingerprint** — base alone can be reused across editions.
- Base numbers appear corridor-structured (5xxx/6xxx Cikarang, 16xx Rangkasbitung, 20xx Tangerang) — anomaly heuristic only, unverified.

### 4.2 The service day — arithmetic, not collection
- Operational day runs ~04:00 to ~01:30. BKS observed: dead band **01:04–04:12**, first departure 04:12, tail 00:02–01:04 at board top.
- **Clock times below the dead band belong to the previous service day** — a global rule for converting `HH:MM:SS` to service-day seconds; no per-trip origin knowledge needed. For itineraries, a wrap-detection walk over array order suffices (strict `<`; equal consecutive times are dwell, not wrap).
- **One full-day capture contains the complete pattern, including its tail.** Physical-day reconstruction (which calendar-date instance a tail row belongs to) is neither possible from this API nor needed for GTFS.

### 4.3 `route_name` and physical routing
Grammar: `ORIGIN-TERMINUS[ VIA X]`, concatenated names (`KAMPUNGBANDAN`, `TANAHABANG`). Consequences:

- **Origin comes free** — parse the prefix (cross-checked against, no longer derived from, min-time). Needs name normalization to `sta_id` (`TANAHABANG` → `THB`). **Verified:** stripping all whitespace from station names (`sta_name.replace(/\s+/g, '')`) matches 100% of origin/dest tokens across all 41 observed route patterns.
- `dest` is display text, may include ` VIA X` — strip before station mapping.
- **`VIA` is load-bearing**: BKS→KPB is 59–63 min unlabeled but 45 min `VIA PSE`; 5552A proves the unlabeled route runs via the City line (Rajawali–Kemayoran–Kramat). Distinct physical paths = distinct GTFS patterns, not cosmetic variants.

### 4.4 The loop line (full racket)
No `train_id` appears twice on the BKS board all day; one-pass trips exist in both directions (5552A: KPB→CKR via City; 5505C: CKR→KPB via MRI). Current timetable models the racket as **stitched one-pass trips**. The `(trip_id, stop_sequence)` key is retained anyway (§6.3): topology permits double-visits, and a structural constraint forbidding them would turn a timetable change into a schema failure.

### 4.5 Calendar & markers — the F problem
- F-suffixed trains are **off Saturdays, Sundays, and national holidays** (PDF legend; e.g. Bogor's 1163F).
- **F is not universal**: Rangkasbitung sections mark weekday-off trains with red highlighting + a note column — no ID pattern at all. F is **sufficient, not necessary**; service patterns **cannot be derived from ID parsing**.
- Two strategies, gated on the capture diff: **set-difference across day-type captures** (if the backend is date-aware) or **PDF formatting extraction** (if static — check text-layer machine-readability first).
- A `holidays` table (annual SKB 3 Menteri) is required either way: "weekdays except national holidays" is not a weekend boolean. Cuti bersama behavior is open.
- Standing trap: **never infer day-type from snapshot content** — a weekday-holiday board is indistinguishable from a weekend board. Day-type comes from calendar date + holidays table, always.

### 4.6 Time semantics per stop
One `time_est` per stop: **departure** at origin and intermediates, **arrival** at the terminus. Intermediate arrivals and dwell are unobtainable. GTFS mapping: arrival = departure at intermediates; origin gets departure only; terminus arrival only.

## 5. Information Inventory

| Tier | Information |
|---|---|
| **Direct** | Station master · departure time at each station · terminus name + arrival time (on every board row) · line name · color · `route_name` · itinerary: ordered stops with station ids, times, transfer flags |
| **Derived deterministically** | base/revision/F from ID parse · origin/dest station names from `route_name` split (+ normalization) · service-day seconds (dead-band rule) · stop sequence (itinerary array position) |
| **Inferred, requires cross-validation** | origin/dest as station FKs · wrap classification for 404-fallback trips · service calendar (capture diff or PDF) · fakultatif status (F where present, else set-difference) · transfer graph |
| **Unobtainable from this API** | Intermediate arrivals/dwell · any historical timetable · calendar info *if the backend is static* · per-date actuals (never existed here) |

## 6. Target Schema (SQLite)

Deltas from v2: SQLite dialect (STRICT, TEXT times/dates, INTEGER booleans); new `archive_commit` on `snapshots` (every derived row set linked to its raw evidence — the DB→archive pointer); composite FK `trip_stops → trips`.

```sql
PRAGMA journal_mode = WAL;              -- once, persisted in the file
-- PRAGMA foreign_keys = ON;            -- EVERY connection; application duty (§6.8)

CREATE TABLE stations (
    sta_id      TEXT PRIMARY KEY,
    sta_name    TEXT NOT NULL,
    group_wil   INTEGER NOT NULL,
    fg_enable   INTEGER NOT NULL CHECK (fg_enable IN (0,1)),
    first_seen  TEXT,                    -- 'YYYY-MM-DD'
    last_seen   TEXT
) STRICT;

-- One row per capture run (= one git commit of raw JSON)
CREATE TABLE snapshots (
    snapshot_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date     TEXT NOT NULL,
    day_type          TEXT NOT NULL CHECK (day_type IN ('weekday','saturday','sunday','holiday')),
    fetched_at        TEXT NOT NULL                      -- canonical UTC instant
        CHECK (fetched_at = strftime('%Y-%m-%dT%H:%M:%SZ', fetched_at)),
    status            TEXT NOT NULL CHECK (status IN ('complete','degraded')),
    timetable_version INTEGER NOT NULL,
    archive_commit    TEXT NOT NULL                      -- git commit of this capture's raw payload
) STRICT;

CREATE TABLE trips (
    timetable_version INTEGER NOT NULL,
    trip_id           TEXT NOT NULL,     -- FULL string incl. suffix: '5022D', '5552A', '1163F'
    base_train_no     INTEGER NOT NULL,  -- parsed; cross-source join key
    revision          TEXT CHECK (revision IS NULL OR length(revision) = 1),
    line_name         TEXT NOT NULL,     -- confirmed ← ka_name (commercial corridor, e.g. 'COMMUTER LINE CIKARANG')
    route_name_raw    TEXT NOT NULL,
    headsign          TEXT NOT NULL,     -- raw dest text (may contain ' VIA X')
    origin_station_id TEXT REFERENCES stations(sta_id),
    dest_station_id   TEXT REFERENCES stations(sta_id),
    origin_time       TEXT NOT NULL,     -- display 'HH:MM:SS'
    dest_time         TEXT NOT NULL,     -- display 'HH:MM:SS'
    origin_secs       INTEGER NOT NULL,  -- service-day seconds; all arithmetic lives here
    dest_secs         INTEGER NOT NULL,
    total_stops       INTEGER NOT NULL,  -- stop EVENTS, not distinct stations
    color             TEXT NOT NULL,     -- display metadata only
    is_fakultatif     INTEGER CHECK (is_fakultatif IN (0,1)),   -- DERIVED observation; NULL = undetermined
    service_pattern   TEXT CHECK (service_pattern IS NULL
                                  OR service_pattern IN ('daily','weekday_only','weekend_only')),
    source            TEXT NOT NULL CHECK (source IN ('itinerary','reconstructed')),
    itinerary_status  TEXT NOT NULL CHECK (itinerary_status IN ('200','404','unprobed')),
    first_seen_snapshot INTEGER REFERENCES snapshots(snapshot_id),
    last_seen_snapshot  INTEGER REFERENCES snapshots(snapshot_id),
    PRIMARY KEY (timetable_version, trip_id)
) STRICT;
CREATE INDEX idx_trips_base ON trips (base_train_no);     -- deliberately NON-unique (§6.2)

CREATE TABLE trip_stops (
    timetable_version INTEGER NOT NULL,
    trip_id           TEXT NOT NULL,
    stop_sequence     INTEGER NOT NULL,   -- 1 = origin; itinerary array order (authoritative)
    station_id        TEXT NOT NULL REFERENCES stations(sta_id),
    time_raw          TEXT NOT NULL,      -- display
    arrival_secs      INTEGER,            -- NULL at origin (departure-only semantics)
    departure_secs    INTEGER,            -- NULL at terminus
    is_transit        INTEGER CHECK (is_transit IN (0,1)),
    PRIMARY KEY (timetable_version, trip_id, stop_sequence),
    FOREIGN KEY (timetable_version, trip_id) REFERENCES trips (timetable_version, trip_id)
) STRICT;

CREATE TABLE holidays (
    holiday_date       TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    is_collective_leave INTEGER NOT NULL DEFAULT 0        -- cuti bersama; behavior open
) STRICT;

-- Staging for PDF reconciliation (loaded separately, joined after both sources are in)
CREATE TABLE pdf_trains (
    label TEXT, base_train_no INTEGER, terminus TEXT, arr_time TEXT,
    stops_json TEXT,                                       -- JSON as text, validated on read
    line TEXT,
    reconcile_status TEXT   -- 'exact'|'suffix_shift'|'renumbered'|'api_only'|'pdf_only'
) STRICT;
```

**Design rationale** (condensed from v2, all still load-bearing):

1. **Full-string `trip_id` PK** — the itinerary endpoint keys on it; suffix mutation creates a distinct row, so revision history falls out for free. Base number carries cross-source identity.
2. **`base_train_no` indexed, never unique** — a duplicate base within a capture is *evidence for the day-type-variant hypothesis*, not corruption. A unique constraint would convert an open question into an insert error.
3. **`(trip_id, stop_sequence)`** — time cannot order stops (exact ties; wrap inverts naive sorts); array position is authoritative information; loop topology permits double-visits; GTFS requires it; adjacency queries become trivial; it enables the monotonicity invariant.
4. **INT seconds alongside TEXT display** — service-day times exceed 24:00 (23:30 origin → 25:15 terminus); all arithmetic uses seconds.
5. **Snapshot + version dimensions** — day-type variation, station drift, and withdrawal are only observable across captures; `day_type` from calendar + holidays, never content.
6. **Nullable observations** — `is_fakultatif`/`service_pattern` stay NULL until measured. Every nullable column corresponds to a real open question.
7. **Provenance columns** — `source`/`itinerary_status` make the 404-fallback path first-class and re-probeable (a 404 may become a 200 after a backend update — §3, inference 1).
8. **SQLite discipline** — STRICT tables (reject wrong-type values); CHECKs including the canonical-UTC round-trip on `fetched_at`; FK pragma on every connection (without it SQLite enforces nothing); one transaction per capture load (poisoned-capture all-or-nothing, §7.10); INTEGER 0/1 booleans; TEXT times. The engine no longer guards types — this discipline is what replaces it.

## 7. Validation Invariants

Run at build time, every capture — the safety net that makes silent corruption impossible:

1. **Per-trip field consistency** — `route_name`/`dest`/`dest_time`/`color` identical across all board rows of a train.
2. **≥2 boards per train** — a train serves at least origin + terminus; a single-board appearance means a failed fetch or glitch.
3. **Dead-band assertion** — no departures anywhere in ~[01:30, 03:30].
4. **Board↔itinerary time match** — each board `time_est` equals the corresponding itinerary row (duplicate stations matched by order).
5. **Terminus check** — itinerary's last time == `dest_time`.
6. **Monotonicity** — adjusted times non-decreasing along `stop_sequence`; violations indicate ID reuse or assembly error.
7. **Grammar census** — 100% of IDs match the regex, per capture; violations quarantined.
8. **Letter-distance rule** — API vs. PDF suffix distance ∈ {0, +1}; else flag.
9. **FK existence** — inferred origin/dest must exist in the *filtered* stations table.
10. **Failed board = poisoned capture** — no partial acceptance; a failed station corrupts every trip through it.
11. **Edition consistency** — all captures feeding one build share an edition fingerprint; a cross-capture hash mismatch means a KRL revision landed mid-campaign ⇒ flag and re-capture, never merge silently. (Replaces v2's periodic canary; the manual `detect` command is its post-v1 form.)

## 8. Source-of-Truth Architecture: Raw-First, Git-Versioned

Raw JSON is persisted — deterministically serialized (object keys sorted; **array order preserved**, because itinerary order *is* data) — and committed per capture. The database is a **derived view**, rebuildable from the archive at any time. The **same canonicalization** feeds archive writes and edition fingerprinting; two serializers would manufacture phantom revisions out of formatting noise.

Rationale: the server retains no history — **our archive is the only archive**; a parsing bug costs a re-parse, never a re-fetch (critical with a 5–10 s API and no backfill); change detection happens at the source level, before any parser can normalize a difference away; every conclusion in this document stays reproducible from committed evidence. In the one-shot model, raw-first's payoff concentrates in development: `build` iterates dozens of times against the archive at zero API cost, and the archive doubles as the regression corpus.

**Deliberately not done:** deduping itineraries by stop-pattern (skip-stop variation would fail silently); colors as keys; probing suffix permutations in the census (board IDs verbatim); inferring day-type from content; PDF scraping before the branch is confirmed.

## 9. Operational Model

A CLI, run by hand. Total API exposure for v1: **three ~3-minute captures + one ~40-minute census — under an hour, once, ever.**

**Commands:**

- **`capture`** — compute `day_type` from calendar + holidays table, **require explicit confirmation** (the §4.5 trap, enforced at the only point it can be), fetch station master (if changed) + full board fan-out (~85 stations ÷ concurrency 5 × ~8 s ≈ 3 min), archive, git-commit, insert snapshot row. Accidental double-capture is harmless (upsert, date-keyed).
- **`census`** — itinerary fan-out for every train_id not yet cached; resumable (the cache is raw files, keyed by train_id + edition); ~35–40 min once.
- **`build`** — offline over the archive: invariants, load (single transaction), trip construction, 404-fallback with provenance. Rerunnable freely, zero API cost.
- **`export`** — GTFS + reconciliation report.
- **`detect`** *(optional, months later)* — board re-fetch, fingerprint diff against the stored edition. On change: the diff identifies exactly which train_ids moved ⇒ re-`capture` ⇒ incremental re-census (cache makes this cheap).

**Runbook (v1):**

1. **Weekday capture** (holiday-guarded). Day-1 inspections ride along, all free from this one capture: WIL/`group_wil` check, time-granularity check (seconds in `time_est`?), KPB duplicate-ID check, CKR terminus-board check; optional same-day board re-fetch diff (static corroboration).
2. **Within ~one week: Saturday capture, Sunday capture.** (A timetable revision between captures would masquerade as a day-type difference — the one-week window plus invariant 11 guard this.)
3. **Diff the three captures** → static vs. date-aware resolved → calendar branch chosen; weekend train sets become data if they differ.
4. **Census once.**
5. **Build, export, reconcile.**

**Failure policy:** in-run retry with backoff (a 40-minute fan-out *will* see transient failures); persistent failures printed as a station/train list; re-run `capture` — any day if static is confirmed, same day-type if date-aware; degraded captures are archived but never loaded.

**GTFS mapping (provisional defaults, finalize at export):** `route` = line (Cikarang / Bogor / Rangkasbitung / Tangerang …); `direction_id` canonicalized per line by terminus; `headsign` = `dest` (VIA kept); VIA variants as distinct trip-level patterns; `transfers.txt` deferred (routing engines handle same-stop transfers natively; `is_transit` retained in the DB); calendar provisional all-daily in v1 export, measured patterns once §4.5 resolves; `feed_version` = `timetable_version`; validity `end_date` is a fixed decision made at export time (one-shot feed, no rolling window).

## 10. Implementation Posture

TypeScript on Bun (native TS execution; static typecheck remains a separate CI gate — Bun strips types without checking them). SQLite accessed through a typed query layer (Drizzle) whose migrations are plain SQL artifacts in git — schema defined once, enforcement living in the DDL per §6.8. Runtime validation (zod) at every boundary: HTTP responses, config, archived-file reads; interior code consumes inferred types only. Generic mechanics — HTTP with retry/timeout, rate-limited concurrency, deterministic serialization, CSV writing — are library-owned, never hand-rolled. Hand-written code is confined to a **pure domain core** (dead-band arithmetic, wrap walk, fingerprints, tie-breaks, invariants) over primitives, under property-based tests, with the raw archive as regression corpus. No scheduler, no daemon, no service.

## 11. Decision Log

| # | Decision | Rejected alternative | Reason |
|---|---|---|---|
| 1 | Hybrid: board fan-out = discovery backbone; itineraries = enrichment; 404-fallback with provenance | Boards-only; itineraries-only | Boards complete by construction; itineraries authoritative where present |
| 2 | Full-string `trip_id` PK | Normalizing suffix away | Endpoint keying; revision history free (552/5552A proved it) |
| 3 | `base_train_no` non-unique index | Unique key | Duplicate base = live hypothesis, must be representable |
| 4 | `(trip_id, stop_sequence)` key | `(trip_id, station_id)` | Ties, wrap, loop topology, GTFS, adjacency |
| 5 | INT service-day seconds + TEXT display | TIME-only | >24:00 values; arithmetic |
| 6 | Snapshot + version dimensions | Single-day schema | Day-type variation, drift, withdrawal only observable across captures |
| 7 | `service_pattern` nullable; `is_fakultatif` observed | `runs_on_weekends` from F-parse | F sufficient-not-necessary; holidays inexpressible |
| 8 | Calendar via set-difference *or* PDF extraction, branch-gated | ID parsing (falsified) | §4.5; diff decides |
| 9 | PDF = semantic reference + fingerprint oracle | PDF = completeness oracle | Edition vintage drift proven (5022C→D) |
| 10 | Fingerprint = (terminus, arrival ± tolerance) + base | Number matching alone | Renumbering and suffix mutation both break number-only joins |
| 11 | Raw-first git archive, DB derived | DB as sole store | No server history; re-parse ≠ re-fetch; source-level diffing |
| 12 | Census cached by edition; resumable | Nightly refetch; uncached | 5–10 s latency; cache = crash-resume + edition reuse |
| 13 | Loop-capable schema despite stitched-racket evidence | Enforce one-visit-per-trip | Defense-in-depth; timetable changes must not become schema failures |
| 14 | Colors (both palettes) = display metadata | Color as key | Two palettes; variant colors; rebrand risk |
| 15 | **Document-server model: one capture = complete pattern** | Consecutive-day head/tail stitching collection | Rows undated; tail identical at every board top; time semantics ≠ collection semantics |
| 16 | **One-shot ops: 3 captures + 1 census, manual CLI** | Scheduled recurring capture | No recurring data need; archive is an edition record, not a longitudinal one |
| 17 | **SQLite + enforcement discipline (§6.8)** | PostgreSQL | Ops simplicity; D1 path; STRICT/CHECK/pragma recover type safety |
| 18 | **Libraries own mechanics; pure property-tested core owns domain** | Hand-rolled infra | Fragility lives in custom mechanics, not in domain logic |

## 12. Open Questions & Tests

| Question | Test / Finding | Consequence / Resolution | Status |
|---|---|---|---|
| **Static vs. date-aware backend** | The three-capture diff (+ optional same-day double-fetch) | Calendar strategy branch | Open |
| Weekday homogeneity (Thu == Fri) | Assumed (domain knowledge); PDF reconciliation cross-checks; a 2nd weekday capture is a cheap optional falsifier | Universe completeness | Open |
| Itinerary coverage rate | The census | Whether fallback path is exercised or insurance | Open |
| F + revision co-occurrence (`1614AF`?) | PDF inspection (or full capture census) | Grammar totality | Open |
| Racket = stitched trips? | KPB duplicate-ID check (day-1, free) | Loop representation (defense stands either way) | Open |
| **Terminus station's own board rows** | Checked Tanah Abang, Manggarai, Bekasi boards: 0 arriving rows (`dest == station_name`). | Boards are **departure-only**. Terminus arrivals synthesized via upstream `dest_time` or itinerary. | **Resolved** ✅ |
| Cuti bersama behavior | PDF wording / opportunistic | Calendar exception handling | Open |
| Weekend-only trains exist? | Sat/Sun captures — the data itself | Universe + calendar | Open |
| **Time granularity** | Board departures strictly `HH:MM:00`. Itineraries have sub-minute / exact seconds (e.g. `15:41:30`). | Store as `HH:MM:SS` and integer service-day seconds. Zero window-edge loss. | **Resolved** ✅ |
| **`WIL%` / `group_wil ≠ 0`** | `WIL%` are dropdown headers with `fg_enable=0`. `group_wil=6` is Yogyakarta, `0` is Jabodetabek + Merak. **Trap:** Serang (`SG`) has `fg_enable=0` despite running 14 daily trains. | Ingestion filter must be `sta_id NOT LIKE 'WIL%'`. Do NOT gate on `fg_enable=1`. | **Resolved** ✅ |
| **`line_name` ← `ka_name`?** | `ka_name` verified across all boards and itineraries (e.g. `"COMMUTER LINE CIKARANG"`, `"COMMUTERLINE MERAK"`). | `line_name` sourced directly from `ka_name`. GTFS route mapping confirmed. | **Resolved** ✅ |
| **`transit` field schema** | Itinerary inspection: `""` when empty; `string[]` of connecting line hex colors when populated (e.g. `["#ff8095", "#0000ff"]`). | Zod schema normalized to `string[]` at boundary. | **Resolved** ✅ |
| Holiday coverage per year | Manual SKB maintenance; loader hard-warns on uncovered years | `day_type` correctness | Open |

## 13. Why This Architecture

- **Complete by construction** (boards are exhaustive) and **authoritative where possible** (itinerary order, IDs, terminus rows) — the two sources cover each other's weaknesses, with provenance tracking the seam.
- **Self-validating**: eleven invariants make assembly errors announce themselves instead of silently corrupting the calendar — the failure mode that would matter most in a GTFS export.
- **Calendar-independent of KRL's marker conventions**: F, red ink, or nothing — the pattern is observed or extracted, never parsed from IDs.
- **Edition- and history-aware** within its scope: drift, withdrawals, and re-letterings are first-class data for every edition we capture.
- **Operationally tiny**: under an hour of total API exposure, ever; no service to keep alive; failure is a red terminal, not a silent outage.
- **Rebuildable**: the raw archive is the store; the database is a view. Every analytical claim reduces to committed evidence.

In a nutshell, capture it three times to read its day-types, census it once to enrich it, archive everything because it keeps no history — and stop.

---

**Review pointers** — the three places I introduced something new rather than transcribing, so you can veto: **(1)** `line_name ← ka_name` is confirmed by live payload inspection (§2.2, §2.3, §12); **(2)** the "weekday homogeneity" row in §12 makes your "same every weekday" prior an explicit, falsifiable assumption rather than silent truth; **(3)** schema deltas beyond the dialect swap: `snapshots.archive_commit` and the composite FK on `trip_stops` — both additions, both cheap, say the word if you don't want them.