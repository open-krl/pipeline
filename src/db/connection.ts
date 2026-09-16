import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as schema from "./tables";

/**
 * Build is a pure fold: the DB is a derived artifact, recreated from scratch
 * every run (Section 8). No migration state exists to carry between builds.
 */
export function initDb(path: string, schemaPath?: string) {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    rmSync(p, { force: true });
  }

  const sqlite = new Database(path);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  const resolvedSchemaPath =
    schemaPath ?? fileURLToPath(new URL("../../db/schema.sql", import.meta.url));
  const ddl = readFileSync(resolvedSchemaPath, "utf8");
  sqlite.exec(ddl);

  const db = drizzle({ client: sqlite });
  return { sqlite, db };
}
