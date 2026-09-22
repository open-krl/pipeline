// tests/props/core.props.test.ts
import { expect, test } from "bun:test";
import fc from "fast-check";
import { canonicalSerialize, payloadHash } from "@/core/canonical";
import {
	DEAD_BAND_CUTOFF_SECS,
	parseHMS,
	resolveItinerarySecs,
	secsToDisplay,
	toServiceDaySecs,
} from "@/core/time";
import { parseTrainId, TRAIN_ID_GRAMMAR } from "@/core/trainid";

const RUNS = 500;

// ─── trainid Properties ──────────────────────────────────────────────────────
const validTrainIdArb = fc
	.tuple(
		fc.integer({ min: 1, max: 999999 }).map(String),
		fc.option(fc.constantFrom("A", "B", "C", "D", "E"), { nil: "" }),
		fc.option(fc.constant("F"), { nil: "" }),
	)
	.map(([base, rev, f]) => base + rev + f);

const malformedTrainIdArb = fc
	.string({ minLength: 1, maxLength: 10 })
	.filter((s) => !TRAIN_ID_GRAMMAR.test(s.trim()));

test("trainid: valid identifiers parse and round-trip losslessly", () => {
	fc.assert(
		fc.property(validTrainIdArb, (id) => {
			const parsed = parseTrainId(id);
			if (parsed === null) return false;

			const reconstructed =
				String(parsed.base_train_no) +
				(parsed.revision ?? "") +
				(parsed.is_fakultatif ? "F" : "");

			return (
				parsed.trip_id === id &&
				reconstructed === id &&
				(parsed.revision === null || "ABCDE".includes(parsed.revision)) &&
				parsed.is_fakultatif === id.endsWith("F")
			);
		}),
		{ numRuns: RUNS },
	);
});

test("trainid: invalid identifiers are strictly rejected (never silently coerced)", () => {
	fc.assert(
		fc.property(malformedTrainIdArb, (id) => parseTrainId(id) === null),
		{ numRuns: RUNS },
	);
});

// ─── time Properties ─────────────────────────────────────────────────────────
const hmsStringArb = fc
	.tuple(
		fc.integer({ min: 0, max: 23 }),
		fc.integer({ min: 0, max: 59 }),
		fc.integer({ min: 0, max: 59 }),
	)
	.map(([h, m, s]) =>
		[h, m, s].map((n) => String(n).padStart(2, "0")).join(":"),
	);

test("time: parseHMS ∘ secsToDisplay is an identity over 0..108000s", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 0, max: 86400 + 6 * 3600 }),
			(secs) => parseHMS(secsToDisplay(secs)) === secs,
		),
		{ numRuns: RUNS },
	);
});

test("time: dead-band wrap biconditional — clock < 03:30:00 ⟺ service secs >= 86400", () => {
	fc.assert(
		fc.property(hmsStringArb, (hms) => {
			const clock = parseHMS(hms);
			const service = toServiceDaySecs(hms);

			if (clock < DEAD_BAND_CUTOFF_SECS) {
				return service === clock + 86400 && service >= 86400;
			}
			return service === clock && service < 86400;
		}),
		{ numRuns: RUNS },
	);
});

test("time: monotonic itinerary walk is non-decreasing across all sequential stops", () => {
	// Generate random itineraries with 2 to 20 stops
	const itineraryArb = fc.array(hmsStringArb, { minLength: 2, maxLength: 20 });

	fc.assert(
		fc.property(itineraryArb, (hmsList) => {
			const stops = hmsList.map((time_est) => ({ time_est }));
			const resolved = resolveItinerarySecs(stops);

			if (resolved.length !== stops.length) return false;

			// Verify origin has null arrival, terminus has null departure
			if (resolved[0].arrival_secs !== null) return false;
			if (resolved[resolved.length - 1].departure_secs !== null) return false;

			// Verify monotonicity
			for (let i = 1; i < resolved.length; i++) {
				const prevDeparture =
					i === 1 ? resolved[0].departure_secs : resolved[i - 1].departure_secs;
				const currArrival = resolved[i].arrival_secs;

				if (
					prevDeparture === null ||
					currArrival === null ||
					currArrival < prevDeparture
				) {
					return false;
				}
			}

			return true;
		}),
		{ numRuns: RUNS },
	);
});

// ─── canonical Properties ────────────────────────────────────────────────────
test("canonical: object key ordering does not affect serialization or payloadHash", () => {
	fc.assert(
		fc.property(
			fc.record({
				x: fc.integer(),
				y: fc.string(),
				z: fc.boolean(),
			}),
			(obj) => {
				const reordered = { z: obj.z, x: obj.x, y: obj.y };
				return (
					canonicalSerialize(obj) === canonicalSerialize(reordered) &&
					payloadHash(obj) === payloadHash(reordered)
				);
			},
		),
		{ numRuns: RUNS },
	);
});

test("canonical: array ordering is strictly preserved", () => {
	const a = [1, 2, 3];
	const b = [3, 2, 1];
	expect(canonicalSerialize(a)).not.toBe(canonicalSerialize(b));
	expect(payloadHash(a)).not.toBe(payloadHash(b));
});
