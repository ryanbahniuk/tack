import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServer, TackConfig } from "../config/schema";
import { listSessionJiraTickets, upsertSessionJiraTicket, type SessionJiraTicketRow } from "../db";

/**
 * Session Jira tracking and watcher operations. Jira writes are limited to the
 * watcher in update mode: transition a ticket to Done and add one comment.
 *
 * Tack reads Jira as an MCP *client* of the Atlassian server already configured in
 * `supervisorMcpServers` (named by `config.jira.mcpServer`), not via the REST API.
 * That's the same "shell out; don't reimplement" bet as `gh` for PRs: auth is
 * inherited, not handled. We spawn the server with `{ ...process.env, ...env }`
 * exactly as the supervisor's runtime would, so a server that caches its own OAuth
 * tokens in a user-global file (the chime-atlassian proxy does) authenticates
 * identically here — Tack never sees, stores, or passes a token.
 */

export interface JiraRefreshResult {
  /** Every ticket linked to the requested sessions, post-refresh. */
  tickets: SessionJiraTicketRow[];
  /** Keys Jira couldn't resolve (doesn't exist, no access, per-call failure). */
  skipped: Array<{ key: string; reason: string }>;
  /** Jira as a whole is unreachable: unconfigured, server won't start/connect, or
   * needs interactive OAuth we can't answer headlessly. Statuses are stale. */
  unavailable: boolean;
}

/** Jira's own key shape (project key + number). Shared with the supervisor tool's
 * validation so a key Tack accepts is one it can put in JQL unquoted. */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/** The browse link for a ticket, or null when Jira isn't configured (the key is
 * still tracked; it just has nowhere to link until a `jira` block exists). */
export function jiraTicketUrl(config: TackConfig, key: string): string | null {
  if (!config.jira) return null;
  return `${config.jira.siteUrl.replace(/\/$/, "")}/browse/${key}`;
}

/** A linked ticket's link: the stored url, else one derived from the current
 * config — tickets linked before a `jira` block existed stored null and would
 * otherwise never become openable. */
export function resolveTicketUrl(config: TackConfig | null | undefined, row: { key: string; url: string | null }): string | null {
  return row.url ?? (config ? jiraTicketUrl(config, row.key) : null);
}

// The Atlassian server launches via `uvx --refresh …`, which re-resolves and may
// rebuild the package on every start — tens of seconds, not milliseconds. The
// dashboard refreshes every couple of minutes, so paying that per tick is absurd:
// connect lazily once, keep the client at module scope, and reuse it. `connecting`
// de-dupes concurrent first callers onto one spawn. Any connection-level failure
// resets the cache so a later tick retries from scratch (e.g. once the human has
// seeded the OAuth cache), and `closeJiraClient()` reaps the child on exit.
const CONNECT_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 30_000;
/** Issues per JQL search — keeps one `key in (...)` query well under JQL limits. */
const SEARCH_BATCH = 50;

interface JiraConn {
  /** Which configured server this connection is for, so a changed config reconnects. */
  serverName: string;
  client: Client;
  /** Tool name → declared input property names (to send only args a tool accepts). */
  tools: Map<string, Set<string>>;
  /** Resolved lazily on first use and cached for the connection's lifetime. */
  cloudId: string | null;
}

let conn: JiraConn | null = null;
let connecting: Promise<JiraConn> | null = null;
/** Bumped by `closeJiraClient`, so a connect that was still in flight when the
 * dashboard closed discards (and reaps) its client instead of orphaning it. */
let generation = 0;

