import type { Database } from "bun:sqlite";
import { nowIso } from "../util/id";

interface Migration {
  version: number;
  name: string;
  sql: string;
  /** Columns to add only when missing, after `sql` runs. SQLite has no
   * `ADD COLUMN IF NOT EXISTS`; this keeps a re-applied migration (tests rewind
   * `_migrations`) a no-op instead of a "duplicate column" error. */
  addColumns?: Array<{ table: string; column: string; type: string }>;
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
    // human's approval (via `request_plan_approval`) before any agent runs. Null
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
    // (e.g. a plan presented via `request_plan_approval`) and cleared when it proceeds, so it
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
  {
    version: 5,
    name: "session_jira_tickets",
    // Session-scoped JIRA ticket tracking, the sibling of `session_prs`. TRACK ONLY:
    // Tack never creates/edits/transitions a ticket — the supervisor links keys it's
    // working on (`link_jira_ticket`) and the dashboard refreshes title/status
    // read-only through the configured Atlassian MCP server. Keyed by
    // (session, key) so re-linking or a status refresh upserts in place; a ticket
    // can be tracked by several sessions independently. `status` is the workflow
    // name as Jira shows it ("In Review"); `status_category` is Jira's stable
    // new|indeterminate|done bucket, which is what we color/roll up on since
    // workflow names vary per project. Cascades with the session like the PRs do.
    sql: `
      CREATE TABLE session_jira_tickets (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id        TEXT,               -- best-effort link to the agent working it
        key             TEXT NOT NULL,      -- e.g. ABC-123 (uppercased)
        url             TEXT,               -- <siteUrl>/browse/<key>, when jira is configured
        title           TEXT,
        status          TEXT,               -- workflow status name, e.g. "In Progress"
        status_category TEXT,               -- new | indeterminate | done
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        UNIQUE (session_id, key)
      );

      CREATE INDEX idx_session_jira_tickets_session ON session_jira_tickets(session_id);
    `,
  },
  {
    version: 6,
    name: "pr_watch",
    // PR watch (see src/prwatch/watch.ts): a per-session background process polls
    // the session's open PRs, and on new review feedback or a merge conflict spawns a
    // `pr_fix` agent, then pushes its commits and replies on GitHub.
    //
    //  - `session_prs` gains the polled GitHub status: `mergeable` (MERGEABLE |
    //    CONFLICTING | UNKNOWN — UNKNOWN means GitHub hasn't computed it yet, so the
    //    watcher just retries next tick), the `base_branch` a conflict is resolved
    //    against, the `head_sha` last seen, and `checked_at` (last successful poll).
    //  - `sessions.pr_watch_pid` is the watcher process, so the dashboard / open_pr
    //    can tell whether one is already running and lifecycle can SIGTERM it.
    //  - `agents.kind` distinguishes a normal agent (NULL) from a `pr_fix` agent, and
    //    `session_pr_id` ties a fix agent to the PR it's fixing. `post_fixed_at` is the
    //    watcher's idempotency latch for a fix agent's post-fix step (push + replies):
    //    once stamped, the step never re-runs, so Tack can't double-push or
    //    double-post — even for a conflict-only run that has no feedback rows to latch on.
    //  - `pr_feedback` is one row per GitHub comment Tack has taken in as input. The
    //    comment body and Tack's reply live on disk (`body_ref` / `reply_ref`), never
    //    inline. UNIQUE(session_pr_id, source_id) is what makes "already seen"
    //    durable: a comment is ingested once, whatever happens to it afterwards.
    //    `in_reply_to` is the root comment id of a review thread, because GitHub's
    //    replies endpoint only accepts a thread's top-level comment. `author_is_bot`
    //    is captured at ingest (gh's bot shapes vary) so a reply never @-mentions — and
    //    thereby re-summons — a review bot.
    sql: `
      ALTER TABLE session_prs ADD COLUMN mergeable TEXT;
      ALTER TABLE session_prs ADD COLUMN base_branch TEXT;
      ALTER TABLE session_prs ADD COLUMN head_sha TEXT;
      ALTER TABLE session_prs ADD COLUMN checked_at TEXT;
      ALTER TABLE sessions ADD COLUMN pr_watch_pid INTEGER;
      ALTER TABLE agents ADD COLUMN kind TEXT;
      ALTER TABLE agents ADD COLUMN session_pr_id TEXT;
      ALTER TABLE agents ADD COLUMN post_fixed_at TEXT;

      CREATE TABLE pr_feedback (
        id            TEXT PRIMARY KEY,
        session_pr_id TEXT NOT NULL REFERENCES session_prs(id) ON DELETE CASCADE,
        source_id     TEXT NOT NULL,        -- GitHub comment/review id
        source_kind   TEXT NOT NULL,        -- review_thread | review | issue_comment
        author        TEXT,
        author_is_bot INTEGER NOT NULL DEFAULT 0, -- 1 = bot/app account (still feedback)
        url           TEXT,
        path          TEXT,                 -- review_thread only
        line          INTEGER,              -- review_thread only
        in_reply_to   TEXT,                 -- review_thread: the thread's root comment id
        body_ref      TEXT,                 -- file: the comment body
        fix_agent_id  TEXT,                 -- the pr_fix agent handling it (NULL = unassigned)
        decision      TEXT NOT NULL DEFAULT 'pending', -- pending | fixed | declined | not_applicable | failed
        reply_ref     TEXT,                 -- file: the agent's reply text
        reply_url     TEXT,                 -- the posted reply on GitHub
        created_at    TEXT NOT NULL,
        handled_at    TEXT,                 -- when Tack finished with it (replied / gave up)
        UNIQUE (session_pr_id, source_id)
      );

      CREATE INDEX idx_pr_feedback_pr ON pr_feedback(session_pr_id);
      CREATE INDEX idx_pr_feedback_agent ON pr_feedback(fix_agent_id);
      CREATE INDEX idx_agents_session_pr ON agents(session_pr_id);
    `,
  },
  {
    version: 7,
    name: "pr_merged_at",
    // Keep merge activity on its actual day rather than the latest refresh day.
    sql: `ALTER TABLE session_prs ADD COLUMN merged_at TEXT;`,
  },
  {
    version: 8,
    name: "agent_interrupted_at",
    // Archive remembers which agents to relaunch when the session is restored.
    sql: `ALTER TABLE agents ADD COLUMN interrupted_at TEXT;`,
  },
  {
    version: 9,
    name: "session_usage",
    // Historical supervisor usage is unknown and remains zero; no backfill.
    sql: `
      ALTER TABLE sessions ADD COLUMN tokens_input INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN tokens_output INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN cache_read INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 10,
    name: "session_code_version_and_turn",
    sql: `
      ALTER TABLE sessions ADD COLUMN supervisor_code_version TEXT;
      ALTER TABLE sessions ADD COLUMN pr_watch_code_version TEXT;
      ALTER TABLE sessions ADD COLUMN supervisor_turn_started_at TEXT;
    `,
  },
  {
    version: 11,
    name: "agent_fix_outcome",
    // Runtime completion precedes the watcher's push; NULL preserves legacy rows.
    sql: `
      ALTER TABLE agents ADD COLUMN fix_outcome TEXT;
      ALTER TABLE agents ADD COLUMN fix_pushed_sha TEXT;
    `,
  },
  {
    version: 12,
    name: "agent_fix_origin",
    // Legacy NULL origins count as automatic runs for the anti-loop cap.
    sql: `
      ALTER TABLE agents ADD COLUMN fix_origin TEXT;
    `,
  },
  {
    version: 13,
    name: "agent_continuation",
    // Persist the active turn and baseline so detached retries and archive restore
    // never silently restart a continuation from its original assignment.
    sql: `
      ALTER TABLE agents ADD COLUMN continues_agent_id TEXT;
      ALTER TABLE agents ADD COLUMN continuation_prompt_ref TEXT;
      ALTER TABLE agents ADD COLUMN continuation_started_at TEXT;
      ALTER TABLE agents ADD COLUMN diff_base TEXT;
    `,
  },
  {
    version: 14,
    name: "session_config_version",
    sql: `
      ALTER TABLE sessions ADD COLUMN supervisor_config_version TEXT;
      ALTER TABLE sessions ADD COLUMN pr_watch_config_version TEXT;
    `,
  },
  {
    version: 15,
    name: "agent_personas",
    // Reports stay on disk; the row records the lens, target and report reference.
    sql: `
      ALTER TABLE agents ADD COLUMN persona TEXT;
      ALTER TABLE agents ADD COLUMN reviews_agent_id TEXT;
      ALTER TABLE agents ADD COLUMN review_ref TEXT;
    `,
  },
  {
    version: 16,
    name: "session_pr_ready_promoted",
    // A human returning a promoted PR to draft must not trigger another promotion.
    sql: `ALTER TABLE session_prs ADD COLUMN ready_promoted_at TEXT;`,
  },
  { version: 17, name: "session_pr_fix_enabled", sql: `ALTER TABLE sessions ADD COLUMN pr_fix_enabled INTEGER NOT NULL DEFAULT 1;` },
  {
    version: 18,
    name: "session_summary",
    // A durable local record of what a session did, so a later supervisor can learn
    // from it (`search_past_sessions` / `read_past_session`). `summary_ref` is the
    // composed markdown summary (rewritten each time `open_pr` succeeds) and
    // `summary_at` when that last happened; `session_prs.body_ref` is the PR
    // description the supervisor wrote. NULL = written before this existed — readers
    // compose a summary on the fly instead, so there is no backfill.
    sql: `
      ALTER TABLE sessions ADD COLUMN summary_ref TEXT;
      ALTER TABLE sessions ADD COLUMN summary_at TEXT;
      ALTER TABLE session_prs ADD COLUMN body_ref TEXT;
    `,
  },
  {
    version: 19,
    name: "pr_fix_runs",
    // A PR's `pr_fix` agent row is requeued for later fix runs, so one row no longer
    // means one run. `pr_fix_runs` is the per-run history: one row per fix spawn
    // (new or reused agent), finished when post-fix latches. The daily anti-loop cap
    // counts these, not agent rows, so reuse can't dodge it; origin NULL is legacy
    // and counts as automatic. Backfill one run per existing fix agent, with a
    // deterministic id so a re-applied migration (tests rewind `_migrations`) is a
    // no-op. `session_pr_id` mirrors the agent's and is nullable for odd legacy rows.
    sql: `
      CREATE TABLE IF NOT EXISTS pr_fix_runs (
        id            TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        session_pr_id TEXT,
        origin        TEXT,                 -- auto | supervisor | NULL (legacy = auto)
        created_at    TEXT NOT NULL,
        finished_at   TEXT,                 -- post-fix latch time; NULL while in flight
        outcome       TEXT,                 -- AgentFixOutcome; NULL until post-fix / legacy
        pushed_sha    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pr_fix_runs_pr ON pr_fix_runs(session_pr_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_pr_fix_runs_agent ON pr_fix_runs(agent_id);
      INSERT OR IGNORE INTO pr_fix_runs (id, agent_id, session_pr_id, origin, created_at, finished_at, outcome, pushed_sha)
        SELECT 'fr_' || id, id, session_pr_id, fix_origin, created_at, post_fixed_at, fix_outcome, fix_pushed_sha
          FROM agents WHERE kind = 'pr_fix';
    `,
  },
  { version: 20, name: "pr_dependencies", sql: `
    CREATE TABLE IF NOT EXISTS pr_dependencies (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      downstream_pr_id TEXT NOT NULL REFERENCES session_prs(id) ON DELETE CASCADE,
      upstream_pr_id TEXT NOT NULL REFERENCES session_prs(id), ecosystem TEXT NOT NULL, package TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting_merge', merge_sha TEXT, merged_at TEXT, release_tag TEXT,
      released_version TEXT, feedback_id TEXT REFERENCES pr_feedback(id), created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, detail TEXT, UNIQUE(downstream_pr_id, upstream_pr_id)
    );
  ` },
  {
    version: 21,
    name: "session_pr_linked_at",
    // `link_pr` adopts an existing GitHub PR into a session. `linked_at` marks such
    // rows (NULL = Tack opened it via `open_pr` / discovery): only linked rows may be
    // unlinked, and summaries say "linked" rather than "opened" for them.
    sql: ``,
    addColumns: [{ table: "session_prs", column: "linked_at", type: "TEXT" }],
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
      if (m.sql.trim()) db.exec(m.sql);
      for (const c of m.addColumns ?? []) {
        const cols = db.prepare(`PRAGMA table_info(${c.table})`).all() as Array<{ name: string }>;
        if (!cols.some((col) => col.name === c.column)) db.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.type}`);
      }
      record.run(m.version, m.name, nowIso());
    }
  })();
}
