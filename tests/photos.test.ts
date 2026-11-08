import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import { DatabaseSync } from 'node:sqlite';
import { createPhotoStore } from '../src/life/photos.ts';

const image = { ref: { attachmentId: AttachmentId('image-1'), mediaType: 'image/png' as const, bytes: 4, width: 2, height: 2 }, data: new Uint8Array([1, 2, 3, 4]) };
test('album persists images and metadata together, deduplicates and pages without loading image bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'world-photos-')); let store = createPhotoStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const saved = store.keep(image, '窗边', ['家', '家']);
  assert.equal(store.keep(image).id, saved.id);
  store.keep({ ...image, ref: { ...image.ref, attachmentId: AttachmentId('image-2') } }, '门口');
  assert.equal(store.list(1, 0).hasMore, true); assert.equal(store.list(1, 1).photos[0]!.description, '窗边');
  assert.doesNotMatch(JSON.stringify(store.list()), /data|base64/);
  store.close(); store = createPhotoStore(root);
  assert.deepEqual([...store.image(saved.id)!.data], [...image.data]);
  store.forget(saved.id); assert.equal(store.image(saved.id), undefined); assert.equal(store.list().total, 1);
  assert.throws(() => store.list(101, 0), /分页/);
  assert.throws(() => store.keep({ ...image, data: new Uint8Array([1]) }), /大小/);
  assert.equal(store.list().total, 1, 'a failed save adds no metadata');
  const failing = new DatabaseSync(join(root, 'photos/album.sqlite'));
  failing.exec("CREATE TRIGGER deny_photo BEFORE INSERT ON photos BEGIN SELECT RAISE(ABORT,'disk test'); END"); failing.close();
  assert.throws(() => store.keep({ ...image, ref: { ...image.ref, attachmentId: AttachmentId('image-3') } }), /disk test/);
  assert.equal(store.list().total, 1, 'a database write failure rolls back the image and metadata');
});
test('old album files are imported once and left untouched', t => {
  const root = mkdtempSync(join(tmpdir(), 'world-photos-old-')); mkdirSync(join(root, 'photos'));
  const old = { version: 1, photos: [
    { id: 'photo-newer', file: 'photo-newer.png', savedAt: '2026-10-29T00:00:00Z', attachment: { ...image.ref, attachmentId: AttachmentId('image-2') }, description: '较新照片', tags: [] },
    { id: 'photo-old', file: 'photo-old.png', savedAt: '2026-10-28T00:00:00Z', attachment: image.ref, description: '旧照片', tags: [] },
  ] };
  const index = join(root, 'photos/index.json'); writeFileSync(index, JSON.stringify(old));
  for (const photo of old.photos) writeFileSync(join(root, 'photos', photo.file), image.data);
  const original = readFileSync(index); let store = createPhotoStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(store.list().photos.map(photo => photo.id), ['photo-newer', 'photo-old']);
  store.forget('photo-old'); store.forget('photo-newer'); store.close(); store = createPhotoStore(root);
  assert.equal(store.list().total, 0, 'a deleted migrated photo does not return');
  assert.deepEqual(readFileSync(index), original);
});
