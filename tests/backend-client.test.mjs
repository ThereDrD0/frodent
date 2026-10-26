import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptInvite,
  BoardRealtimeClient,
  createBoard,
  createInvite,
  createSessionTicket,
  getAuthToken,
  getBoard,
  getUserInfo,
  listBoards,
  loadSnapshot,
  logout,
  register,
  saveSnapshot,
  sendOperation,
  setToken,
  uploadAttachment
} from '../src/board-backend.js';

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

test('API client methods: createBoard, listBoards, getBoard, invites, session, operations and attachments', async () => {
  const boardId = 'a1234567-89ab-4cde-8f01-23456789abcd';
  const calls = [];
  setToken('mock-auth-token');
  assert.equal(getAuthToken(), 'mock-auth-token');

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url, 'http://test');
    calls.push({ path: parsed.pathname, search: parsed.search, options });

    if (parsed.pathname === '/api/v1/users/me') {
      return Response.json({ status: 'Success', data: { id: 'u1', email: 'test@example.com', displayName: 'Алексей', role: 'member' } });
    }
    if (parsed.pathname === '/api/v1/boards' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      return Response.json({ status: 'Success', data: { id: boardId, title: body.title, role: 'owner', serverSeq: 0 } }, { status: 201 });
    }
    if (parsed.pathname === '/api/v1/boards' && (!options.method || options.method === 'GET')) {
      return Response.json({ status: 'Success', data: { items: [{ id: boardId, title: 'Моя доска', role: 'owner' }], nextOffset: null } });
    }
    if (parsed.pathname === `/api/v1/boards/${boardId}` && (!options.method || options.method === 'GET')) {
      return Response.json({ status: 'Success', data: { id: boardId, title: 'Моя доска', role: 'owner', serverSeq: 5, objects: [], attachments: [] } });
    }
    if (parsed.pathname === `/api/v1/boards/${boardId}/invite` && options.method === 'POST') {
      return Response.json({ status: 'Success', data: { url: `http://localhost/#invite=token123`, expiresAt: '2026-11-01T00:00:00Z' } });
    }
    if (parsed.pathname === '/api/v1/board-invites/accept' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.token, 'token123');
      return Response.json({ status: 'Success', data: { boardId, role: 'editor' } });
    }
    if (parsed.pathname === `/api/v1/boards/${boardId}/session` && options.method === 'POST') {
      return Response.json({ status: 'Success', data: { ticket: 'session-ticket-xyz', expiresAt: '2026-10-26T12:00:30Z' } });
    }
    if (parsed.pathname === `/api/v1/boards/${boardId}/operations` && options.method === 'POST') {
      const body = JSON.parse(options.body);
      return Response.json({ status: 'Success', data: { opId: body.opId, serverSeq: 6, object: { id: body.objectId, revision: 1 } } });
    }
    if (parsed.pathname === `/api/v1/boards/${boardId}/attachments` && options.method === 'POST') {
      assert.ok(options.body instanceof FormData);
      assert.ok(options.headers['Idempotency-Key']);
      return Response.json({ status: 'Success', data: { id: 'att-1', originalName: 'file.txt', mime: 'text/plain', size: 12, sha256: 'a'.repeat(64), downloadUrl: `/api/v1/boards/${boardId}/attachments/att-1` } }, { status: 201 });
    }
    throw new Error(`Unhandled request: ${options.method || 'GET'} ${parsed.pathname}`);
  };

  const user = await getUserInfo();
  assert.equal(user.displayName, 'Алексей');

  const newBoard = await createBoard('Дизайн системы');
  assert.equal(newBoard.id, boardId);
  assert.equal(newBoard.title, 'Дизайн системы');

  const list = await listBoards();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, boardId);

  const board = await getBoard(boardId);
  assert.equal(board.id, boardId);
  assert.equal(board.role, 'owner');

  const invite = await createInvite(boardId);
  assert.ok(invite.url.includes('#invite=token123'));

  const accepted = await acceptInvite('token123');
  assert.equal(accepted.boardId, boardId);
  assert.equal(accepted.role, 'editor');

  const session = await createSessionTicket(boardId);
  assert.equal(session.ticket, 'session-ticket-xyz');

  const opResult = await sendOperation(boardId, {
    opId: 'b1234567-89ab-4cde-8f01-23456789abcd',
    objectId: 'c1234567-89ab-4cde-8f01-23456789abcd',
    action: 'create',
    baseRevision: 0,
    object: { id: 'c1234567-89ab-4cde-8f01-23456789abcd', type: 'sticky', x: 10, y: 10, w: 200, h: 100, text: 'Привет', color: 'mint' }
  });
  assert.equal(opResult.serverSeq, 6);

  const uploadRes = await uploadAttachment(boardId, new Blob(['hello world'], { type: 'text/plain' }));
  assert.equal(uploadRes.id, 'att-1');

  setToken('');
  assert.equal(getAuthToken(), '');
});

