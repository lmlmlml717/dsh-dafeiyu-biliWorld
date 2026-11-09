// 「主人是谁」的唯一口径：ownerQqOf 决定推给谁 / 标谁 / 学谁的昵称，mergeOwner 决定怎么写进 bili.config.json。
//
// 之前这四处各写了一遍 `config.ownerQQ || config.allowPrivate[0]`，任何一处写歪就会「话推给 A、标记给 B」。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeOwner, ownerQqOf } from '../src/bili/owner.ts';

test('ownerQqOf：qqNative.ownerQQ 优先，其次 dailyBili.ownerQQ，再退回白名单第一个', () => {
  assert.equal(ownerQqOf({ qqNative: { ownerQQ: '50005', allowPrivate: ['111'] } }), '50005');
  assert.equal(ownerQqOf({ dailyBili: { ownerQQ: '50005' }, qqNative: { allowPrivate: ['111'] } }), '50005', 'qqNative 没配就用 dailyBili');
  assert.equal(ownerQqOf({ qqNative: { allowPrivate: ['111', '222'] } }), '111', '都没配就用白名单第一个');
  assert.equal(ownerQqOf({ qqNative: { ownerQQ: '  ' , allowPrivate: ['111'] } }), '111', '空白串算没配');
  assert.equal(ownerQqOf({}), '', '什么都没有就是空');
  assert.equal(ownerQqOf(undefined), '', '配置缺省也不抛');
});

test('mergeOwner：qq 每次都跟随，学到的昵称只在空着时补', () => {
  // 第一次：两个字段都写进去。
  const first = mergeOwner(undefined, { qq: '50005', name: '伙伴' });
  assert.deepEqual(first.owner, { qq: '50005', name: '伙伴' });
  assert.equal(first.changed, true);

  // 你手填过名字：QQ 昵称不能把它盖掉。
  const kept = mergeOwner({ qq: '50005', name: '我自己起的' }, { qq: '50005', name: '伙伴' });
  assert.equal(kept.owner.name, '我自己起的');
  assert.equal(kept.changed, false, '一个字段都没变就不该写盘');

  // 换了号：qq 要跟上，名字仍然保留。
  const renumbered = mergeOwner({ qq: '111', name: '我自己起的', mid: '99' }, { qq: '50005' });
  assert.equal(renumbered.owner.qq, '50005');
  assert.equal(renumbered.owner.mid, '99', 'mid 这些不认识的字段要原样留着');
  assert.equal(renumbered.changed, true);
});

test('mergeOwner：坏掉的 owner 段（null / 字符串）当空的处理，不抛错', () => {
  assert.deepEqual(mergeOwner(null, { qq: '50005' }).owner, { qq: '50005' });
  assert.deepEqual(mergeOwner('写坏了', { qq: '50005' }).owner, { qq: '50005' });
  // 什么都没给就什么都不加。
  assert.equal(mergeOwner({ qq: '1' }, {}).changed, false);
});
