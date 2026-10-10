// API для тем від викладачів.
// POST — приймає дані з Make (заголовок x-api-key = MAKE_SECRET).
// GET  — віддає збережені теми адмінці (той самий логін/пароль, що й на сторінці).
// Сховище: Upstash Redis (Vercel → Storage). Змінні KV_REST_API_URL / KV_REST_API_TOKEN додаються автоматично.

const KEY = 'dim:themes';
// Шукаємо змінні Upstash з будь-яким префіксом (KV_, STORAGE_, UPSTASH_REDIS_ тощо).
const envFind = re => { const k = Object.keys(process.env).find(k => re.test(k) && process.env[k]); return k ? process.env[k].trim() : ''; };
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || envFind(/_REST_API_URL$|REDIS_REST_URL$/);
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || envFind(/_REST_API_TOKEN$|REDIS_REST_TOKEN$/) ;

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function basicOk(req) {
  const user = (process.env.BASIC_USER || '').trim(), pass = (process.env.BASIC_PASS || '').trim();
  const h = req.headers.authorization || '';
  const [scheme, enc] = h.split(' ');
  if (scheme !== 'Basic' || !enc || !user) return false;
  const dec = Buffer.from(enc, 'base64').toString('utf8');
  const i = dec.indexOf(':');
  return dec.slice(0, i).trim() === user && dec.slice(i + 1).trim() === pass;
}

export default async function handler(req, res) {
  if (!URL_ || !TOKEN) return res.status(500).json({ ok: false, error: 'Сховище не підключене (Vercel → Storage → Upstash Redis → Connect, потім Redeploy).', found: Object.keys(process.env).filter(k => /KV|REDIS|UPSTASH|STORAGE/i.test(k)) });

  if (req.method === 'POST') {
    if (!process.env.MAKE_SECRET || req.headers['x-api-key'] !== process.env.MAKE_SECRET)
      return res.status(401).json({ ok: false, error: 'Невірний x-api-key' });
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
    if (!b || !Array.isArray(b.themes) || !b.city || !b.month)
      return res.status(400).json({ ok: false, error: 'Очікую JSON з полями month, city, themes[]' });
    const sub = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      receivedAt: new Date().toISOString(),
      month: String(b.month), city: String(b.city), sentAt: b.sentAt || null, sentBy: b.sentBy || null,
      themes: b.themes.map(t => ({ topic: String(t.topic || ''), type: String(t.type || ''), addedBy: t.addedBy || null })),
    };
    await redis(['RPUSH', KEY, JSON.stringify(sub)]);
    return res.status(200).json({ ok: true, id: sub.id, themes: sub.themes.length });
  }

  if (req.method === 'GET') {
    if (!basicOk(req)) { res.setHeader('WWW-Authenticate', 'Basic realm="DIM Rozklad", charset="UTF-8"'); return res.status(401).json({ ok: false }); }
    const list = (await redis(['LRANGE', KEY, '0', '-1'])) || [];
    return res.status(200).json({ ok: true, submissions: list.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean) });
  }

  if (req.method === 'DELETE') {
    if (!basicOk(req)) return res.status(401).json({ ok: false });
    await redis(['DEL', KEY]);
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ ok: false });
}
