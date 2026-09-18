# Open-KRL Pipeline

A deterministic ingestion, archival, and build pipeline that converts the Kereta Commuter Indonesia (KCI) station REST API into a normalized SQLite database and standard GTFS transit feeds.

---

## Overview

KCI does not provide revision history or GTFS feeds. This toolchain extracts timetable data via station departure boards and train itinerary endpoints, validates structural integrity through 13 domain invariants, and compiles reproducible schedule artifacts offline.

### Pipeline Stages

1. **`capture`**: Fans out across operational station departure boards to discover active services, checks version hashes (Gate 1 & Gate 2), and writes raw snapshot files to disk.
2. **`census`**: Crawls full stop sequences and timing profiles for discovered train IDs, maintaining multi-observation envelopes with stratified spot-checking.
3. **`build`**: Executes a pure functional fold over raw snapshots into an SQLite database (`krl_v<version>.db`), resolving service calendars, reconstructing 404 itineraries, and validating integrity invariants.
4. **`export`**: Compiles standard GTFS zip packages (`agency.txt`, `stops.txt`, `routes.txt`, `trips.txt`, `stop_times.txt`, `calendar.txt`, `calendar_dates.txt`).

---

## Requirements

- [Bun](https://bun.sh) (v1.3+)
- [Git](https://git-scm.com/)

---

## Quick Start

Install dependencies:

```bash
bun install
```

### Standard Runbook

```bash
# 1. Capture station catalog and departure boards (run on a weekday)
bun run krl capture

# 2. Probe full stop-by-stop itineraries for newly discovered trains
bun run krl census

# 3. Compile SQLite database and fold service calendars
bun run krl build

# 4. Export GTFS feed package
bun run krl export
```

Compiled database files and GTFS archives are output to `data/build/`.

---

## CLI Reference

Run via `bun run krl <command>` or by linking the binary.

### Core Pipeline

| Command | Description | Key Options |
|---|---|---|
| `capture` | Fetches station catalog and all departure boards | `--day-type <type>`, `--region <scope>`, `--new-version`, `--yes`, `--commit` |
| `census [version]` | Crawls itineraries for discovered train IDs | `--day-type <type>`, `--reprobe-all`, `--commit` |
| `build [version]` | Compiles SQLite database and folds calendar presence | `--data-dir <path>`, `--out-dir <path>`, `--db-path <path>` |
| `export [version]` | Generates GTFS specification zip package | `--start-date <YYYY-MM-DD>`, `--end-date <YYYY-MM-DD>`, `--require-resolved-calendar`, `--require-census-complete` |

### Diagnostics & Inspection

| Command | Description | Key Options |
|---|---|---|
| `diff [...snapshots]` | Semantic diff between snapshots, versions, or train itineraries | `--v1 <ver> --v2 <ver>`, `--train <idA> <idB>`, `--detail`, `--git` |
| `detect [version]` | Probes 3 corridor hubs (`MRI`, `BKS`, `RK`) for schedule edition drift | `--date <YYYY-MM-DD>`, `--tolerance <seconds>`, `--fail-on-drift` |
| `calendar [version]` | 3-way set-difference report across weekday, Saturday, and Sunday | `--detail`, `--tolerance <seconds>`, `--json` |
| `list-snapshots [version]` | Lists captured snapshots, day types, hashes, and Git status | `--data-dir <path>` |
| `commit-snapshot [ver] [id]` | Atomically commits a raw capture snapshot to Git | `--data-dir <path>` |

---

## Project Structure

```txt
src/
├── api/          # HTTP client (ky), rate limiting, pacing, and Zod schemas
├── archive/      # Disk storage layout, manifests, and canonical SHA-256 hashing
├── build/        # SQLite compilation, fold logic, 13 validation invariants
├── capture/      # Paced departure board extraction and version gating
├── census/       # Itinerary scraping, caching, and stratified spot-checks
├── cli/          # Command implementations and CLI runner (cac)
├── core/         # Time arithmetic, route parsing, calendar utils, Git helpers
├── db/           # SQLite connection and Drizzle schema mirror
├── diagnostic/   # Fingerprint-based trip matching, semantic diffs, drift detection
└── export/       # GTFS table generators, RFC 4180 CSV serializer, ZIP packer

data/
├── build/        # Compiled SQLite databases and GTFS zip outputs
├── holidays.json # Version-controlled statutory holiday decrees (SKB 3 Menteri)
├── raw/          # Raw immutable JSON archives (versioned by timetable edition)
└── station_coordinates.csv # Station WGS-84 coordinates
```

---

## Validation Invariants

The `build` phase verifies 13 structural invariants before accepting a dataset:

1. **Intra-trip board consistency**: Identical route names, destinations, and colors across all appearances of a train in a capture.
2. **Minimum board occurrences**: Every valid train must appear on ≥ 2 station boards.
3. **Dead-band assertion**: Zero scheduled departures network-wide between 01:30:00 and 03:30:00.
4. **Board-itinerary time congruence**: Board departure minutes must match itinerary stop times within ±60s.
5. **Terminus alignment**: Final scheduled itinerary stop must match trip destination and arrival time.
6. **Stop monotonicity**: Non-decreasing service-day seconds across sequential stops.
7. **Identifier grammar**: Train IDs must match `^(\d+)([A-E])?(F)?$` (invalid IDs quarantined).
8. **Suffix transition bounds**: Revision drift must increment by ≤ 1 ASCII character.
9. **Referential integrity**: All station IDs must resolve to non-header catalog stations.
10. **Atomic capture integrity**: Degraded capture runs are barred from build.
11. **Cross-capture edition consistency**: Captures within a version must share identical station master hashes. Same-day-type captures must share an identical canonical parsed trip set (unparseable identifiers excluded — they are quarantined by Invariant 7 and have no effect on the build).
12. **Cross-capture trip attribute consistency**: Attributes for the same `trip_id` must match across captures.
13. **Board-itinerary stop count congruence**: Number of board departure rows must equal `total_stops` - 1.

---

## Disclaimer & Non-Affiliation

**Open-KRL is an independent, community-driven open-source project.** 

* **No Official Affiliation:** This project is **not** affiliated with, sponsored by, authorized by, maintained by, or in any way officially connected to **PT Kereta Commuter Indonesia (KAI Commuter / KCI)**, **PT Kereta Api Indonesia (Persero) (KAI)**, the Indonesian Ministry of Transportation (Kemenhub), or any of their subsidiaries or affiliates.
* **Trademarks:** All product names, trademarks, service marks, corridor brandings (e.g., *"Commuter Line"*, *"KRL"*), logos, and station names are the registered trademarks and intellectual property of their respective owners. Their mention in this repository is strictly for descriptive, identification, and nominative transit routing purposes and does not imply any official endorsement, sponsorship, or partnership.
* **Schedule Accuracy & Operational Discretion:** The timetable data, GTFS feeds, and databases provided by this toolchain are reverse-engineered and compiled from publicly accessible endpoints for research, archival, and civic transit planning purposes. Operational train schedules, routing variants, and platform assignments are determined solely by KAI Commuter and are subject to real-time modifications, cancellations, delays, and unannounced timetable revisions (GAPEKA).
* **No Travel Warranty:** The authors and contributors provide this data and software on an **"AS IS"** basis, without warranty of any kind. The contributors assume no liability for missed connections, travel delays, direct or indirect damages resulting from reliance on the data generated by this pipeline. 
* **Official Sources:** For official passenger timetables, real-time service disruptions, and ticketing, commuters should always consult official KAI Commuter channels or the official **C-Access** and **Access by KAI** mobile applications.

---

## License

This project utilizes a split licensing model:
1. The **Software and Toolchain** is licensed under the **Apache License 2.0**.
2. The **Timetable Datasets and GTFS Feeds** are licensed under **Creative Commons Attribution 4.0 International (CC-BY 4.0)**.

---

## 1. Software License (Apache License 2.0)

Copyright (c) 2026 Invictus Navarchus

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

---

## 2. Data and Feed License (CC-BY 4.0)

All compiled databases, raw JSON captures, and GTFS archives (`data/build/`,
`data/raw/`, `*.db`, `*.zip`) generated by this repository are made available
under the Creative Commons Attribution 4.0 International License (CC-BY 4.0):
https://creativecommons.org/licenses/by/4.0/

When using or redistributing this transit data, provide attribution as follows:
> "KRL Commuter Line GTFS data compiled and verified by Open-KRL (https://github.com/open-krl/)."
