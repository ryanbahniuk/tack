import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/db/migrate";

test("migration marks only historical linked PR baselines", () => {
  const db = new Database(":memory:");
  migrate(db);
  db.exec(`ALTER TABLE pr_feedback DROP COLUMN baselined_at;
    DELETE FROM _migrations WHERE version >= 24;
    INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s', 'active', 't', 't');
    INSERT INTO session_prs (id, session_id, url, created_at, updated_at, linked_at) VALUES ('linked', 's', 'url1', 't', 't', 't');
    INSERT INTO session_prs (id, session_id, url, created_at, updated_at) VALUES ('opened', 's', 'url2', 't', 't');
    INSERT INTO pr_feedback (id, session_pr_id, source_id, source_kind, decision, created_at, handled_at) VALUES
      ('baseline', 'linked', '1', 'review', 'not_applicable', 't', 't'),
      ('verdict', 'linked', '2', 'review', 'fixed', 't', 't'),
      ('later', 'linked', '3', 'review', 'not_applicable', 't', 'later'),
      ('opened', 'opened', '4', 'review', 'not_applicable', 't', 't');`);
  migrate(db);
  expect(db.query("SELECT id, baselined_at FROM pr_feedback ORDER BY id").all()).toEqual([
    { id: "baseline", baselined_at: "t" }, { id: "later", baselined_at: null },
    { id: "opened", baselined_at: null }, { id: "verdict", baselined_at: null },
  ]);
  db.close();
});
