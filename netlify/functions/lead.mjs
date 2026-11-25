// Заявка с квиза «Тимбилдинг» -> сообщение в Telegram (бот) + строка в Google-таблице.
//
// Переменные окружения в Netlify (Project configuration → Environment variables):
//   TELEGRAM_BOT_TOKEN — токен бота от @BotFather
//   TELEGRAM_CHAT_ID   — id чата/группы, куда падают заявки (бот должен быть добавлен в группу)
//   SHEET_WEBHOOK_URL  — URL веб-приложения Google Apps Script (см. google-apps-script.js)
//   SHEET_SECRET       — та же секретная строка, что в SECRET внутри скрипта
// Достаточно настроить хотя бы один канал (Telegram или таблицу).

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const field = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function sendTelegram(lead, utm) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null; // не настроено

  const text = [
    '🎮 <b>Новая заявка: кибертурнир (тимбилдинг)</b>',
    '',
    `👥 Людей: <b>${esc(lead.people || '—')}</b>`,
    `📅 Когда: <b>${esc(lead.when || '—')}</b>`,
    `🕹 Игра: <b>${esc(lead.game || '—')}</b>`,
    `📞 Связаться через: <b>${esc(lead.channel || '—')}</b>`,
    '',
    `🙋 Имя: <b>${esc(lead.name)}</b>`,
    `✉️ Контакт: <b>${esc(lead.contact)}</b>`,
    utm.line ? '' : null,
    utm.line ? `📊 Реклама: ${esc(utm.line)}` : null,
  ].filter((l) => l !== null).join('\n');

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) {
      console.error('Telegram error', res.status, out.description);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Telegram fetch failed', e && e.message);
    return false;
  }
}

async function sendSheet(lead, utm) {
  const url = process.env.SHEET_WEBHOOK_URL;
  if (!url) return null; // не настроено
  try {
    // Apps Script отвечает редиректом 302 на googleusercontent.com — fetch проходит его сам
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: process.env.SHEET_SECRET || '', ...lead, ...utm.params }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) {
      console.error('Sheet error', res.status, out.error);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Sheet fetch failed', e && e.message);
    return false;
  }
}

export default async (req, context) => {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method' });

  const origin = req.headers.get('origin');
  const siteOrigins = [process.env.URL, process.env.DEPLOY_PRIME_URL].filter(Boolean).map((u) => new URL(u).origin);
  if (origin && siteOrigins.length && !siteOrigins.includes(origin)) return json(403, { ok: false, error: 'origin' });

  let b;
  try {
    b = await req.json();
  } catch {
    return json(400, { ok: false, error: 'json' });
  }
  if (b.website) return json(200, { ok: true }); // ловушка для ботов (скрытое поле)

  const lead = {
    people: field(b.people, 40),
    when: field(b.when, 40),
    channel: field(b.channel, 30),
    game: field(b.game, 20),
    name: field(b.name, 60),
    contact: field(b.contact, 60),
    page: field(b.page, 300),
  };
  const digits = lead.contact.replace(/\D/g, '');
  const isUsername = /^@?[A-Za-z0-9_]{4,32}$/.test(lead.contact);
  if (!lead.name || !(digits.length >= 7 || isUsername)) return json(400, { ok: false, error: 'contact' });

  const utm = { params: { utm_source: '', utm_campaign: '', utm_content: '' }, line: '' };
  try {
    const p = new URL(lead.page).searchParams;
    for (const k of Object.keys(utm.params)) utm.params[k] = (p.get(k) || '').slice(0, 100);
    utm.line = Object.values(utm.params).filter(Boolean).join(' / ');
  } catch {}

  const [tg, sheet] = await Promise.all([sendTelegram(lead, utm), sendSheet(lead, utm)]);
  if (tg === null && sheet === null) return json(503, { ok: false, error: 'not configured' });
  if (tg || sheet) return json(200, { ok: true, telegram: tg, sheet });
  return json(502, { ok: false, error: 'delivery' });
};
