import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot, logout, register, saveSnapshot } from '../src/board-backend.js';

test('Python board client uploads local files, sends operations and restores an attachment', async () => {
  const calls = [];
  const boardId = 'b53c8fca-83bc-4db0-a8d3-757a536852cb';
  const attachmentId = 'c53c8fca-83bc-4db0-a8d3-757a536852cb';
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url, 'http://test').pathname;
    calls.push({ path, options });
    if (path === '/api/v1/users/register') return Response.json({ status: 'Success', data: { access_token: 'client-test-token' } }, { status: 201 });
    if (path === '/api/v1/boards' && options.method === 'POST') return Response.json({ status: 'Success', data: { id: boardId, title: 'Снимок' } }, { status: 201 });
    if (path === `/api/v1/boards/${boardId}/attachments`) {
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('file').name, 'photo.png');
      return Response.json({ status: 'Success', data: { id: attachmentId, originalName: 'photo.png', mime: 'image/png', size: png.length, sha256: '0'.repeat(64), downloadUrl: `/api/v1/boards/${boardId}/attachments/${attachmentId}` } }, { status: 201 });
    }
    if (path === `/api/v1/boards/${boardId}/operations`) {
      const operation = JSON.parse(options.body);
      if (operation.object.type === 'image' && operation.object.asset !== 'landscape') assert.equal(operation.object.attachmentId, attachmentId);
      assert.equal(operation.object.blobId, undefined);
      return Response.json({ status: 'Success', data: { opId: operation.opId, serverSeq: 1, object: operation.object } });
    }
    if (path === `/api/v1/boards/${boardId}`) return Response.json({ status: 'Success', data: {
      id: boardId, title: 'Удалённая копия', role: 'owner', serverSeq: 1,
      objects: [{ id: 'd53c8fca-83bc-4db0-a8d3-757a536852cb', type: 'image', x: 0, y: 0, w: 40, h: 40, text: 'photo.png', color: 'mint', revision: 1, deleted: false, created: 1, attachmentId }],
      attachments: [{ id: attachmentId, originalName: 'photo.png', mime: 'image/png', size: png.length, sha256: '0'.repeat(64), downloadUrl: `/api/v1/boards/${boardId}/attachments/${attachmentId}` }]
    } });
    if (path === `/api/v1/boards/${boardId}/attachments/${attachmentId}`) return new Response(new Blob([png], { type: 'image/png' }), { status: 200, headers: { 'Content-Type': 'image/png' } });
    if (path === '/api/v1/auth/logout') return Response.json({ status: 'Success', data: { loggedOut: true } });
    throw new Error(`Unexpected client request ${options.method || 'GET'} ${path}`);
  };

  await register('person@example.test', 'secure-client-password', 'Участник');
  const result = await saveSnapshot({ title: 'Идеи', objects: [
    { id: 'asset', type: 'image', x: 0, y: 0, w: 40, h: 40, text: '', color: 'mint', asset: 'landscape' },
    { id: 'file', type: 'image', x: 50, y: 0, w: 40, h: 40, text: 'photo.png', color: 'mint', blobId: 'blob-1' },
    { id: 'stroke', type: 'stroke', x: 0, y: 50, w: 20, h: 20, text: '', color: 'mint', points: [[0, 0], [20, 20]] }
  ] }, async id => id === 'blob-1' ? new Blob([png], { type: 'image/png' }) : null);
  assert.deepEqual(result, { id: boardId, title: 'Снимок', files: 1, objects: 3 });
  assert.equal(calls.filter(call => call.path.endsWith('/attachments')).length, 1);
  assert.equal(calls.filter(call => call.path.endsWith('/operations')).length, 3);

  const restored = await loadSnapshot(boardId);
  assert.equal(restored.kind, 'board');
  assert.equal(restored.board.title, 'Удалённая копия');
  assert.equal(restored.names.get(attachmentId), 'photo.png');
  assert.equal((await restored.files.get(attachmentId).arrayBuffer()).byteLength, png.length);
  await logout();
});
