import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { makeHandlers } from '../lib/app.js';

const env = { ACCESS_CODE: 'secret1', ROOMS_TOTAL: '2', SMTP_HOST: 'x', SMTP_USER: 'x', SMTP_PASS: 'x' };
let handlers;
let db;
const outbox = [];
let emailCounter = 0;

before(async () => {
  db = new PGlite();
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await db.exec(schema);
  handlers = makeHandlers(async (text, params) => (await db.query(text, params)).rows, env, {
    sendMail: async msg => { outbox.push(msg); },
  });
});

async function call(handler, method, path, { headers = {}, body } = {}) {
  const req = { method, url: path, headers, body };
  const res = {
    statusCode: 200, headers: {}, chunks: [], writableEnded: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.writableEnded = true; },
  };
  await handler(req, res);
  const raw = Buffer.concat(res.chunks);
  const json = res.headers['content-type']?.includes('json') && raw.length ? JSON.parse(raw) : undefined;
  return { status: res.statusCode, json, raw, headers: res.headers };
}

const person = (over = {}) => ({
  name: 'Ion', car: 'Focus ST', plate: 'b 12 abc', phone: '0722 123 456', email: `User${++emailCounter}@Example.com`,
  rsvp_status: 'confirmed', room_people: null, notes: null, ...over,
});
const create = body => call(handlers.crew, 'POST', '/api/crew', { body });
const list = headers => call(handlers.crew, 'GET', '/api/crew', { headers });

test('verify accepts only the right code', async () => {
  assert.equal((await call(handlers.verify, 'POST', '/api/verify', { body: { code: 'nope' } })).status, 401);
  assert.equal((await call(handlers.verify, 'POST', '/api/verify', { body: { code: ' secret1 ' } })).status, 200);
});

test('create normalizes fields and hides phones/tokens from the public list', async () => {
  const r = await create(person());
  assert.equal(r.status, 201);
  assert.ok(r.json.id && r.json.owner_token);

  const pub = (await list({})).json;
  const row = pub.crew.find(c => c.id === r.json.id);
  assert.equal(row.plate, 'B 12 ABC');
  assert.equal(row.phone, null);
  assert.equal(row.mine, false);
  assert.equal('owner_token' in row, false);
  assert.equal(pub.rooms_total, 2);

  const mine = (await list({ 'x-owner-tokens': JSON.stringify({ [r.json.id]: r.json.owner_token }) })).json;
  const mineRow = mine.crew.find(c => c.id === r.json.id);
  assert.equal(mineRow.mine, true);
  assert.equal(mineRow.phone, '0722123456');

  const admin = (await list({ 'x-access-code': 'secret1' })).json;
  assert.equal(admin.crew.find(c => c.id === r.json.id).phone, '0722123456');
  assert.equal((await list({ 'x-access-code': 'wrong' })).json.crew[0].phone, null);
});

test('validation rejects bad input', async () => {
  assert.equal((await create(person({ phone: '12345' }))).status, 400);
  assert.equal((await create(person({ name: '  ' }))).status, 400);
  assert.equal((await create(person({ rsvp_status: 'x' }))).status, 400);
  assert.equal((await create(person({ room_people: 0 }))).status, 400);
  assert.equal((await create(person({ photo: 'data:text/html;base64,AAAA' }))).status, 400);
});

test('only the owner can edit; owner or admin can delete', async () => {
  const { json: { id, owner_token } } = await create(person({ name: 'Edit Me' }));
  const url = `/api/crew?id=${id}`;
  const patch = (headers, body) => call(handlers.crew, 'PATCH', url, { headers, body });

  assert.equal((await patch({}, person())).status, 403);
  assert.equal((await patch({ 'x-owner-token': 'bad' }, person())).status, 403);
  assert.equal((await patch({ 'x-owner-token': owner_token }, person({ name: 'Edited', rsvp_status: 'maybe' }))).status, 200);
  const row = (await list({})).json.crew.find(c => c.id === id);
  assert.equal(row.name, 'Edited');
  assert.equal(row.rsvp_status, 'maybe');

  const del = headers => call(handlers.crew, 'DELETE', url, { headers });
  assert.equal((await del({})).status, 403);
  assert.equal((await del({ 'x-access-code': 'wrong' })).status, 403);
  assert.equal((await del({ 'x-access-code': 'secret1' })).status, 200);
  assert.equal((await del({ 'x-access-code': 'secret1' })).status, 404);
});

test('owner can delete their own entry', async () => {
  const { json: { id, owner_token } } = await create(person());
  const r = await call(handlers.crew, 'DELETE', `/api/crew?id=${id}`, { headers: { 'x-owner-token': owner_token } });
  assert.equal(r.status, 200);
});

