// Створення папки на Google Drive через Make.
// Адмінка надсилає сюди POST з даними події, функція передає їх у вебхук Make
// і чекає відповідь з посиланням на папку: { "url": "https://drive.google.com/..." }.
// Змінна Vercel: MAKE_DRIVE_WEBHOOK — адреса вебхука сценарію Make.
// Доступ — той самий логін/пароль, що й на сторінці.

function basicOk(req) {
  const user = (process.env.BASIC_USER || '').trim(), pass = (process.env.BASIC_PASS || '').trim();
  const [scheme, enc] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !enc || !user) return false;
  const dec = Buffer.from(enc, 'base64').toString('utf8'), i = dec.indexOf(':');
  return dec.slice(0, i).trim() === user && dec.slice(i + 1).trim() === pass;
}

export default async function handler(req, res) {
  if (!basicOk(req)) return res.status(401).json({ ok: false, error: 'Потрібен вхід.' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Метод не підтримується.' });
  const hook = (process.env.MAKE_DRIVE_WEBHOOK || '').trim();
  if (!hook) return res.status(500).json({ ok: false, error: 'Не задано MAKE_DRIVE_WEBHOOK у Vercel → Environment Variables' });
  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  if (!b || !['materials', 'media'].includes(b.kind)) return res.status(400).json({ ok: false, error: 'Потрібен kind: materials або media' });
  try {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 40000);
    const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b), signal: ctrl.signal });
    clearTimeout(t);
    const text = await r.text();
    let url = '';
    try { const j = JSON.parse(text); url = j.url || j.link || j.webViewLink || ''; } catch { url = text.trim(); }
    if (!/^https:\/\/(drive|docs)\.google\.com\//.test(url)) {
      return res.status(502).json({ ok: false, error: r.ok ? 'Make не повернув посилання на папку (потрібен модуль Webhook response з {"url": ...})' : `Make відповів ${r.status}` });
    }
    return res.status(200).json({ ok: true, url });
  } catch (e) {
    return res.status(504).json({ ok: false, error: e.name === 'AbortError' ? 'Make не відповів за 40 секунд' : String(e.message || e) });
  }
}
