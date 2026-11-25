// Meta Conversions API (серверные события) для лендинга.
// Браузер шлёт сюда те же события, что и пиксель, с тем же event_id —
// Meta склеивает их (дедупликация), а мы получаем события даже при блокировщиках рекламы и iOS.
//
// Переменные окружения в Netlify (Project configuration → Environment variables):
//   META_CAPI_TOKEN       — обязательно, токен из Events Manager → пиксель → Настройки → Conversions API
//   META_TEST_EVENT_CODE  — необязательно, код TEST12345 из вкладки «Тестовые события» (на время проверки)
//   META_PIXEL_ID         — необязательно, по умолчанию 4194705274189334
//   META_API_VERSION      — необязательно, по умолчанию v23.0

import { createHash } from 'node:crypto';

const ALLOWED_EVENTS = new Set([
  'PageView', 'ViewContent', 'Lead', 'Contact', 'CustomizeProduct', 'FindLocation',
  'SwitchFormat', 'TelegramClick', 'InstagramClick', 'Engaged30s', 'QuizStart',
]);

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

function cleanCustomData(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input).slice(0, 10)) {
    if (!/^[a-z_]{1,40}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 100);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined);

export default async (req, context) => {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method' });

  // Принимаем события только со своего сайта
  const origin = req.headers.get('origin');
  const siteOrigins = [process.env.URL, process.env.DEPLOY_PRIME_URL]
    .filter(Boolean)
    .map((u) => new URL(u).origin);
  if (origin && siteOrigins.length && !siteOrigins.includes(origin)) return json(403, { ok: false, error: 'origin' });

  const token = process.env.META_CAPI_TOKEN;
  if (!token) return json(503, { ok: false, error: 'META_CAPI_TOKEN is not set' });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'json' });
  }

  const eventName = body && body.event_name;
  if (!ALLOWED_EVENTS.has(eventName)) return json(400, { ok: false, error: 'event_name' });
  const eventId = str(body.event_id, 100);
  if (!eventId) return json(400, { ok: false, error: 'event_id' });

  const userData = {
    client_ip_address: context.ip || req.headers.get('x-nf-client-connection-ip') || undefined,
    client_user_agent: req.headers.get('user-agent') || undefined,
    fbp: str(body.fbp, 200),
    fbc: str(body.fbc, 500),
  };
  // Телефон и имя из формы — только в виде SHA-256 хеша (так требует Meta)
  const phone = typeof body.ph === 'string' ? body.ph.replace(/\D/g, '') : '';
  if (phone.length >= 7 && phone.length <= 15) userData.ph = [sha256(phone)];
  const name = typeof body.fn === 'string' ? body.fn.trim().toLowerCase().split(/\s+/)[0] : '';
  if (name && name.length <= 60) userData.fn = [sha256(name)];
  for (const k of Object.keys(userData)) if (userData[k] === undefined) delete userData[k];

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      event_source_url: str(body.event_source_url, 1000),
      user_data: userData,
      custom_data: cleanCustomData(body.custom_data),
    }],
    access_token: token,
  };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  const pixelId = process.env.META_PIXEL_ID || '4194705274189334';
  const version = process.env.META_API_VERSION || 'v23.0';

  try {
    const res = await fetch(`https://graph.facebook.com/${version}/${pixelId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('CAPI error', res.status, JSON.stringify(out.error || out));
      return json(502, { ok: false, error: (out.error && out.error.message) || 'meta' });
    }
    return json(200, { ok: true, events_received: out.events_received });
  } catch (e) {
    console.error('CAPI fetch failed', e && e.message);
    return json(502, { ok: false, error: 'fetch' });
  }
};