test('BoardRealtimeClient handles connection, cursor throttling, selection, stroke preview and events', async () => {
  const boardId = 'd1234567-89ab-4cde-8f01-23456789abcd';
  const receivedMessages = [];
  const statusHistory = [];

  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = MockWebSocket.OPEN;
      this.sent = [];
      MockWebSocket.lastInstance = this;
      setTimeout(() => this.onopen?.(), 5);
    }
    send(data) {
      this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
    }
    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  const client = new BoardRealtimeClient({
    boardId,
    getTicket: async () => 'test-ticket-123',
    onMessage: msg => receivedMessages.push(msg),
    onStatusChange: status => statusHistory.push(status),
    WebSocket: MockWebSocket
  });

  assert.equal(statusHistory[0], 'connecting');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(statusHistory[1], 'open');
  assert.ok(MockWebSocket.lastInstance.url.includes(`events?ticket=test-ticket-123`));

  // Тест сообщений от сервера
  MockWebSocket.lastInstance.onmessage?.({ data: JSON.stringify({ type: 'ready', sessionId: 's1', participants: [] }) });
  MockWebSocket.lastInstance.onmessage?.({ data: JSON.stringify({ type: 'presence.join', participant: { sessionId: 's2', displayName: 'Мария' } }) });
  MockWebSocket.lastInstance.onmessage?.({ data: JSON.stringify({ type: 'cursor', x: 150, y: 250, sessionId: 's2' }) });
  assert.equal(receivedMessages.length, 3);
  assert.equal(receivedMessages[0].type, 'ready');
  assert.equal(receivedMessages[1].participant.displayName, 'Мария');
  assert.equal(receivedMessages[2].x, 150);

  // Тест троттлинга курсора (30 мс)
  client.sendCursor(10, 20);
  assert.deepEqual(MockWebSocket.lastInstance.sent.at(-1), { type: 'cursor', x: 10, y: 20 });
  const countBefore = MockWebSocket.lastInstance.sent.length;

  // Немедленный повторный вызов троттлится
  client.sendCursor(30, 40);
  assert.equal(MockWebSocket.lastInstance.sent.length, countBefore);

  // Ждем истечения таймера троттлинга
  await new Promise(r => setTimeout(r, 45));
  assert.deepEqual(MockWebSocket.lastInstance.sent.at(-1), { type: 'cursor', x: 30, y: 40 });

  // Тест отсечения невалидных координат курсора
  const sentBeforeInvalid = MockWebSocket.lastInstance.sent.length;
  client.sendCursor(Infinity, NaN);
  client.sendCursor(2_000_000, 0);
  assert.equal(MockWebSocket.lastInstance.sent.length, sentBeforeInvalid);

  // Тест безопасной отправки selection
  const validUUID = 'e1234567-89ab-4cde-8f01-23456789abcd';
  client.sendSelection(validUUID);
  assert.deepEqual(MockWebSocket.lastInstance.sent.at(-1), { type: 'selection', objectId: validUUID });

  client.sendSelection(null);
  assert.deepEqual(MockWebSocket.lastInstance.sent.at(-1), { type: 'selection', objectId: null });

  client.sendSelection('invalid-not-uuid');
  assert.deepEqual(MockWebSocket.lastInstance.sent.at(-1), { type: 'selection', objectId: null });

  // Тест среза stroke-preview до 200 точек
  const manyPoints = Array.from({ length: 300 }, (_, i) => [i, i]);
  client.sendStrokePreview(manyPoints);
  const strokeMsg = MockWebSocket.lastInstance.sent.at(-1);
  assert.equal(strokeMsg.type, 'stroke-preview');
  assert.equal(strokeMsg.points.length, 200);

  // Тест корректного закрытия
  client.close();
  assert.equal(client.closed, true);
  assert.equal(statusHistory.at(-1), 'closed');
});
