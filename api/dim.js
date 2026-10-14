// Синхронізація джемів з адмінки у бекенд DIM (GraphQL).
// GET  /api/dim           — довідники бекенду (категорії, локації, викладачі, жанри) + збережені відповідності + стан синхронізації.
// POST /api/dim {action:'map', map}            — зберегти відповідності (категорії, локації, викладачі).
// POST /api/dim {action:'sync', items:[...]}   — створити / оновити / зняти з публікації джеми.
// Доступ — той самий логін/пароль, що й на сторінці.
// Змінні Vercel: EXPORT_KEY (ключ для програмістів, див. api/export.js), DIM_API_URL (необов'язково, за замовчуванням staging).
// Лише для режиму direct: DIM_MODE=direct і DIM_API_TOKEN.

const API = (process.env.DIM_API_URL || 'https://dim-web-staging.up.railway.app/graphql').trim();
const TOKEN_RAW = (process.env.DIM_API_TOKEN || '').trim();
// Режим: 'export' (за замовчуванням) — дані складаються в чергу, програмісти забирають їх через /api/export і публікують самі.
//        'direct' — адмінка сама створює джеми в бекенді (потрібен DIM_API_TOKEN).
const MODE = (process.env.DIM_MODE || 'export').trim().toLowerCase() === 'direct' ? 'direct' : 'export';
const AUTH = TOKEN_RAW ? (/^\w+\s/.test(TOKEN_RAW) ? TOKEN_RAW : `Bearer ${TOKEN_RAW}`) : '';

const envFind = re => { const k = Object.keys(process.env).find(k => re.test(k) && process.env[k]); return k ? process.env[k].trim() : ''; };
const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || envFind(/_REST_API_URL$|REDIS_REST_URL$/);
const R_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || envFind(/_REST_API_TOKEN$|REDIS_REST_TOKEN$/);
const K_MAP = 'dim:dimmap', K_SYNC = 'dim:jamsync', K_EXPORT = 'dim:export';

async function redis(cmd) {
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function basicOk(req) {
  const user = (process.env.BASIC_USER || '').trim(), pass = (process.env.BASIC_PASS || '').trim();
  const [scheme, enc] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !enc || !user) return false;
  const dec = Buffer.from(enc, 'base64').toString('utf8'), i = dec.indexOf(':');
  return dec.slice(0, i).trim() === user && dec.slice(i + 1).trim() === pass;
}