/** Rejects after `ms` with a labelled timeout, without leaking the timer. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function jiraServer(config: TackConfig): McpServer | null {
  if (!config.jira) return null;
  return config.supervisorMcpServers.find((s) => s.name === config.jira!.mcpServer) ?? null;
}

async function getConn(config: TackConfig): Promise<JiraConn> {
  const server = jiraServer(config);
  if (!server) throw new Error("jira not configured (no matching supervisorMcpServers entry)");
  if (conn && conn.serverName === server.name) return conn;
  if (conn) await closeJiraClient();
  if (connecting) return connecting;

  const gen = generation;
  connecting = (async () => {
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      // Full parent env, not the SDK's minimal default — the server must see the
      // same $HOME/$PATH as the human's shell to find uvx and its token cache.
      env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
      // The server's logs would scribble over the Ink dashboard; drop them.
      stderr: "ignore",
    });
    const client = new Client({ name: "tack-jira", version: "1.0.0" });
    try {
      await withTimeout(client.connect(transport, { timeout: CONNECT_TIMEOUT_MS }), CONNECT_TIMEOUT_MS, "jira connect");
      const listed = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
      const tools = new Map<string, Set<string>>(
        listed.tools.map((t) => [t.name, new Set(Object.keys(t.inputSchema?.properties ?? {}))]),
      );
      if (gen !== generation) throw new Error("jira client closed while connecting");
      const c: JiraConn = { serverName: server.name, client, tools, cloudId: null };
      // If the server dies later, drop the cache so the next tick reconnects.
      client.onclose = () => {
        if (conn === c) conn = null;
      };
      conn = c;
      return c;
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/** Closes the cached client (reaping the server subprocess). Safe to call anytime. */
export async function closeJiraClient(): Promise<void> {
  generation++;
  const c = conn;
  conn = null;
  if (c) await c.client.close().catch(() => {});
}

/** Calls a tool, returning its parsed JSON payload. Throws on a tool-level error or
 * timeout; a timeout also drops the connection, since a wedged server would
 * otherwise eat every later call's full timeout too. */
