import type { Database } from "bun:sqlite";
import { nowIso } from "../util/id";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * New Tack's schema. Two entities only — Session and Agent (no Run). Every column
 * that could hold a large blob is a `*_ref` path into the artifacts directory,
 * never inline text, so the DB stays small.
 */
const migrations: Migration[] = [
  {
    version: 1,
    name: "init",
    sql: `
      CREATE TABLE sessions (
        id               TEXT PRIMARY KEY,
        title            TEXT,
        supervisor_model TEXT,              -- model NAME (config handle)
        runtime          TEXT,              -- supervisor runtime: claude | codex
        resume_ref       TEXT,              -- runtime session id, to resume the supervisor
        status           TEXT NOT NULL,     -- active | archived (liveness = pid + heartbeat)
        cost             REAL NOT NULL DEFAULT 0,  -- supervisor-conversation cost only
        pid              INTEGER,
        heartbeat_at     TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );

      CREATE TABLE agents (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        project_name  TEXT NOT NULL,
        worktree_path TEXT,
        branch        TEXT,
        status        TEXT NOT NULL,        -- pending | running | done | failed | stopped
        model         TEXT,                 -- model NAME (config handle)
        runtime       TEXT,                 -- claude | codex
        resume_ref    TEXT,                 -- runtime session id, to resume this agent
        cost          REAL NOT NULL DEFAULT 0,
        cost_source   TEXT,                 -- runtime | pricing
        tokens_input  INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0,
        cache_read    INTEGER NOT NULL DEFAULT 0,
        cache_write   INTEGER NOT NULL DEFAULT 0,
        pid           INTEGER,
        prompt_ref    TEXT,                 -- file: the spawn prompt
        output_ref    TEXT,                 -- file: the agent's final result
        diff_ref      TEXT,                 -- file: captured diff
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE shared_context (
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        version     INTEGER NOT NULL,
        body_ref    TEXT NOT NULL,          -- file holding the contract body
        authored_by TEXT NOT NULL,          -- 'supervisor' or an agent id
        created_at  TEXT NOT NULL,
        PRIMARY KEY (session_id, version)
      );

      CREATE TABLE amendments (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        proposed_by    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        proposal_ref   TEXT NOT NULL,       -- file holding the proposal text
        status         TEXT NOT NULL,       -- pending | accepted | rejected
        resolution_ref TEXT,                -- file holding the supervisor's verdict
        created_at     TEXT NOT NULL,
        resolved_at    TEXT
      );

      CREATE TABLE session_prs (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id     TEXT,                  -- best-effort link to the producing agent
        project_name TEXT,
        number       INTEGER,
        url          TEXT NOT NULL,
        title        TEXT,
        state        TEXT,                  -- open | merged | closed
        head_branch  TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE INDEX idx_agents_session ON agents(session_id);
      CREATE INDEX idx_amendments_session ON amendments(session_id);
      CREATE INDEX idx_session_prs_session ON session_prs(session_id);
      CREATE UNIQUE INDEX idx_session_prs_url ON session_prs(session_id, url);
    `,
  },
  {
    version: 2,
    name: "session_plan_approval",
    // The plan-approval gate for `spawn_agent`: an attended supervisor must get the
    // human's approval (via the runtime's ExitPlanMode) before any agent runs. Null
    // means unapproved; a timestamp means approved. Background (headless) sessions
    // are stamped up front since there is no human in the loop.
    sql: `ALTER TABLE sessions ADD COLUMN plan_approved_at TEXT;`,
  },
];

/** Applies any pending migrations in a single transaction. */
export function migrate(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  );
  const row = db.prepare(`SELECT MAX(version) AS v FROM _migrations`).get() as {
    v: number | null;
  };
  const current = row.v ?? 0;
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return;

  const record = db.prepare(
    `INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)`,
  );
  db.transaction(() => {
    for (const m of pending) {
      db.exec(m.sql);
      record.run(m.version, m.name, nowIso());
    }
  })();
}
