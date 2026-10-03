import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { harnessDataDir } from "../runtime/paths.js";
import { migrate } from "./migrations.js";

export function defaultDbPath(root: string = process.cwd()): string {
  return path.join(harnessDataDir(root), "harness.db");
}

/**
 * Opens (and migrates) the harness database. WAL + synchronous=NORMAL gives:
 * acknowledged commits survive a killed process; only power/OS failure may
 * lose the tail. Single-writer by contract, like pi's own storage backends.
 */
export function openDatabase(filePath: string): DatabaseSync {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");
  migrate(db);
  return db;
}