async function gql(query, variables, auth = true) {
  const headers = { 'Content-Type': 'application/json', 'apollo-require-preflight': 'true' };
  if (auth && AUTH) headers.Authorization = AUTH;
  const r = await fetch(API, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
  let j; try { j = await r.json(); } catch { throw new Error(`Бекенд відповів ${r.status}`); }
  if (j.errors && j.errors.length) {
    const m = j.errors.map(e => e.message).join('; ');
    const err = new Error(/unauthor/i.test(m) ? 'Бекенд не прийняв токен (Unauthorized). Перевірте DIM_API_TOKEN.' : m);
    err.auth = /unauthor/i.test(m);
    throw err;
  }
  return j.data;
}
const tryQ = async (q, v, auth) => { try { return await gql(q, v, auth); } catch (e) { return { __error: e.message, __auth: e.auth }; } };

const norm = s => String(s || '').toLowerCase().replace(/[’'`ʼ]/g, '').replace(/\s+/g, ' ').trim();
const words = s => norm(s).split(' ').filter(Boolean).sort().join(' ');
const CITY = { KYIV: 'Київ', LVIV: 'Львів' };

async function loadRef() {
  const ref = { categories: [], locations: [], teachers: [], genres: [], auth: false, errors: [] };
  const [g, l, t, c] = await Promise.all([
    tryQ('{allGenres{id name}}', null, true),
    tryQ('{locations{id name city isHidden}}', null, true),
    tryQ('{allTeachers{id firstName lastName isHidden user{email}}}', null, true),
    tryQ('{jamCategories{id name}}', null, true),
  ]);
  ref.genres = g.allGenres || [];
  if (l.locations) ref.locations = l.locations;
  else { const p = await tryQ('{publicLocations{id name city isHidden}}', null, false); ref.locations = p.publicLocations || []; }
  if (t.allTeachers) ref.teachers = t.allTeachers.map(x => ({ id: x.id, name: `${x.firstName} ${x.lastName}`.trim(), email: (x.user && x.user.email) || '', hidden: x.isHidden }));
  if (!c.jamCategories || !t.allTeachers) {
    // Без токена: категорії й викладачів беремо з публічних джемів
    const cats = {}, tch = {};
    for (let page = 1; page <= 10; page++) {
      const p = await tryQ(`{publicJams(pagination:{page:${page},pageSize:50}){data{category{id name} teachers{id firstName lastName}}}}`, null, false);
      const d = (p.publicJams && p.publicJams.data) || [];
      d.forEach(x => { cats[x.category.id] = x.category.name; x.teachers.forEach(z => { tch[z.id] = `${z.firstName} ${z.lastName}`.trim(); }); });
      if (d.length < 50) break;
    }
    if (!c.jamCategories) ref.categories = Object.entries(cats).map(([id, name]) => ({ id, name }));
    if (!t.allTeachers) ref.teachers = Object.entries(tch).map(([id, name]) => ({ id, name, email: '' }));
  }
  if (c.jamCategories) ref.categories = c.jamCategories;
  ref.auth = !!(t.allTeachers && c.jamCategories);
  [g, l, t, c].forEach(x => { if (x.__error && !ref.errors.includes(x.__error)) ref.errors.push(x.__error); });
  return ref;
}

const CAT_AUTO = { E: /^easy/i, I: /^improv/i, V: /^voice/i, SE: /^special/i, PC: /pro.?cover|^pro/i, OB: /band/i };
function resolve(jam, ref, map, soft) {
  const warn = [];
  const catId = (map.cat && map.cat[jam.type]) || (ref.categories.find(c => CAT_AUTO[jam.type] && CAT_AUTO[jam.type].test(c.name)) || {}).id;
  if (!catId) { if (!soft) throw new Error(`Немає категорії для типу «${jam.typeName || jam.type}» — оберіть її в налаштуваннях «Бекенд DIM».`); warn.push(`немає categoryId для типу «${jam.typeName || jam.type}»`); }
  const city = CITY[jam.city] || jam.city, inCity = ref.locations.filter(l => norm(l.city) === norm(city));
  const locId = (map.loc && map.loc[`${jam.city}|${jam.locName}`]) || (jam.locName && (inCity.find(l => norm(l.name) === norm(jam.locName)) || inCity.find(l => norm(jam.locName).startsWith(norm(l.name))) || {}).id)
    || (map.locDefault && map.locDefault[jam.city]) || (inCity.find(l => !/^\[/.test(l.name)) || inCity[0] || {}).id;
  if (!locId) { if (!soft) throw new Error(`Немає локації для міста ${city} — оберіть її в налаштуваннях «Бекенд DIM».`); warn.push(`немає locationId для міста ${city}`); }
  const teacherIds = [], teachers = [];
  (jam.teachers || []).forEach(t => {
    const id = (map.t && map.t[`${jam.city}:${t.id}`]) || (t.email && (ref.teachers.find(x => norm(x.email) === norm(t.email)) || {}).id) || (ref.teachers.find(x => words(x.name) === words(t.name)) || {}).id;
    teachers.push({ id: id || null, name: t.name, email: t.email || null });
    if (id) { if (!teacherIds.includes(id)) teacherIds.push(id); } else warn.push(`викладача «${t.name}» не знайдено в бекенді`);
  });
  const genreIds = [], genres = [];
  (jam.genres || []).forEach(n => { const g = ref.genres.find(x => norm(x.name) === norm(n)); genres.push({ id: g ? g.id : null, name: n }); if (g) genreIds.push(g.id); else warn.push(`жанру «${n}» немає в бекенді`); });
  const tix = {};
  (jam.tickets || []).forEach(t => { if (t.total > 0) tix[t.instrument] = (tix[t.instrument] || 0) + t.total; });
  return { catId: catId || null, locId: locId || null, teacherIds, genreIds, teachers, genres, tix, warn };
}

// Київський час → UTC ISO
function kyivToUtc(date, time) {
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
  let ts = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    ts += Date.UTC(y, mo - 1, d, h, mi) - shown;
  }
  return new Date(ts).toISOString();
}

const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));


// Запис для черги експорту (формат бекенду; публікацію виконують програмісти)
function exportRecord(item, ref, map, prev) {
  const j = item.jam, r = resolve(j, ref, map, true);
  const start = kyivToUtc(j.date, j.start), end0 = kyivToUtc(j.date, j.end);
  const end = end0 <= start ? new Date(new Date(end0).getTime() + 864e5).toISOString() : end0;
  const details = clean({ topic: j.details.topic || j.shortName, description: j.details.description, spotifyPlaylist: j.details.spotifyPlaylist, youtubeMusicPlaylist: j.details.youtubeMusicPlaylist, materialsUrl: j.details.materialsUrl, mediaUrl: j.details.mediaUrl });
  const at = j.extra || {}, jamId = (prev && prev.jamId) || null;
  return {
    externalId: item.key, action: 'upsert', version: ((prev && prev.version) || 0) + 1, updatedAt: new Date().toISOString(),
    jamId: (prev && prev.jamId) || null,
    createJamInput: { name: j.name, shortName: j.shortName, price: Math.round(j.price || 0), scheduledAt: start, finishTime: end, categoryId: r.catId, locationId: r.locId, showInCatalog: at.showInCatalog !== false, details, ...(at.links && at.links.externalTickets ? { externalTicketsProviderUrl: at.links.externalTickets } : {}) },
    teacherIds: r.teacherIds, genreIds: r.genreIds,
    ticketOptions: Object.entries(r.tix).map(([instrument, total]) => ({ instrument, total })),
    skills: (j.backend && Array.isArray(j.backend.createJamSkill)) ? j.backend.createJamSkill : [],
    backend: j.backend || null,
    source: { type: j.type, typeName: j.typeName, city: CITY[j.city] || j.city, location: j.locName || null, localDate: j.date, localStart: j.start, localEnd: j.end, teachers: r.teachers, genres: r.genres },
    event: { ...at, localDate: j.date, localStart: j.start, localEnd: j.end, city: CITY[j.city] || j.city },
    warnings: r.warn, ack: null,
  };
}

async function pushJam(item, ref, map, prev) {
  const j = item.jam, r = resolve(j, ref, map);
  const start = kyivToUtc(j.date, j.start), end0 = kyivToUtc(j.date, j.end);
  const end = end0 <= start ? new Date(new Date(end0).getTime() + 864e5).toISOString() : end0;
  const details = clean({ topic: j.details.topic || j.shortName, description: j.details.description, spotifyPlaylist: j.details.spotifyPlaylist, youtubeMusicPlaylist: j.details.youtubeMusicPlaylist, materialsUrl: j.details.materialsUrl, mediaUrl: j.details.mediaUrl });
  const base = { name: j.name, shortName: j.shortName, price: Math.round(j.price || 0), scheduledAt: start, finishTime: end, categoryId: r.catId, locationId: r.locId, showInCatalog: true, details };
  let jamId = prev && prev.jamId, created = false, cur = null;
  if (jamId) {
    const q = await tryQ('query($id:String!){jam(id:$id){id teachers{id} genres{id} ticketOptions{id instrument total}}}', { id: jamId });
    cur = q.jam || null;
    if (!cur) { if (q.__auth) throw new Error(q.__error); jamId = null; }
  }
  if (!jamId) {
    const d = await gql('mutation($input:CreateJamInput!){createJam(input:$input){id}}', { input: base });
    jamId = d.createJam.id; created = true; cur = { teachers: [], genres: [], ticketOptions: [] };
  }
  await gql('mutation($input:UpdateJamInput!){updateJam(input:$input){id status}}', { input: { jamId, ...(created ? {} : base), status: 'ACTIVE' } });
  const curT = cur.teachers.map(x => x.id), curG = cur.genres.map(x => x.id);
  for (const id of r.teacherIds.filter(x => !curT.includes(x))) await gql('mutation($j:String!,$t:String!){assignTeacher(jamId:$j,teacherId:$t)}', { j: jamId, t: id });
  for (const id of curT.filter(x => !r.teacherIds.includes(x))) await gql('mutation($j:String!,$t:String!){unassignTeacher(jamId:$j,teacherId:$t)}', { j: jamId, t: id });
  for (const id of r.genreIds.filter(x => !curG.includes(x))) await gql('mutation($j:String!,$g:String!){addGenreToJam(jamId:$j,genreId:$g)}', { j: jamId, g: id });
  for (const id of curG.filter(x => !r.genreIds.includes(x))) await gql('mutation($j:String!,$g:String!){removeGenreFromJam(jamId:$j,genreId:$g)}', { j: jamId, g: id });
  for (const [instrument, total] of Object.entries(r.tix)) {
    const o = cur.ticketOptions.find(x => x.instrument === instrument);
    if (!o) await gql('mutation($input:CreateJamTicketOptionInput!){createJamTicketOption(input:$input){id}}', { input: { jamId, instrument, total } });
    else if (o.total !== total) await gql('mutation($input:UpdateJamTicketOptionInput!){updateJamTicketOption(input:$input){id}}', { input: { optionId: o.id, total } });
  }
  for (const o of cur.ticketOptions.filter(x => !(x.instrument in r.tix))) {
    try { await gql('mutation($id:String!){deleteJamTicketOption(optionId:$id){id}}', { id: o.id }); }
    catch (e) { r.warn.push(`квиток «${o.instrument}» не видалено: ${e.message}`); }
  }
  return { jamId, created, warn: r.warn };
}

export default async function handler(req, res) {
  if (!basicOk(req)) return res.status(401).json({ ok: false, error: 'Потрібен вхід.' });
  const store = !!(R_URL && R_TOKEN);
  const getMap = async () => { if (!store) return {}; try { return JSON.parse((await redis(['GET', K_MAP])) || '{}'); } catch { return {}; } };
  try {
    if (req.method === 'GET') {
      const [ref, map, raw] = await Promise.all([loadRef(), getMap(), store ? redis(['HGETALL', K_SYNC]) : []]);
      const state = {}; for (let i = 0; i < (raw || []).length; i += 2) { try { state[raw[i]] = JSON.parse(raw[i + 1]); } catch {} }
      let exp = { total: 0, waiting: 0, done: 0, errors: [] };
      if (store && MODE === 'export') {
        const e = (await redis(['HGETALL', K_EXPORT])) || [];
        for (let i = 1; i < e.length; i += 2) { try { const x = JSON.parse(e[i]); exp.total++; if (x.ack && x.ack.version === x.version) { if (x.ack.status === 'error') exp.errors.push(`${x.createJamInput && x.createJamInput.name}: ${x.ack.message || 'помилка'}`); else exp.done++; } else exp.waiting++; } catch {} }
      }
      return res.status(200).json({ ok: true, mode: MODE, api: API, token: !!AUTH, store, ref, map, state, exp });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Метод не підтримується.' });
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    if (!store) return res.status(500).json({ ok: false, error: 'Сховище не підключене.' });
    if (b.action === 'map') { await redis(['SET', K_MAP, JSON.stringify(b.map || {})]); return res.status(200).json({ ok: true }); }
    if (b.action === 'sync') {
      const [ref, map] = await Promise.all([loadRef(), getMap()]);
      if (MODE === 'export') {
        const results = [];
        for (const it of (b.items || []).slice(0, 60)) {
          let prev = null; try { prev = JSON.parse((await redis(['HGET', K_EXPORT, it.key])) || 'null'); } catch {}
          try {
            let rec;
            if (it.op === 'push') rec = exportRecord(it, ref, map, prev);
            else if (prev) rec = { ...prev, action: it.op === 'cancel' ? 'cancel' : it.op === 'recall' ? 'recall' : 'unpublish', version: (prev.version || 0) + 1, updatedAt: new Date().toISOString(), ack: null };
            else { results.push({ key: it.key, ok: true, skipped: true }); continue; }
            await redis(['HSET', K_EXPORT, it.key, JSON.stringify(rec)]);
            const st = { hash: it.hash, status: it.op === 'push' ? 'ACTIVE' : it.op === 'cancel' ? 'CANCELLED' : 'DRAFT', at: rec.updatedAt, warn: it.op === 'push' ? rec.warnings : [], jamId: rec.jamId };
            await redis(['HSET', K_SYNC, it.key, JSON.stringify(st)]);
            results.push({ key: it.key, ok: true, ...st });
          } catch (e) { results.push({ key: it.key, ok: false, error: e.message }); }
        }
        return res.status(200).json({ ok: true, mode: MODE, results });
      }
      if (!AUTH) return res.status(400).json({ ok: false, error: 'Не задано DIM_API_TOKEN у Vercel → Environment Variables.' });
      const results = [];
      for (const it of (b.items || []).slice(0, 40)) {
        const prevRaw = await redis(['HGET', K_SYNC, it.key]); let prev = null; try { prev = prevRaw && JSON.parse(prevRaw); } catch {}
        try {
          let rec;
          if (it.op === 'push') { const r = await pushJam(it, ref, map, prev); rec = { jamId: r.jamId, hash: it.hash, status: 'ACTIVE', at: new Date().toISOString(), warn: r.warn }; results.push({ key: it.key, ok: true, created: r.created, ...rec }); }
          else if (prev && prev.jamId) {
            if (it.op === 'cancel') await gql('mutation($input:CancelJamInput!){cancelJam(input:$input){id}}', { input: { jamId: prev.jamId } });
            else await gql('mutation($input:UpdateJamInput!){updateJam(input:$input){id}}', { input: { jamId: prev.jamId, status: 'DRAFT' } });
            rec = { ...prev, hash: it.hash, status: it.op === 'cancel' ? 'CANCELLED' : 'DRAFT', at: new Date().toISOString(), warn: [] };
            results.push({ key: it.key, ok: true, ...rec });
          } else { results.push({ key: it.key, ok: true, skipped: true }); continue; }
          await redis(['HSET', K_SYNC, it.key, JSON.stringify(rec)]);
        } catch (e) { results.push({ key: it.key, ok: false, error: e.message }); }
      }
      return res.status(200).json({ ok: true, results });
    }
    return res.status(400).json({ ok: false, error: 'Невідома дія.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
