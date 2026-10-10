// Захист сторінки паролем (Basic Auth) для Vercel.
// Логін і пароль: Vercel → Settings → Environment Variables → BASIC_USER та BASIC_PASS (для Production і Preview).
export const config = { matcher: '/(.*)' };

function decode(b64) {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes); // підтримка кирилиці в логіні/паролі
  } catch (e) { return ''; }
}

export default function middleware(request) {
  // API має власну перевірку доступу (Make — x-api-key, адмінка — логін/пароль)
  if (new URL(request.url).pathname.startsWith('/api/')) return;
  const user = (process.env.BASIC_USER || '').trim();
  const pass = (process.env.BASIC_PASS || '').trim();
  if (!user || !pass) {
    return new Response('Не задано BASIC_USER / BASIC_PASS у Vercel → Environment Variables. Додайте їх і зробіть Redeploy.', {
      status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const auth = request.headers.get('authorization') || '';
  const [scheme, encoded] = auth.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = decode(encoded);
    const i = decoded.indexOf(':');
    if (i > -1 && decoded.slice(0, i).trim() === user && decoded.slice(i + 1).trim() === pass) return; // доступ дозволено
  }
  return new Response('Потрібен вхід', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="DIM Rozklad", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' },
  });
}
