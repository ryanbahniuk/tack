import { expect, test } from 'bun:test';
import { opsDecision, opsLaunchPlan } from './launch';
import { statusHintText } from '../session/tmux';

test('ops attaches to a live TUI and otherwise resumes a stored conversation', () => {
  expect(opsDecision(true, 'ref', false)).toBe('attach');
  expect(opsDecision(false, 'ref', false)).toBe('resume');
  expect(opsDecision(false, undefined, false)).toBe('fresh');
  expect(opsLaunchPlan(true, 'ref', true)).toEqual({ kill: true, decision: 'resume' });
  expect(opsLaunchPlan(true, 'ref', false)).toEqual({ kill: false, decision: 'attach' });
});

test('ops status points back to its launcher', () => {
  expect(statusHintText('ops', 'C-b', false, 'tack ops')).toContain('reopen: tack ops');
  expect(statusHintText('ops', 'C-b', false, 'tack ops')).not.toContain('session resume');
  expect(statusHintText('ops', 'C-b', false)).toContain('resume: tack session resume ops');
});

import { dashboardLaunchCommand } from '../cli/dashboard';
import { selfCommand } from '../process/self';

test('dashboard launches ops through the CLI handoff', () => {
  expect(dashboardLaunchCommand({ kind: 'ops' })).toEqual(selfCommand(['ops']));
});
