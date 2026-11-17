import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "../paths";
import { migrate } from "./migrate";

let instance: Database | null = null;

/** Opens (once) and returns the shared SQLite connection, migrations applied. */
export function getDb(path = DB_PATH): Database {
  if (instance) return instance;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // Boot ownership transactions can overlap between CLI and dashboard workers.
  db.exec("PRAGMA busy_timeout = 30000;");
  migrate(db);
  instance = db;
  return instance;
}
