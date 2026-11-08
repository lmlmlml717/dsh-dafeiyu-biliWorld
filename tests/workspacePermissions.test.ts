import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionId, type Session } from '@deepseek-ai/dsh-session';
import { createWorkspacePermissions } from '../src/workspacePermissions.ts';
import { hostFixture, textResponse } from './hostFixture.ts';

test('workspace defaults apply only to new ordinary sessions and preserve manual choices on resume', async t => {
  const { ctx, root } = await hostFixture(t, () => textResponse('ok'));
  const room = join(root, 'room'); await mkdir(room);
  let selected = 'danger-full-access';
  const permissions = new Map<string, string>();
  const options = [{ value: 'danger-full-access', name: '完全权限' }, { value: 'workspace-write', name: '工作区可写' }, { value: 'restricted', name: '自定义只读' }];
  ctx.provide('permissionPresets', { catalog: () => ({ defaultOptions: options }), set: (session: Session, value: string) => { permissions.set(session.id, value); } });
  const defaults = createWorkspacePermissions(ctx, room, { workspacePermission: () => selected, setWorkspacePermission: value => { selected = value; } });
  const create = (id: string, cwd = room, meta = {}) => ctx.agents.create({ sessionId: SessionId(id), meta: { cwd, agentPreset: 'any-preset', ...meta }, agentOptions: { provider: 'test', model: 'test' } });
  const first = await create('first');
  assert.equal(permissions.get(first.agent.id), 'danger-full-access');
  defaults.set('workspace-write');
  const second = await create('second');
  assert.equal(permissions.get(second.agent.id), 'workspace-write');
  assert.equal(permissions.get(first.agent.id), 'danger-full-access');
  permissions.set(first.agent.id, 'restricted');
  await ctx.sessions.flush(first.agent.session); await first.dispose();
  const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('first'), agentOptions: { provider: 'test', model: 'test' } });
  assert.equal(permissions.get(resumed.agent.id), 'restricted');
  await create('foreign', root);
  await create('subagent', room, { origin: 'subagent', delegationDepth: 1 });
  await ctx.agents.create({ sessionId: SessionId('fork'), meta: { cwd: room, isSeeded: true, parentSession: first.agent.id }, seed: [], inheritedEventCount: 0 as never, agentOptions: { provider: 'test', model: 'test' } });
  assert.equal(permissions.has('foreign'), false);
  assert.equal(permissions.has('subagent'), false);
  assert.equal(permissions.has('fork'), false);
  assert.deepEqual(defaults.snapshot(), { defaultPermission: 'workspace-write', options });
  assert.throws(() => defaults.set('missing-preset'), /未知/);
  assert.equal(selected, 'workspace-write');
});

test('a session whose cwd does not exist is created without a workspace default', async t => {
  const { ctx, root } = await hostFixture(t, () => textResponse('ok'));
  const room = join(root, 'room'); await mkdir(room);
  const permissions = new Map<string, string>();
  ctx.provide('permissionPresets', { catalog: () => ({ defaultOptions: [] }), set: (session: Session, value: string) => { permissions.set(session.id, value); } });
  createWorkspacePermissions(ctx, room, { workspacePermission: () => 'workspace-write', setWorkspacePermission: () => {} });
  const missing = await ctx.agents.create({ sessionId: SessionId('missing'), meta: { cwd: join(root, 'gone'), agentPreset: 'any-preset' }, agentOptions: { provider: 'test', model: 'test' } });
  assert.equal(permissions.has(missing.agent.id), false);
});
