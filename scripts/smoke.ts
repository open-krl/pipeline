// scripts/smoke.ts
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import fc from "fast-check";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { initDb } from "../src/db/connection";
import * as schema from "../src/db/tables";

let failed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => {
	try {
		await fn();
		console.log(`✅ ${name}`);
	} catch (e) {
		failed++;
		console.error(`❌ ${name}\n   ${e}`);
	}
};

const expect = (cond: boolean, msg: string) => {
	if (!cond) throw new Error(msg);
};

const expectThrows = (fn: () => unknown, msg: string) => {
	try {
		fn();
	} catch {
		return;
	}
	throw new Error(msg);
};

const canary = sqliteTable("canary", {
	id: integer("id").primaryKey(),
	sta_id: text("sta_id").notNull(),
	fg_enable: integer("fg_enable").notNull(),
});

await check("node:crypto sha256 known vector", () => {
	expect(
		createHash("sha256").update("hello").digest("hex") ===
			"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		"digest mismatch",
	);
});

await check(
	"bun:sqlite — schema.sql applies, WAL, STRICT, CHECK enforced",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "krl-smoke-"));
		const dbPath = join(dir, "t.db");
		const sqlite = new Database(dbPath);
		sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
		const ddl = readFileSync("db/schema.sql", "utf8");
		sqlite.exec(ddl);

		const walPragma = sqlite.query("PRAGMA journal_mode;").get() as {
			journal_mode: string;
		};
		expect(walPragma.journal_mode.toLowerCase() === "wal", "WAL not active");

		const fkPragma = sqlite.query("PRAGMA foreign_keys;").get() as {
			foreign_keys: number;
		};
		expect(fkPragma.foreign_keys === 1, "foreign_keys not active");

		expectThrows(
			() =>
				sqlite.run(
					"INSERT INTO stations (sta_id, sta_name, group_wil, fg_enable) VALUES ('X','X','invalid_wil',1)",
				),
			"STRICT did not reject non-numeric TEXT into INTEGER column",
		);

		expectThrows(
			() =>
				sqlite.run(
					"INSERT INTO stations (sta_id, sta_name, group_wil, fg_enable) VALUES ('X','X',0,2)",
				),
			"CHECK(fg_enable IN (0,1)) not enforced",
		);

		sqlite.close();
		rmSync(dir, { recursive: true, force: true });
	},
);

await check(
	"drizzle-orm/bun-sqlite v1 — typed insert/select + constraints pass through",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "krl-smoke-drizzle-"));
		const dbPath = join(dir, "t.db");
		const sqlite = new Database(dbPath);
		sqlite.exec("PRAGMA journal_mode = WAL;");
		sqlite.exec(
			"CREATE TABLE canary (id INTEGER PRIMARY KEY, sta_id TEXT NOT NULL, fg_enable INTEGER NOT NULL CHECK (fg_enable IN (0,1))) STRICT;",
		);
		const db = drizzle({ client: sqlite });

		db.insert(canary).values({ id: 1, sta_id: "BKS", fg_enable: 1 }).run();
		const rows = db.select().from(canary).all();
		expect(rows.length === 1 && rows[0].sta_id === "BKS", "roundtrip failed");

		expectThrows(
			() =>
				db.insert(canary).values({ id: 2, sta_id: "SG", fg_enable: 2 }).run(),
			"CHECK violation not surfaced through Drizzle",
		);

		sqlite.close();
		rmSync(dir, { recursive: true, force: true });
	},
);

await check(
	"src/db/connection.ts initDb — builds ephemeral DB and operates tables cleanly",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "krl-smoke-initdb-"));
		const dbPath = join(dir, "krl_test.db");
		const { sqlite, db } = initDb(dbPath);

		db.insert(schema.stations)
			.values({
				sta_id: "BKS",
				sta_name: "BEKASI",
				group_wil: 0,
				fg_enable: 1,
				lat: -6.2362,
				lon: 106.9987,
			})
			.run();

		const found = db.select().from(schema.stations).all();
		expect(
			found.length === 1 && found[0].sta_id === "BKS",
			"Failed stations query via initDb",
		);

		sqlite.close();
		rmSync(dir, { recursive: true, force: true });
	},
);

await check(
	"zod 4 — safeParse shape, literal([0,1]), prettifyError, error param",
	() => {
		expect(typeof z.prettifyError === "function", "z.prettifyError missing");
		const flag = z.literal([0, 1]);
		expect(flag.safeParse(0).success === true, "z.literal([0,1]) rejected 0");
		expect(flag.safeParse(1).success === true, "z.literal([0,1]) rejected 1");
		expect(flag.safeParse(2).success === false, "z.literal([0,1]) accepted 2");

		const t = z
			.string()
			.regex(/^\d{2}:\d{2}:\d{2}$/, { error: "Expected HH:MM:SS" });
		expect(t.safeParse("15:41:30").success, "valid time rejected");
		const bad = t.safeParse("nope");
		expect(
			!bad.success && bad.error.issues[0].message === "Expected HH:MM:SS",
			"error param not honored",
		);
	},
);

await check("fast-check 4 — assert/property/integer surface", async () => {
	fc.assert(
		fc.property(fc.integer({ min: 1, max: 9999 }), (n) => n > 0),
		{ numRuns: 100 },
	);
});

await check("node:util parseArgs — CLI parsing", () => {
	const args = parseArgs({
		args: ["--day-type", "sunday", "--reprobe-all"],
		options: {
			"day-type": { type: "string" },
			"reprobe-all": { type: "boolean" },
		},
		strict: true,
	});
	expect(
		args.values["day-type"] === "sunday" && args.values["reprobe-all"] === true,
		"parseArgs shape unexpected",
	);
});

console.log(
	failed === 0 ? "\nALL PROBES PASSED" : `\n${failed} PROBE(S) FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
