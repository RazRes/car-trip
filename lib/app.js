import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mailConfigured, sendMail as defaultSendMail } from './mail.js';

const RO_PHONE_RE = /^(?:\+40|0040|0)(7\d{8}|[23]\d{8})$/;
const STATUSES = ['confirmed', 'maybe', 'cant_come'];
const PHOTO_PREFIX = 'data:image/jpeg;base64,';
const PHOTO_MAX = 600_000;
const NOTES_MAX = 160;
const EMAIL_TAKEN = 'Acest email este deja înscris. Folosește „Recuperează-ți înscrierea” ca să ajungi la el.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_MAX_ATTEMPTS = 5;
const UNIQUE_VIOLATION = '23505';

const hashCode = (id, code) => createHash('sha256').update(`${id}:${code}`).digest('hex');

const normalizePhone = v => v.replace(/[\s.\-()]/g, '');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return req.body;
}

function validate(body, { partialPhoto }) {
  if (!body || typeof body !== 'object') return { error: 'Cerere invalidă.' };
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max + 1) : '');

  const name = str(body.name, 80);
  const car = str(body.car, 80);
  const plate = str(body.plate, 15).toUpperCase();
  const phone = normalizePhone(str(body.phone, 30));
  const notes = str(body.notes, NOTES_MAX) || null;
  const email = str(body.email, 120).toLowerCase();
  const rsvp = body.rsvp_status ?? 'confirmed';

  if (!name || name.length > 80) return { error: 'Nume invalid.' };
  if (car.length > 80) return { error: 'Numele mașinii e prea lung.' };
  if (!plate || plate.length > 15) return { error: 'Număr de înmatriculare invalid.' };
  if (!RO_PHONE_RE.test(phone)) return { error: 'Număr de telefon invalid.' };
  if (!EMAIL_RE.test(email) || email.length > 120) return { error: 'Email invalid.' };
  if (!STATUSES.includes(rsvp)) return { error: 'Status invalid.' };
  if (notes && notes.length > NOTES_MAX) return { error: 'Notițele sunt prea lungi.' };

  let room = body.room_people ?? null;
  if (room !== null) {
    room = Number(room);
    if (!Number.isInteger(room) || room < 1 || room > 20) return { error: 'Număr de persoane invalid.' };
  }

  let photo = body.photo ?? null;
  if (photo !== null) {
    if (typeof photo !== 'string' || !photo.startsWith(PHOTO_PREFIX) || photo.length > PHOTO_MAX) {
      return { error: 'Poză invalidă sau prea mare.' };
    }
  } else if (!partialPhoto) {
    photo = null;
  }

  return { value: { name, car, plate, phone, email, notes, rsvp_status: rsvp, room_people: room, photo } };
}

