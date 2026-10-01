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
  {
    version: 3,
    name: "session_attention",
    // Signals for the derived "needs input" state (see cli/liveness.ts).
    //
    // `awaiting_input_at`/`awaiting_reason` are an EPHEMERAL toggle, not a latch
    // like `plan_approved_at`: set when the supervisor blocks on a human decision
    // (e.g. a plan presented via ExitPlanMode) and cleared when it proceeds, so it
    // re-arms on every plan iteration. NULL = not currently waiting.
    //
    // `last_seen_at` (session) + `finished_at` (agent) back the "unread completed
    // work" half: an agent that finished after the human last looked at the session
    // is unread. Both NULL until first stamped.
    sql: `
      ALTER TABLE sessions ADD COLUMN awaiting_input_at TEXT;
      ALTER TABLE sessions ADD COLUMN awaiting_reason TEXT;
      ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
      ALTER TABLE agents ADD COLUMN finished_at TEXT;
    `,
  },
  {
    version: 4,
    name: "agent_activity_failure_coordination",
    // Three features share one migration so the schema moves in a single step:
    //
    //  - Live activity (dashboard): `activity` is a short human label for what the
    //    agent is doing right now (its last tool call), stamped with `activity_at`
    //    so the dashboard can show "… 4s ago". Both NULL until the first tool call.
    //  - Failure legibility + retry: `error` holds the last error message (shown
    //    inline on failed rows instead of only in the output file); `attempt` counts
    //    how many times the runner has (re)started this agent after a transient
    //    failure (0 = first run, never retried).
    //  - Conflict/dependency prediction: `touches` is a JSON array of the files/globs
    //    the supervisor declared this agent will modify (for overlap detection);
    //    `depends_on` is a JSON array of sibling agent ids that must finish before
    //    this one starts (the runner self-gates on them). Both NULL = undeclared.
    sql: `
      ALTER TABLE agents ADD COLUMN activity TEXT;
      ALTER TABLE agents ADD COLUMN activity_at TEXT;
      ALTER TABLE agents ADD COLUMN error TEXT;
      ALTER TABLE agents ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE agents ADD COLUMN touches TEXT;
      ALTER TABLE agents ADD COLUMN depends_on TEXT;
    `,
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
