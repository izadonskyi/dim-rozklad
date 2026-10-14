// Черга джемів для програмістів (бекенд DIM забирає дані звідси й сам публікує).
// Доступ: заголовок x-api-key = EXPORT_KEY (змінна у Vercel).
//
// GET  /api/export                 — усі записи
// GET  /api/export?pending=1       — лише ті, що ще не підтверджені (нові або змінені)
// GET  /api/export?since=ISO-дата  — змінені після дати
// POST /api/export                 — підтвердження обробки:
//      { "externalId": "...", "version": 3, "status": "done" | "error", "jamId": "uuid-у-бекенді", "message": "текст помилки" }
//      (можна масивом: [{...}, {...}])
// Опис формату — у файлі EXPORT_API.md.

const envFind = re => { const k = Object.keys(process.env).find(k => re.test(k) && process.env[k]); return k ? process.env[k].trim() : ''; };
const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || envFind(/_REST_API_URL$|REDIS_REST_URL$/);
const R_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || envFind(/_REST_API_TOKEN$|REDIS_REST_TOKEN$/);
const K_EXPORT = 'dim:export', K_SYNC = 'dim:jamsync';

async function redis(cmd) {
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

export default async function handler(req, res) {
  const key = (process.env.EXPORT_KEY || '').trim(), got = String(req.headers['x-api-key'] || '').trim();
  if (!key) return res.status(500).json({ ok: false, error: 'Не задано EXPORT_KEY у Vercel → Environment Variables.' });
  if (got !== key) return res.status(401).json({ ok: false, error: 'Невірний x-api-key' });
  if (!R_URL || !R_TOKEN) return res.status(500).json({ ok: false, error: 'Сховище не підключене.' });
  try {
    if (req.method === 'GET') {
      const raw = (await redis(['HGETALL', K_EXPORT])) || [];
      let items = [];
      for (let i = 1; i < raw.length; i += 2) { try { items.push(JSON.parse(raw[i])); } catch {} }
      const q = req.query || {};
      if (q.pending) items = items.filter(x => !x.ack || x.ack.version !== x.version);
      if (q.since) items = items.filter(x => x.updatedAt > String(q.since));
      items.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
      return res.status(200).json({ ok: true, count: items.length, items });
    }
    if (req.method === 'POST') {
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
      const list = Array.isArray(b) ? b : [b];
      const out = [];
      for (const a of list) {
        if (!a || !a.externalId) { out.push({ ok: false, error: 'Потрібен externalId' }); continue; }
        const rec = JSON.parse((await redis(['HGET', K_EXPORT, a.externalId])) || 'null');
        if (!rec) { out.push({ externalId: a.externalId, ok: false, error: 'Запис не знайдено' }); continue; }
        rec.ack = { version: a.version ?? rec.version, status: a.status === 'error' ? 'error' : 'done', message: a.message || null, at: new Date().toISOString() };
        if (a.jamId) rec.jamId = a.jamId;
        await redis(['HSET', K_EXPORT, a.externalId, JSON.stringify(rec)]);
        const s = JSON.parse((await redis(['HGET', K_SYNC, a.externalId])) || 'null');
        if (s) { s.jamId = rec.jamId; s.ack = rec.ack; await redis(['HSET', K_SYNC, a.externalId, JSON.stringify(s)]); }
        out.push({ externalId: a.externalId, ok: true });
      }
      return res.status(200).json({ ok: true, results: out });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Метод не підтримується.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
