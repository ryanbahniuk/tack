import { expect, spyOn, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CommandDef } from 'citty';
import * as supervisorServer from '../mcp/supervisor-server';
import { OPS_APPROVAL_TOOLS, runOpsServer } from '../mcp/ops-server';

test('ops exposes only the planned tools and gates destructive actions', async () => {
  const connect = spyOn(McpServer.prototype, 'connect').mockResolvedValue();
  const register = spyOn(McpServer.prototype, 'registerTool');
  try {
    await runOpsServer();
    const names: string[] = register.mock.calls.map(c => String(c[0])).sort();
    expect(names).toEqual(['tack_docs_index', 'read_tack_docs', 'search_tack_docs', 'tack_cli_help', 'read_config', 'list_sessions', 'show_session', 'read_session_conversation', 'read_agent_output', 'search_sessions', 'read_session_history', 'recent_activity', 'list_personas', 'create_session', 'hold_session', 'unhold_session', 'unarchive_session', 'start_review', 'set_pr_fix', 'poll_prs', 'archive_session', 'stop_session', 'restart_session', 'delete_session'].sort());
    expect(OPS_APPROVAL_TOOLS).toEqual(['archive_session', 'stop_session', 'restart_session', 'delete_session'].map(n => `mcp__tack-ops__${n}`));
  } finally { register.mockRestore(); connect.mockRestore(); }
});

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { addSharedContext, createAgent, createSession, getDb, setAgentRefs, setAgentStatus, setSessionStatus, upsertSessionPr } from '../db';
import { writeAgentArtifact, writeSharedContext } from '../artifacts/store';
import * as tmux from '../session/tmux';
import * as reports from '../session/bug-report';
import * as config from '../config/load';
import * as supervise from '../supervisor/supervise';
import * as title from '../session/title';
import { readPastSession, searchPastSessions } from '../session/summary';

async function handlers(cli?: CommandDef) {
  const connect = spyOn(McpServer.prototype, 'connect').mockResolvedValue();
  const register = spyOn(McpServer.prototype, 'registerTool');
  await runOpsServer({ cli });
  const map = new Map(register.mock.calls.map(c => [String(c[0]), c[2]]));
  register.mockRestore(); connect.mockRestore();
  return async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const handler = map.get(name) as unknown as (args: unknown) => Promise<{ content: { text: string }[] }>;
    return JSON.parse((await handler(args)).content[0]!.text);
  };
}