test('photos are served as images and the list only flags them', async () => {
  const jpeg = Buffer.from('fake-jpeg-bytes');
  const photo = 'data:image/jpeg;base64,' + jpeg.toString('base64');
  const { json: { id, owner_token } } = await create(person({ photo }));
  const row = (await list({})).json.crew.find(c => c.id === id);
  assert.equal(row.has_photo, true);
  assert.equal('photo' in row, false);
  assert.equal(typeof row.ver, 'number');

  const img = await call(handlers.photo, 'GET', `/api/photo?id=${id}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/jpeg');
  assert.deepEqual(img.raw, jpeg);

  // Editing without a new photo keeps the old one.
  await call(handlers.crew, 'PATCH', `/api/crew?id=${id}`, { headers: { 'x-owner-token': owner_token }, body: person({ name: 'Same Pic' }) });
  assert.equal((await call(handlers.photo, 'GET', `/api/photo?id=${id}`)).status, 200);
  assert.equal((await call(handlers.photo, 'GET', '/api/photo?id=not-a-uuid')).status, 404);
});

test('room limit is enforced on create and edit', async () => {
  const a = await create(person({ name: 'R1', room_people: 2 }));
  const b = await create(person({ name: 'R2', room_people: 2 }));
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const existingRooms = (await list({})).json.crew.filter(c => c.rsvp_status === 'confirmed' && c.room_people).length;
  assert.equal(existingRooms, 2);

  assert.equal((await create(person({ name: 'R3', room_people: 2 }))).status, 409);
  assert.equal((await create(person({ name: 'R3 no room' }))).status, 201);
  // Someone who already has a room can still edit it.
  const edit = await call(handlers.crew, 'PATCH', `/api/crew?id=${a.json.id}`, { headers: { 'x-owner-token': a.json.owner_token }, body: person({ name: 'R1', room_people: 3 }) });
  assert.equal(edit.status, 200);
});

test('email is required, normalized, unique, and only visible to its owner', async () => {
  assert.equal((await create(person({ email: 'nope' }))).status, 400);
  assert.equal((await create(person({ email: '' }))).status, 400);

  const a = await create(person({ email: '  Dup@Example.COM ' }));
  assert.equal(a.status, 201);
  assert.equal((await create(person({ email: 'dup@example.com' }))).status, 409);

  const pub = (await list({ 'x-access-code': 'secret1' })).json.crew.find(c => c.id === a.json.id);
  assert.equal(pub.email, null);
  const own = (await list({ 'x-owner-tokens': JSON.stringify({ [a.json.id]: a.json.owner_token }) })).json.crew.find(c => c.id === a.json.id);
  assert.equal(own.email, 'dup@example.com');

  // changing to someone else's email on edit is also rejected
  const b = await create(person());
  const clash = await call(handlers.crew, 'PATCH', `/api/crew?id=${b.json.id}`, { headers: { 'x-owner-token': b.json.owner_token }, body: person({ email: 'dup@example.com' }) });
  assert.equal(clash.status, 409);
});

const recover = body => call(handlers.recover, 'POST', '/api/recover', { body });
const lastCode = () => outbox.at(-1).text.match(/\b(\d{6})\b/)[1];

test('recover: emailed code swaps for the owner token', async () => {
  const a = await create(person({ email: 'rec@example.com' }));
  outbox.length = 0;

  const req = await recover({ email: 'REC@example.com' });
  assert.equal(req.status, 200);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, 'rec@example.com');

  assert.equal((await recover({ email: 'rec@example.com', code: '000000' })).status, 401);
  const ok = await recover({ email: 'rec@example.com', code: lastCode() });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.id, a.json.id);
  assert.equal(ok.json.owner_token, a.json.owner_token);

  // the code is single-use
  assert.equal((await recover({ email: 'rec@example.com', code: lastCode() })).status, 401);
});

test('recover: unknown email looks identical and sends nothing', async () => {
  outbox.length = 0;
  const r = await recover({ email: 'ghost@example.com' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(outbox.length, 0);
  assert.equal((await recover({ email: 'ghost@example.com', code: '123456' })).status, 401);
});

test('recover: resend is throttled, attempts are limited, codes expire', async () => {
  await create(person({ email: 'lim@example.com' }));
  outbox.length = 0;
  await recover({ email: 'lim@example.com' });
  await recover({ email: 'lim@example.com' });
  assert.equal(outbox.length, 1, 'second request within a minute sends nothing');

  const good = lastCode();
  for (let i = 0; i < 5; i++) assert.equal((await recover({ email: 'lim@example.com', code: '999999' })).status, 401);
  assert.equal((await recover({ email: 'lim@example.com', code: good })).status, 401, 'locked after 5 wrong tries even with the right code');

  await db.query(`update crew_members set code_sent_at = now() - interval '2 minutes' where lower(email) = 'lim@example.com'`);
  await recover({ email: 'lim@example.com' });
  assert.equal(outbox.length, 2);
  await db.query(`update crew_members set code_expires_at = now() - interval '1 second' where lower(email) = 'lim@example.com'`);
  assert.equal((await recover({ email: 'lim@example.com', code: lastCode() })).status, 401, 'expired');
});

test('recover reports missing mail config', async () => {
  const bare = makeHandlers(async () => [], { ACCESS_CODE: 'x' });
  const r = await call(bare.recover, 'POST', '/api/recover', { body: { email: 'a@b.co' } });
  assert.equal(r.status, 503);
});
