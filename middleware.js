// Захист сторінки паролем (Basic Auth) для Vercel.
// Логін і пароль задаються в Vercel: Settings → Environment Variables → BASIC_USER та BASIC_PASS.
export const config = { matcher: '/(.*)' };

export default function middleware(request) {
  const user = process.env.BASIC_USER;
  const pass = process.env.BASIC_PASS;
  const auth = request.headers.get('authorization') || '';
  const [scheme, encoded] = auth.split(' ');
  if (user && pass && scheme === 'Basic' && encoded) {
    const decoded = atob(encoded);
    const i = decoded.indexOf(':');
    if (decoded.slice(0, i) === user && decoded.slice(i + 1) === pass) return; // доступ дозволено
  }
  return new Response('Потрібен вхід', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="DIM Rozklad", charset="UTF-8"' },
  });
}
