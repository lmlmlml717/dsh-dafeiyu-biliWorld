import assert from 'node:assert/strict';
import test from 'node:test';
import { lifeTools } from '../src/life/tools.ts';
import type { Outlet, Push, PushKind } from '../src/ecosystem/shared/outlets.ts';

const ctx = {} as never;
const none = { outlets: [] };
const outlet = (name: string, send: (push: Push) => Promise<void>, kinds: PushKind[] = ['reply', 'busy', 'reach']): Outlet => ({ name, kinds, send });
const fail = (reason: string) => async () => { throw new Error(reason); };

test('plan_next forwards exactly the given selector and note', async () => {
  const seen: unknown[] = [];
  const [planNext] = lifeTools({ planNext: (input, note) => { seen.push({ input, note }); return 'ok'; }, notifier: none });
  assert.equal(planNext.name, 'plan_next');
  assert.equal(await planNext.execute({ after_minutes: 30, note: '去写日记' }, ctx), 'ok');
  assert.equal(await planNext.execute({ at: '2026-10-24T08:00:00+09:00', note: '早安' }, ctx), 'ok');
  assert.deepEqual(seen, [{ input: { after_minutes: 30 }, note: '去写日记' }, { input: { at: '2026-10-24T08:00:00+09:00' }, note: '早安' }]);
});
test('a throwing planNext makes plan_next reject', async () => {
  const [planNext] = lifeTools({ planNext: () => { throw new Error('太近了'); }, notifier: none });
  await assert.rejects(planNext.execute({ after_minutes: 0, note: 'x' }, ctx), /太近了/);
});
test('reach_out goes to the system notification and every outlet that takes reach, and reports each one', async () => {
  const seen: unknown[] = [];
  const [, reachOut] = lifeTools({
    planNext: () => '', names: { companion: '鲸鲸', partner: '阿明' }, origin: () => 'http://127.0.0.1:5173',
    notifier: {
      toast: async (title, body) => { seen.push({ title, body }); },
      outlets: [outlet('桌面应用', async push => { seen.push(push); }), outlet('只要回复', async push => { seen.push(push); }, ['reply']), outlet('坏的', fail('HTTP 404'), ['reach'])],
    },
  });
  assert.equal(reachOut.name, 'reach_out');
  assert.match(reachOut.description, /想找阿明时用/); assert.match(reachOut.description, /（系统通知 \+ 桌面应用 \+ 坏的）/);
  assert.equal(await reachOut.execute({ text: '**在吗** ![哼](/m/a.png)', image: '可爱' }, ctx), '系统通知已发出；桌面应用已送到；坏的没送到：HTTP 404。');
  assert.deepEqual(seen, [
    { title: '鲸鲸', body: '**在吗** ![哼](/m/a.png)' },
    { text: '在吗', kind: 'reach', name: '鲸鲸', images: ['http://127.0.0.1:5173/m/a.png'], image: '可爱' },
  ]);
});
test('reach_out fails only when every channel fails, so the model sees an error', async () => {
  const [, partly] = lifeTools({ planNext: () => '', notifier: { toast: fail('超时'), outlets: [outlet('桌面应用', async () => {})] } });
  assert.equal(await partly.execute({ text: '在吗' }, ctx), '系统通知没送到：超时；桌面应用已送到。');
  const [, allFail] = lifeTools({ planNext: () => '', notifier: { toast: fail('超时'), outlets: [outlet('桌面应用', fail('running.json 读不到'))] } });
  await assert.rejects(allFail.execute({ text: '在吗' }, ctx), { message: '系统通知没送到：超时；桌面应用没送到：running.json 读不到。' });
});
test('without any channel, reach_out says so instead of pretending', async () => {
  const [, reachOut] = lifeTools({ planNext: () => '', notifier: none });
  assert.match(reachOut.description, /现在还没有配置任何通道/);
  await assert.rejects(reachOut.execute({ text: '在吗' }, ctx), /还没有配置任何通道，话留在家里了/);
  const [, toastOnly] = lifeTools({ planNext: () => '', notifier: { toast: async () => {}, outlets: [] } });
  assert.match(toastOnly.description, /（系统通知）/);
  assert.equal(await toastOnly.execute({ text: '在吗' }, ctx), '系统通知已发出。');
});
