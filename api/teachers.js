// API для email викладачів (зберігаються в тому ж Upstash Redis).
// GET  — віддає всі email: { "KYIV:oa": "teacher@example.com", ... }
// POST — { city, id, email } зберігає email (порожній email — видаляє).
// Доступ — той самий логін/пароль, що й на сторінці.

const KEY = 'dim:temails';
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
  if (!basicOk(req)) return res.status(401).json({ ok: false, error: 'Потрібен вхід.' });
  try {
    if (req.method === 'GET') {
      const arr = (await redis(['HGETALL', KEY])) || [];
      const emails = {};
      for (let i = 0; i < arr.length; i += 2) emails[arr[i]] = arr[i + 1];
      return res.status(200).json({ ok: true, emails });
    }
    if (req.method === 'POST') {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
      const city = String(b?.city || '').trim(), id = String(b?.id || '').trim(), email = String(b?.email || '').trim().toLowerCase();
      if (!/^[A-Z]+$/.test(city) || !/^[\w-]+$/.test(id)) return res.status(400).json({ ok: false, error: 'Потрібні city і id.' });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Некоректний email.' });
      if (email) await redis(['HSET', KEY, `${city}:${id}`, email]);
      else await redis(['HDEL', KEY, `${city}:${id}`]);
      return res.status(200).json({ ok: true });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Метод не підтримується.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