export function makeHandlers(query, env = process.env, { sendMail = defaultSendMail } = {}) {
  const roomsTotal = Number(env.ROOMS_TOTAL) || 14;
  const isAdmin = req => !!env.ACCESS_CODE && safeEqual(req.headers['x-access-code'], env.ACCESS_CODE);

  function ownerTokens(req) {
    try {
      const parsed = JSON.parse(req.headers['x-owner-tokens'] || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }

  async function roomsFull(excludeId) {
    const rows = await query(
      `select count(*)::int as n from crew_members
       where rsvp_status = 'confirmed' and room_people is not null and id <> $1`,
      [excludeId ?? '00000000-0000-0000-0000-000000000000']
    );
    return rows[0].n >= roomsTotal;
  }

  async function crew(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');

    if (req.method === 'GET') {
      const tokens = ownerTokens(req);
      const admin = isAdmin(req);
      const rows = await query(
        `select id, name, car, plate, phone, email, rsvp_status, room_people, notes, owner_token,
                (photo is not null) as has_photo,
                floor(extract(epoch from updated_at))::float8 as ver
         from crew_members order by created_at desc`
      );
      const list = rows.map(({ owner_token, phone, email, ...row }) => {
        const mine = safeEqual(tokens[row.id], owner_token);
        return { ...row, mine, phone: mine || admin ? phone : null, email: mine ? email : null };
      });
      return send(res, 200, { rooms_total: roomsTotal, crew: list });
    }

    if (req.method === 'POST') {
      const { value, error } = validate(readBody(req), { partialPhoto: false });
      if (error) return send(res, 400, { error });
      if (value.rsvp_status === 'confirmed' && value.room_people && await roomsFull()) {
        return send(res, 409, { error: 'Nu mai sunt camere disponibile.' });
      }
      const token = randomUUID();
      let rows;
      try {
        rows = await query(
          `insert into crew_members (name, car, plate, phone, email, rsvp_status, room_people, notes, photo, owner_token)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
          [value.name, value.car, value.plate, value.phone, value.email, value.rsvp_status, value.room_people,
           value.notes, value.photo, token]
        );
      } catch (err) {
        if (err.code === UNIQUE_VIOLATION) return send(res, 409, { error: EMAIL_TAKEN });
        throw err;
      }
      return send(res, 201, { id: rows[0].id, owner_token: token });
    }

    if (!id) return send(res, 400, { error: 'Lipsește id.' });
    const found = await query('select owner_token from crew_members where id::text = $1', [id]);
    if (!found.length) return send(res, 404, { error: 'Nu există.' });
    const owner = safeEqual(req.headers['x-owner-token'], found[0].owner_token);

    if (req.method === 'PATCH') {
      if (!owner) return send(res, 403, { error: 'Nu poți modifica această înregistrare.' });
      const { value, error } = validate(readBody(req), { partialPhoto: true });
      if (error) return send(res, 400, { error });
      if (value.rsvp_status === 'confirmed' && value.room_people && await roomsFull(id)) {
        return send(res, 409, { error: 'Nu mai sunt camere disponibile.' });
      }
      try {
        await query(
          `update crew_members set name=$2, car=$3, plate=$4, phone=$5, email=$6, rsvp_status=$7, room_people=$8,
                  notes=$9, photo=coalesce($10, photo), code_hash=null, updated_at=now()
           where id::text = $1`,
          [id, value.name, value.car, value.plate, value.phone, value.email, value.rsvp_status,
           value.room_people, value.notes, value.photo]
        );
      } catch (err) {
        if (err.code === UNIQUE_VIOLATION) return send(res, 409, { error: EMAIL_TAKEN });
        throw err;
      }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'DELETE') {
      if (!owner && !isAdmin(req)) return send(res, 403, { error: 'Cod necesar pentru ștergere.' });
      await query('delete from crew_members where id::text = $1', [id]);
      return send(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return send(res, 405, { error: 'Metodă nepermisă.' });
  }

  async function verify(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, { error: 'Metodă nepermisă.' });
    }
    if (!env.ACCESS_CODE) return send(res, 503, { error: 'Codul de acces nu este configurat.' });
    const body = readBody(req) || {};
    const ok = safeEqual(String(body.code ?? '').trim(), env.ACCESS_CODE);
    return send(res, ok ? 200 : 401, ok ? { ok: true } : { error: 'Cod greșit.' });
  }

  // Two steps on one endpoint: {email} sends a code, {email, code} swaps it for the owner token.
  async function recover(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, { error: 'Metodă nepermisă.' });
    }
    if (!mailConfigured(env)) return send(res, 503, { error: 'Trimiterea de emailuri nu este configurată.' });

    const body = readBody(req) || {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Email invalid.' });

    if (body.code === undefined) {
      const rows = await query(
        `select id, (code_sent_at is null or code_sent_at < now() - interval '60 seconds') as can_send
         from crew_members where lower(email) = $1`,
        [email]
      );
      const row = rows[0];
      // Same answer whether or not the email exists, so this can't be used to look people up.
      if (row && row.can_send) {
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        await query(
          `update crew_members set code_hash=$2, code_expires_at=now() + interval '10 minutes',
                  code_attempts=0, code_sent_at=now() where id=$1`,
          [row.id, hashCode(row.id, code)]
        );
        try {
          await sendMail({
            to: email,
            subject: 'Codul tău – Ford ST/RS Grand Finale',
            text: `Codul tău este: ${code}\n\nEste valabil 10 minute. Introdu-l în pagina de înscriere ca să-ți recuperezi înscrierea pe acest dispozitiv.\n\nDacă nu tu ai cerut codul, ignoră mesajul.`
          }, env);
        } catch (err) {
          console.error(err);
          return send(res, 502, { error: 'Nu am putut trimite emailul. Încearcă din nou.' });
        }
      }
      return send(res, 200, { ok: true });
    }

    // Burn one attempt atomically; the row only comes back while the code is still live.
    const rows = await query(
      `update crew_members set code_attempts = code_attempts + 1
       where lower(email) = $1 and code_hash is not null and code_expires_at > now() and code_attempts < $2
       returning id, owner_token, code_hash`,
      [email, CODE_MAX_ATTEMPTS]
    );
    const row = rows[0];
    const code = String(body.code).trim();
    if (!row || !safeEqual(hashCode(row.id, code), row.code_hash)) {
      return send(res, 401, { error: 'Cod greșit sau expirat.' });
    }
    await query('update crew_members set code_hash=null, code_expires_at=null, code_attempts=0 where id=$1', [row.id]);
    return send(res, 200, { id: row.id, owner_token: row.owner_token });
  }

  async function photo(req, res) {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id');
    const rows = id ? await query('select photo from crew_members where id::text = $1', [id]) : [];
    const data = rows[0]?.photo;
    if (!data || !data.startsWith(PHOTO_PREFIX)) {
      res.statusCode = 404;
      return res.end();
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/jpeg');
    // Clients add &v=<updated_at> so a new photo gets a new URL.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(Buffer.from(data.slice(PHOTO_PREFIX.length), 'base64'));
  }

  const guard = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
      console.error(err);
      if (!res.writableEnded) send(res, 500, { error: 'Eroare de server.' });
    }
  };

  return { crew: guard(crew), verify: guard(verify), recover: guard(recover), photo: guard(photo) };
}