async function callJson(c: JiraConn, name: string, args: Record<string, unknown>): Promise<unknown> {
  // Only send optional args the tool actually declares, so a server with a strict
  // input schema doesn't reject the whole call over a field it doesn't know.
  const declared = c.tools.get(name);
  const filtered = Object.fromEntries(
    Object.entries(args).filter(([k, v]) => v !== undefined && (!declared || declared.size === 0 || declared.has(k))),
  );
  let res;
  try {
    res = await c.client.callTool({ name, arguments: filtered }, undefined, { timeout: CALL_TIMEOUT_MS });
  } catch (err) {
    if (conn === c) await closeJiraClient();
    throw err;
  }
  const texts = ((res.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text!);
  if (res.isError) throw new Error(firstLine(texts.join("\n")) || `${name} failed`);
  return parseJsonLoose(texts);
}

/** MCP tools return JSON as text content, sometimes split across parts or wrapped
 * in prose. Try the whole thing, then each part, then the outermost {...}/[...]. */
function parseJsonLoose(texts: string[]): unknown {
  for (const candidate of [texts.join(""), ...texts]) {
    try {
      return JSON.parse(candidate);
    } catch {
      const m = candidate.match(/[[{][\s\S]*[\]}]/);
      if (m) {
        try {
          return JSON.parse(m[0]);
        } catch {
          /* keep trying */
        }
      }
    }
  }
  return null;
}

function firstLine(s: string): string {
  return (s || "").trim().split("\n").find((l) => l.trim()) ?? "";
}

/** cloudId resolution, cheapest first: explicit config → the server's own
 * CONFLUENCE_CLOUD_ID env (the chime-atlassian example already sets it) → ask the
 * server which sites this login can see, preferring the one matching `siteUrl`. */
async function resolveCloudId(config: TackConfig, c: JiraConn): Promise<string> {
  if (config.jira?.cloudId) return config.jira.cloudId;
  const fromEnv = jiraServer(config)?.env?.CONFLUENCE_CLOUD_ID;
  if (fromEnv) return fromEnv;
  if (c.cloudId) return c.cloudId;
  if (!c.tools.has("getAccessibleAtlassianResources"))
    throw new Error("no cloudId configured and server lacks getAccessibleAtlassianResources");
  const data = await callJson(c, "getAccessibleAtlassianResources", {});
  const list = (Array.isArray(data) ? data : asObj(data)?.resources ?? []) as unknown[];
  const sites = list.map(asObj).filter((r): r is Record<string, unknown> => typeof r?.id === "string");
  const site = normSite(config.jira?.siteUrl);
  const match = sites.find((r) => normSite(r.url as string | undefined) === site) ?? sites[0];
  if (!match) throw new Error("getAccessibleAtlassianResources returned no sites");
  c.cloudId = match.id as string;
  return c.cloudId;
}

const normSite = (u: string | undefined) => (u ?? "").replace(/\/+$/, "").toLowerCase();

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

interface IssueStatus {
  title: string | null;
  status: string | null;
  statusCategory: string | null;
}

/** Pulls every issue-shaped object (`{ key, fields }`) out of a tool payload,
 * wherever it's nested — `{ issues: [...] }`, a bare issue, a GraphQL-ish
 * `{ issues: { nodes } }` — so a server's envelope shape doesn't matter. */
function collectIssues(data: unknown, out = new Map<string, IssueStatus>(), depth = 0): Map<string, IssueStatus> {
  if (depth > 6 || data == null || typeof data !== "object") return out;
  if (Array.isArray(data)) {
    for (const d of data) collectIssues(d, out, depth + 1);
    return out;
  }
  const o = data as Record<string, unknown>;
  const fields = asObj(o.fields);
  if (typeof o.key === "string" && fields) {
    const status = asObj(fields.status);
    const category = asObj(status?.statusCategory);
    out.set(o.key.toUpperCase(), {
      title: typeof fields.summary === "string" ? fields.summary : null,
      status: typeof status?.name === "string" ? status.name : null,
      statusCategory: typeof category?.key === "string" ? category.key : null,
    });
    return out;
  }
  for (const v of Object.values(o)) collectIssues(v, out, depth + 1);
  return out;
}

/**
 * Refreshes title/status for every ticket linked to the given sessions — the
 * dashboard's background poll, mirroring `refreshSessionPrs`. Keys are de-duped
 * across sessions so a ticket two sessions share costs one lookup, and fetched with
 * one `searchJiraIssuesUsingJql` per batch; if search is missing or rejects the
 * query (JQL `key in (...)` fails outright when any one key doesn't exist), it falls
 * back to `getJiraIssue` per key so one bad key can't blank the rest. Results fan
 * back out to every session holding the key.
 *
 * Best-effort, never throws: no `jira` config, a server that won't start, or every
 * call failing (typically auth needing an interactive OAuth prompt) ⇒
 * `unavailable: true`; a single unresolvable key lands in `skipped`. Returns
 * without spawning anything when no session has a linked ticket.
 */
export async function refreshSessionJiraTickets(config: TackConfig, sessionIds: string[]): Promise<JiraRefreshResult> {
  const skipped: JiraRefreshResult["skipped"] = [];
  const union = () => sessionIds.flatMap((id) => listSessionJiraTickets(id));
  try {
    if (!jiraServer(config)) return { tickets: union(), skipped, unavailable: true };

    const sessionsByKey = new Map<string, string[]>();
    for (const sessionId of sessionIds) {
      for (const t of listSessionJiraTickets(sessionId)) {
        if (!sessionsByKey.has(t.key)) sessionsByKey.set(t.key, []);
        sessionsByKey.get(t.key)!.push(sessionId);
      }
    }
    const keys = [...sessionsByKey.keys()].filter((k) => JIRA_KEY_RE.test(k));
    if (keys.length === 0) return { tickets: union(), skipped, unavailable: false };

    let c: JiraConn;
    let cloudId: string;
    try {
      c = await getConn(config);
      cloudId = await resolveCloudId(config, c);
    } catch {
      return { tickets: union(), skipped, unavailable: true };
    }

    const found = new Map<string, IssueStatus>();
    let errors = 0;
    let pending = keys;
    if (c.tools.has("searchJiraIssuesUsingJql")) {
      const missed: string[] = [];
      for (let i = 0; i < keys.length; i += SEARCH_BATCH) {
        const batch = keys.slice(i, i + SEARCH_BATCH);
        try {
          const data = await callJson(c, "searchJiraIssuesUsingJql", {
            cloudId,
            jql: `key in (${batch.join(", ")})`,
            fields: ["summary", "status"],
            maxResults: batch.length,
          });
          collectIssues(data, found);
        } catch {
          errors++;
        }
        missed.push(...batch.filter((k) => !found.has(k)));
      }
      pending = missed;
    }
    if (pending.length > 0 && c.tools.has("getJiraIssue")) {
      for (const key of pending) {
        try {
          const data = await callJson(c, "getJiraIssue", { cloudId, issueIdOrKey: key, fields: ["summary", "status"] });
          const issue = collectIssues(data).get(key);
          if (issue) found.set(key, issue);
          else skipped.push({ key, reason: "not found" });
        } catch (err) {
          errors++;
          skipped.push({ key, reason: firstLine((err as Error).message) || "lookup failed" });
        }
      }
    } else {
      for (const key of pending) skipped.push({ key, reason: "not found" });
    }

    for (const [key, issue] of found) {
      for (const sessionId of sessionsByKey.get(key) ?? []) {
        upsertSessionJiraTicket({
          sessionId,
          key,
          url: jiraTicketUrl(config, key),
          title: issue.title,
          status: issue.status,
          statusCategory: issue.statusCategory,
        });
      }
    }

    // Nothing resolved and calls errored: that's Jira being unreachable (auth,
    // outage), not N individually-missing tickets — report it as such.
    return { tickets: union(), skipped, unavailable: found.size === 0 && errors > 0 };
  } catch {
    return { tickets: union(), skipped, unavailable: true };
  }
}

export interface JiraIssueDetail {
  key: string;
  title: string | null;
  status: string | null;
  statusCategory: string | null;
  description: string;
  subtasks: Array<{ key: string; title: string | null; statusCategory: string | null }>;
}

export async function fetchJiraIssueDetail(config: TackConfig, key: string): Promise<JiraIssueDetail> {
  const c = await getConn(config);
  const cloudId = await resolveCloudId(config, c);
  const data = asObj(await callJson(c, "getJiraIssue", { cloudId, issueIdOrKey: key, fields: ["summary", "status", "description", "issuetype", "subtasks"], responseContentFormat: "markdown" }));
  const fields = asObj(data?.fields);
  if (!fields) throw new Error(`Jira issue ${key} has no fields`);
  const status = asObj(fields.status);
  const description = typeof fields.description === "string" ? fields.description : JSON.stringify(fields.description ?? "");
  return {
    key, title: typeof fields.summary === "string" ? fields.summary : null,
    status: typeof status?.name === "string" ? status.name : null,
    statusCategory: typeof asObj(status?.statusCategory)?.key === "string" ? asObj(status?.statusCategory)!.key as string : null,
    description,
    subtasks: (Array.isArray(fields.subtasks) ? fields.subtasks : []).map((item: unknown) => {
      const sub = asObj(item), f = asObj(sub?.fields), st = asObj(f?.status), cat = asObj(st?.statusCategory);
      return { key: typeof sub?.key === "string" ? sub.key : "", title: typeof f?.summary === "string" ? f.summary : null, statusCategory: typeof cat?.key === "string" ? cat.key : null };
    }),
  };
}

export function selectDoneTransition(data: unknown): { id: string; name: string } | null {
  const obj = asObj(data);
  const entries = Array.isArray(data) ? data : Array.isArray(obj?.transitions) ? obj.transitions : [];
  const choices = entries.map(asObj).filter((t): t is Record<string, unknown> => {
    const to = asObj(t?.to), category = asObj(to?.statusCategory);
    return typeof t?.id === "string" && category?.key === "done";
  });
  const chosen = choices.find(t => typeof t.name === "string" && t.name.toLowerCase() === "done") ?? choices[0];
  if (!chosen) return null;
  const target = asObj(chosen.to);
  return { id: chosen.id as string, name: typeof target?.name === "string" ? target.name : "Done" };
}

export async function transitionJiraIssueToDone(config: TackConfig, key: string): Promise<{ kind: "updated"; status: string } | { kind: "no_transition" }> {
  const c = await getConn(config), cloudId = await resolveCloudId(config, c);
  const transition = selectDoneTransition(await callJson(c, "getTransitionsForJiraIssue", { cloudId, issueIdOrKey: key }));
  if (!transition) return { kind: "no_transition" };
  await callJson(c, "transitionJiraIssue", { cloudId, issueIdOrKey: key, transition: { id: transition.id } });
  return { kind: "updated", status: transition.name };
}

export async function addJiraComment(config: TackConfig, key: string, markdown: string): Promise<void> {
  const c = await getConn(config), cloudId = await resolveCloudId(config, c);
  await callJson(c, "addCommentToJiraIssue", { cloudId, issueIdOrKey: key, commentBody: markdown, contentFormat: "markdown" });
}
