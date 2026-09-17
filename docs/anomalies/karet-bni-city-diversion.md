# Upstream Anomaly: Stasiun Karet (KAT) vs. Stasiun BNI City (SUDB) Operational Diversion

## Executive Summary

During Stage 3 database compilation (`krl build 1`) for Timetable Version 1 (captured September 17, 2026), **1,138 trips** compiled with full itinerary fidelity, while exactly **one passenger trip**—train `5169D`—was flagged by Invariant 9 (Station Referential Integrity) and fell back to topological board reconstruction.

Investigation revealed an upstream API database migration glitch caused by a real-world physical operational diversion enacted by KAI Commuter on **September 1, 2026**.

---

## 1. Corridor Geography & Physical Context

On the Commuter Line Cikarang corridor between Manggarai and Tanah Abang, trains traverse the following sequential stations:

```
[MRI] Manggarai (km 0+000)
  │
[SUD] Sudirman (km 1+846)
  │ (~400m)
[SUDB] Sudirman Baru / BNI City (km 2+450)
  │ (~450m)
[KAT] Karet (km 2+014)
  │ (~2,000m)
[THB] Tanah Abang (km 4+048)
```

Historically, regular suburban Commuter Line trains called at **Stasiun Karet (`KAT`)**, while **Stasiun BNI City (`SUDB`)** served exclusively as the premium Soekarno-Hatta Airport Rail Link terminal. In late 2022, KAI Commuter began allowing select KRL trains to stop at BNI City, but Karet remained the primary local commuter stop.

---

## 2. Chronology of Events

### A. Pre-September 2026 (Published Gapeka Master Timetable)
The official published Gapeka PDF timetable printed by KAI Commuter scheduled all regular Cikarang Line services through this corridor to stop at **Stasiun Karet (`KAT`)**:
- `THB` $\leftrightarrow$ `KAT` $\leftrightarrow$ `SUD` $\leftrightarrow$ `MRI`
- Station `SUDB` was not printed as a regular commuter stop for standard suburban trips in the static master schedule.

### B. September 1, 2026: Official KAI Commuter Operational Policy Change
On September 1, 2026, KAI Commuter officially enacted a temporary operational policy adjustment scheduled through December 31, 2026, to facilitate major integration construction:
1. **Passenger Service Suspension at Karet:** Passenger boarding and alighting at Stasiun Karet (`KAT`) was suspended.
2. **Transfer of Operations to BNI City (`SUDB`):** All passenger boarding services previously handled by Karet were relocated to Stasiun BNI City (`SUDB`).
3. **Pedestrian Connector (*Selasar*):** A dedicated covered pedestrian corridor was opened connecting the Karet station perimeter directly to the west gate of Stasiun BNI City.
4. **Active Timetable Adjustment:** KAI Commuter announced that all **264 daily Cikarang Line services** would continue operating normally, with train dwell and passenger boarding taking place at BNI City (`SUDB`).

### C. September 17, 2026: Data Capture
Our automated capture and census pipelines crawled KCI's live digital endpoints for Timetable Version 1.

---

## 3. Investigation Findings & Upstream Defects

Interrogation of the raw captured data and live API probes uncovered three interrelated upstream API defects:

### 1. KCI Station Catalog Omission
KCI's `/api/krl/stations` API returns 114 stations. While `SUD` (Sudirman) and `SUDB` (Sudirman Baru) are present, **`KAT` (Karet) was omitted entirely** from their active station roster following the September 1st policy implementation.

### 2. Departure Board 404
Querying KCI's departure board endpoint for Karet:
```bash
curl "https://www.kci.id/api/krl/schedules?stationid=KAT&timefrom=00:00&timeto=23:59"
# Response: {"status":404,"data":"Data not found"}
```
No departure boards are published for `KAT`. Meanwhile, `stationid=SUDB` successfully serves 200+ daily departure records.

### 3. Upstream Database Migration Glitch (The 263 vs. 1 Split)
In KCI's train itinerary backend (`/api/krl/train-schedule`):
- **263 out of 264 trains** traversing the Sudirman corridor were migrated to list `SUDB`:
  ```
  ... -> MRI (19:45) -> SUD (19:48) -> SUDB (19:49) -> THB (19:58) -> ...
  ```
- **Exactly 1 train (`5169D`)** was missed during KCI's database update, retaining the pre-September 1st schedule that emitted `KAT`:
  ```
  ... -> MRI (19:40) -> SUD (19:43) -> KAT (19:45) -> THB (19:52) -> ...
  ```
- **0 trains** in KCI's API feed contained both `KAT` and `SUDB`.

---

## 4. Pipeline Impact & Invariant Enforcement

Because `KAT` was omitted from `stations.json` (due to Defect #1), `validStationIds` contained only the 114 operational stations.

When `fold.ts` processed `5169D`:
1. Itinerary stop #12 requested `station_id: "KAT"`.
2. **Invariant 9 (Station Referential Integrity)** failed:
   ```typescript
   const allStopsReferentiallyValid = stops.every((st) =>
       validStationIds.has(resolveStationCode(st.station_id))
   );
   ```
3. If allowed to proceed, SQLite would have thrown:
   ```
   SqliteError: FOREIGN KEY constraint failed
   ```
   because `trip_stops.station_id` enforces a foreign key constraint against `stations.sta_id`.
4. The pipeline gracefully bypassed the flawed itinerary and executed **topological board reconstruction** (`reconstructFromBoards`) using the 13 station departure boards where `5169D` was observed, producing 14 stops and setting `source: "reconstructed"`.

---

## 5. Resolution & Rationale

We resolved this upstream defect by mapping `KAT` to `SUDB` in `STATION_CODE_OVERRIDES` (`src/config.ts`):

```typescript
export const STATION_CODE_OVERRIDES: Readonly<Record<string, string>> = {
    GGL: "GRG",
    KAT: "SUDB", // KAI Commuter Sept 1, 2026 operational diversion (Train 5169D unmigrated record)
};
```

### Rationale:
1. **Fidelity to Physical Reality:** During Timetable Version 1 (September 2026), trains physically called at Stasiun BNI City (`SUDB`) where passengers boarded, not at the suspended Karet platforms.
2. **Dataset Homogeneity:** Aligns `5169D` with the other 263 corridor services in the active edition.
3. **Full Itinerary Restoration:** With `resolveStationCode("KAT") === "SUDB"`, `5169D` satisfies Invariant 9, Invariant 6 (Monotonicity), and Invariant 5 (Terminus Alignment), compiling cleanly with `source: "itinerary"` and 15 stops.
4. **Final Build Tally:** Brings Timetable Version 1 compilation to **1,139 / 1,139 (100%) itinerary trips**, with **0 reconstructed trips** and 19 legitimate quarantines (12 non-revenue deadhead runs and 7 regional diesel trains).
