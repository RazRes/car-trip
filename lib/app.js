import { randomUUID, timingSafeEqual } from 'node:crypto';

const RO_PHONE_RE = /^(?:\+40|0040|0)(7\d{8}|[23]\d{8})$/;
const STATUSES = ['confirmed', 'maybe', 'cant_come'];
const PHOTO_PREFIX = 'data:image/jpeg;base64,';
const PHOTO_MAX = 600_000;
const NOTES_MAX = 160;
const EMAIL_TAKEN = 'Acest email este deja înscris. Folosește „Recuperează-ți înscrierea” ca să ajungi la el.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNIQUE_VIOLATION = '23505';
const LOCATION_FRESH = '10 minutes';   // positions older than this are not shown
const LOCATION_KEEP = '24 hours';      // and are deleted after this
const STOPS = ['start', 'sarata', 'magura', 'siriu', 'brasov', 'cheia', 'zeletin'];   // route stops that can be checked in at


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

export function makeHandlers(query, env = process.env) {
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
                  notes=$9, photo=coalesce($10, photo), updated_at=now()
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

  // No code or password: knowing the signup email is enough to get the entry back on a new device.
  async function recover(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, { error: 'Metodă nepermisă.' });
    }
    const body = readBody(req) || {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Email invalid.' });
    const rows = await query('select id, owner_token from crew_members where lower(email) = $1', [email]);
    if (!rows.length) return send(res, 404, { error: 'Nu am găsit nicio înscriere cu acest email.' });
    return send(res, 200, { id: rows[0].id, owner_token: rows[0].owner_token });
  }

  // Live map. Only people with a registered entry (or the access code) may look; only an
  // entry's owner may publish its position, and only its latest position is kept.
  async function isViewer(req) {
    if (isAdmin(req)) return true;
    const tokens = ownerTokens(req);
    const ids = Object.keys(tokens).slice(0, 20);
    if (!ids.length) return false;
    const rows = await query('select id, owner_token from crew_members where id::text = any($1::text[])', [ids]);
    return rows.some(r => safeEqual(tokens[r.id], r.owner_token));
  }

  const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);

  async function location(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');

    if (req.method === 'GET') {
      if (!(await isViewer(req))) return send(res, 403, { error: 'Harta este vizibilă doar participanților înscriși.' });
      const tokens = ownerTokens(req);
      const rows = await query(
        `select l.entry_id as id, c.name, c.car, c.plate, c.owner_token, l.lat, l.lng, l.accuracy, l.heading, l.speed,
                extract(epoch from (now() - l.updated_at))::float8 as age
         from locations l join crew_members c on c.id = l.entry_id
         where l.updated_at > now() - interval '${LOCATION_FRESH}'
         order by l.updated_at desc`
      );
      return send(res, 200, {
        locations: rows.map(({ owner_token, ...r }) => ({ ...r, mine: safeEqual(tokens[r.id], owner_token) }))
      });
    }

    if (!id) return send(res, 400, { error: 'Lipsește id.' });
    const found = await query('select owner_token from crew_members where id::text = $1', [id]);
    if (!found.length) return send(res, 404, { error: 'Nu există.' });
    if (!safeEqual(req.headers['x-owner-token'], found[0].owner_token)) {
      return send(res, 403, { error: 'Nu poți modifica această locație.' });
    }

    if (req.method === 'POST') {
      const b = readBody(req) || {};
      const lat = num(b.lat, -90, 90);
      const lng = num(b.lng, -180, 180);
      if (lat === null || lng === null) return send(res, 400, { error: 'Coordonate invalide.' });
      const accuracy = num(b.accuracy, 0, 100000);
      const heading = num(b.heading, 0, 360);
      const speed = num(b.speed, 0, 400);
      // The WHERE keeps a flood of updates from rewriting the row more than every few seconds.
      await query(
        `insert into locations (entry_id, lat, lng, accuracy, heading, speed, updated_at)
         values ($1::uuid, $2, $3, $4, $5, $6, now())
         on conflict (entry_id) do update
           set lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy,
               heading = excluded.heading, speed = excluded.speed, updated_at = now()
           where locations.updated_at < now() - interval '4 seconds'`,
        [id, lat, lng, accuracy, heading, speed]
      );
      await query(`delete from locations where updated_at < now() - interval '${LOCATION_KEEP}'`);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'DELETE') {
      await query('delete from locations where entry_id = $1::uuid', [id]);
      return send(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return send(res, 405, { error: 'Metodă nepermisă.' });
  }

  // Check-ins: an owner taps "I arrived" at a stop. Nothing about where they are is stored, only
  // which stop and when. Same visibility rule as the map.
  async function checkin(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');

    if (req.method === 'GET') {
      if (!(await isViewer(req))) return send(res, 403, { error: 'Vezi sosirile doar dacă ești înscris.' });
      const tokens = ownerTokens(req);
      const rows = await query(
        `select k.entry_id as id, k.stop, c.name, c.car, c.owner_token,
                floor(extract(epoch from k.created_at) * 1000)::float8 as at
         from checkins k join crew_members c on c.id = k.entry_id
         order by k.created_at`
      );
      return send(res, 200, {
        checkins: rows.map(({ owner_token, ...r }) => ({ ...r, mine: safeEqual(tokens[r.id], owner_token) }))
      });
    }

    if (!id) return send(res, 400, { error: 'Lipsește id.' });
    const found = await query('select owner_token from crew_members where id::text = $1', [id]);
    if (!found.length) return send(res, 404, { error: 'Nu există.' });
    if (!safeEqual(req.headers['x-owner-token'], found[0].owner_token)) {
      return send(res, 403, { error: 'Nu poți modifica această sosire.' });
    }

    if (req.method === 'POST') {
      const stop = (readBody(req) || {}).stop;
      if (!STOPS.includes(stop)) return send(res, 400, { error: 'Oprire necunoscută.' });
      await query(
        `insert into checkins (entry_id, stop) values ($1::uuid, $2) on conflict (entry_id, stop) do nothing`,
        [id, stop]
      );
      return send(res, 200, { ok: true });
    }

    if (req.method === 'DELETE') {
      const stop = url.searchParams.get('stop');
      if (!STOPS.includes(stop)) return send(res, 400, { error: 'Oprire necunoscută.' });
      await query('delete from checkins where entry_id = $1::uuid and stop = $2', [id, stop]);
      return send(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return send(res, 405, { error: 'Metodă nepermisă.' });
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

  return { crew: guard(crew), verify: guard(verify), recover: guard(recover), location: guard(location), checkin: guard(checkin), photo: guard(photo) };
}