test('introspection reads session fixtures, artifacts, history and current activity', async () => {
  const call = await handlers();
  const token = `ops${Math.random().toString(36).slice(2)}`;
  const since = new Date().toISOString();
  const active = createSession({ title: `${token} active`, runtime: 'claude' });
  const archived = createSession({ title: `${token} archived` });
  setSessionStatus(archived.id, 'archived');
  getDb().run("UPDATE sessions SET updated_at = ? WHERE id = ?", ['2000-01-01', archived.id]);
  const agent = createAgent({ sessionId: active.id, projectName: 'ops-fixture' });
  const foreign = createAgent({ sessionId: archived.id, projectName: 'ops-fixture' });
  setAgentStatus(agent.id, 'running');
  setAgentStatus(foreign.id, 'done');
  const ref = writeAgentArtifact(active.id, agent.id, 'output', 'x'.repeat(2000));
  setAgentRefs(agent.id, { outputRef: ref });
  addSharedContext({ sessionId: active.id, authoredBy: 'supervisor', bodyRef: writeSharedContext(active.id, 1, 'fixture contract') });
  upsertSessionPr({ sessionId: active.id, url: 'https://example.test/pull/1', projectName: 'ops-fixture', title: 'fixture PR', state: 'open' });
  const listed = await call('list_sessions', { query: token });
  expect(listed.map((s: any) => s.id)).toContain(active.id);
  expect(listed.map((s: any) => s.id)).not.toContain(archived.id);
  expect((await call('list_sessions', { includeArchived: true, query: token.toUpperCase() })).map((s: any) => s.id)).toContain(archived.id);
  expect((await call('list_sessions', { includeArchived: true, query: token, since: '2020-01-01' })).map((s: any) => s.id)).not.toContain(archived.id);
  const shown = await call('show_session', { sessionId: active.id });
  expect(shown.summary).toContain('fixture contract');
  expect(shown.contract).toBe('fixture contract');
  expect(shown.agents.map((a: any) => a.id)).toContain(agent.id);
  expect(shown.prs[0].title).toBe('fixture PR');
  expect((await call('read_agent_output', { sessionId: active.id, agentId: agent.id, kind: 'output', tailChars: 100 })).length).toBeLessThanOrEqual(100);
  await expect(call('read_agent_output', { sessionId: active.id, agentId: foreign.id, kind: 'output' })).rejects.toThrow('does not belong');
  expect(await call('search_sessions', { query: token, project: 'ops-fixture' })).toEqual(searchPastSessions({ query: token, project: 'ops-fixture' }));
  expect(await call('read_session_history', { sessionId: active.id })).toEqual(readPastSession(active.id));
  const recent = await call('recent_activity', { since });
  expect(recent.inFlight.agents.map((a: any) => a.id)).toContain(agent.id);
  expect(recent.agents.map((a: any) => a.id)).toContain(foreign.id);
  expect(recent.prs.map((p: any) => p.session_id)).toContain(active.id);
  const future = await call('recent_activity', { since: '9999-01-01' });
  expect(future.prs).toEqual([]);
  expect(future.agents).toEqual([]);
  const dir = mkdtempSync(join(tmpdir(), 'ops-transcript-'));
  const path = join(dir, 'transcript.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: 'user', message: { content: 'hello transcript' } }));
  const pathSpy = spyOn(reports, 'claudeReportTranscriptPath').mockReturnValue(path);
  const paneSpy = spyOn(tmux, 'tmuxCapturePane').mockReturnValue('pane fallback');
  try {
    expect(await call('read_session_conversation', { sessionId: active.id })).toEqual({ source: 'transcript', text: 'user: hello transcript' });
    pathSpy.mockReturnValue(join(dir, 'missing'));
    expect(await call('read_session_conversation', { sessionId: active.id })).toEqual({ source: 'pane', text: 'pane fallback' });
  } finally { pathSpy.mockRestore(); paneSpy.mockRestore(); }
});

test('creation parks the selected Claude model and rejects Codex before inserting a session', async () => {
  const call = await handlers();
  const configPath = join(mkdtempSync(join(tmpdir(), 'ops-config-')), 'config.ts');
  writeFileSync(configPath, `export default ${JSON.stringify({ models: ['claude','codex'].map(runtime => ({ key: runtime, name: runtime, id: runtime, provider: 'test', runtime, version: '1' })), roles: { supervisor: ['claude','codex'], agent: 'claude', summary: 'claude' } })}`);
  const cfg = await config.loadConfig(configPath);
  const configSpy = spyOn(config, 'loadConfig').mockResolvedValue(cfg);
  const modelSpy = spyOn(config, 'modelForRole').mockReturnValue(cfg.models[0]!);
  const park = spyOn(supervise, 'superviseInteractive').mockResolvedValue({ code: 0, detached: true });
  const titler = spyOn(title, 'spawnSessionTitler').mockReturnValue(undefined as never);
  try {
    const created = await call('create_session', { problem: 'fixture problem' });
    expect(created.parked).toBe(true);
    expect(park.mock.calls[0]![0]).toMatchObject({ park: true, prompt: 'fixture problem', session: { supervisor_model: 'claude' } });
    modelSpy.mockReturnValue(cfg.models[1]!);
    const before = getDb().query('SELECT count(*) AS n FROM sessions').get();
    await expect(call('create_session', { problem: 'blocked' })).rejects.toThrow('human plan approval');
    expect(getDb().query('SELECT count(*) AS n FROM sessions').get()).toEqual(before);
  } finally { titler.mockRestore(); park.mockRestore(); modelSpy.mockRestore(); configSpy.mockRestore(); }
});

test('gated actions refuse when the runtime cannot enforce approval', async () => {
  const call = await handlers();
  const previous = process.env.TACK_OPS_GATED_DISABLED;
  process.env.TACK_OPS_GATED_DISABLED = '1';
  try {
    for (const name of ['archive_session', 'stop_session', 'restart_session', 'delete_session'])
      await expect(call(name, { sessionId: 'ses_invalid' })).rejects.toThrow('cannot enforce per-call approval');
  } finally {
    if (previous === undefined) delete process.env.TACK_OPS_GATED_DISABLED;
    else process.env.TACK_OPS_GATED_DISABLED = previous;
  }
});


test('CLI help resolves lazy nested commands and excludes hidden names', async () => {
  const cli: CommandDef = { meta: { name: 'tack', description: 'Root' }, subCommands: { group: async () => ({ meta: async () => ({ name: 'group', description: 'Group' }), subCommands: () => ({ child: { meta: { name: 'child', description: 'Child' } }, __x: { meta: { name: '__x' } } }) }), __x: { meta: { name: '__x' } } } };
  const call = await handlers(cli);
  expect(await call('tack_cli_help')).toContain('group');
  expect(await call('tack_cli_help')).not.toContain('__x');
  expect(await call('tack_cli_help', { command: ['group'] })).toContain('child');
  expect(await call('tack_cli_help', { command: ['group', 'child'] })).toContain('Child');
  await expect(call('tack_cli_help', { command: ['group', '__x'] })).rejects.toThrow('Valid subcommands: child');
  await expect((await handlers())('tack_cli_help')).rejects.toThrow('no command tree');
});

test('read_config returns the redacted view of a fixture config', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ops-view-')), 'config.ts');
  writeFileSync(path, `export default { supervisorMcpServers: [{ name: 'fixture', command: 'fixture', env: { SECRET: 'secret-value' } }] }`);
  const view = await supervisorServer.readConfigView(path);
  const spy = spyOn(supervisorServer, 'readConfigView').mockResolvedValue(view);
  try {
    const call = await handlers();
    const result = await call('read_config');
    expect(result.authored.supervisorMcpServers[0].env.SECRET).toBe('<redacted>');
    expect(JSON.stringify(result)).not.toContain('secret-value');
  } finally { spy.mockRestore(); }
});
