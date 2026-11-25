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

// ---- Проверка ответов (та же логика, что в форме на сайте) ----
const OPTIONS = {
  people: ['10–20 человек', '20–40 человек', '40–60 человек'],
  when: ['В этом месяце', 'В следующем месяце', 'Пока выбираем дату'],
  channel: ['Telegram', 'WhatsApp', 'Звонок'],
  game: ['CS2', 'Dota', 'FC'],
};
// Мобильные коды: Польша (+48) и Украина (+380)
const PL = ['45', '50', '51', '53', '57', '60', '66', '69', '72', '73', '78', '79', '88'];
const UA = ['39', '50', '63', '66', '67', '68', '73', '89', '91', '92', '93', '94', '95', '96', '97', '98', '99'];

export function normPhone(s) {
  const raw = String(s || '').trim();
  if (!/^[+\d\s().-]{9,22}$/.test(raw)) return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  let cc, n;
  if (d.length === 11 && d.startsWith('48')) { cc = '48'; n = d.slice(2); }
  else if (d.length === 12 && d.startsWith('380')) { cc = '380'; n = d.slice(3); }
  else if (d.length === 10 && d[0] === '0') { cc = '380'; n = d.slice(1); }
  else if (d.length === 9 && PL.includes(d.slice(0, 2))) { cc = '48'; n = d; }
  else return null;
  if (!(cc === '48' ? PL : UA).includes(n.slice(0, 2))) return null;
  if (/(\d)\1{5,}/.test(n)) return null;
  return cc === '48'
    ? `+48 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`
    : `+380 ${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5, 7)} ${n.slice(7)}`;
}

export function normTelegram(s) {
  const v = String(s || '').trim().replace(/^(https?:\/\/)?(t\.me|telegram\.me)\//i, '').replace(/^@/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/.test(v)) return null;
  if (/^(test|admin|username|user|nick|telegram|asdf|qwer)/i.test(v) || /(fuck|shit|dick|bitch|cunt|kurw|chuj|huy|hui|pizd|blya|suka)/i.test(v)) return null;
  return '@' + v;
}

const L = "A-Za-zÀ-žА-Яа-яЁёІіЇїЄєҐґ";
const NAME_RE = new RegExp(`^[${L}]+(?:[ '’-][${L}]+)*$`);
const BAD_NAME = /^(?:test|тест|нет|no|name|имя|аноним|anon|user|admin|asd.*|qwe.*|zxc.*|йцу.*|фыв.*|ячс.*)$/i;
const SWEAR = /(х[уy][йияеёю]|пизд|бля|[её]бал|[её]бан|еблан|сук[аи]$|залуп|fuck|shit|bitch|cunt|kurw|chuj)/i;
export function normName(s) {
  const v = String(s || '').trim().replace(/\s+/g, ' ');
  if (v.length < 2 || v.length > 40) return null;
  if (!NAME_RE.test(v)) return null;
  if (/(.)\1\1/i.test(v)) return null; // ааа, xxx
  if (!/[aeiouyąęóаеёиоуыэюяіїє]/i.test(v)) return null; // нет ни одной гласной — набор букв
  if (BAD_NAME.test(v) || SWEAR.test(v)) return null;
  return v;
}

// Контакт: для Telegram — ник или номер, для WhatsApp/звонка — только номер
export function normContact(channel, s) {
  const phone = normPhone(s);
  if (phone) return { contact: phone, type: 'phone' };
  if (channel === 'Telegram') {
    const tg = normTelegram(s);
    if (tg) return { contact: tg, type: 'telegram' };
  }
  return null;
}

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
    lead.contactType === 'telegram'
      ? `✉️ Telegram: <a href="https://t.me/${esc(lead.contact.slice(1))}">${esc(lead.contact)}</a>`
      : `📱 Телефон: <b>${esc(lead.contact)}</b>` +
        (lead.channel === 'WhatsApp' ? ` · <a href="https://wa.me/${lead.contact.replace(/\D/g, '')}">написать в WhatsApp</a>` : ''),
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
  // Все ответы квиза обязательны и только из списка вариантов
  for (const k of Object.keys(OPTIONS)) {
    if (!OPTIONS[k].includes(lead[k])) return json(400, { ok: false, error: 'answers', field: k });
  }
  const name = normName(lead.name);
  if (!name) return json(400, { ok: false, error: 'name' });
  const contact = normContact(lead.channel, lead.contact);
  if (!contact) return json(400, { ok: false, error: 'contact' });
  lead.name = name;
  lead.contact = contact.contact;
  lead.contactType = contact.type;

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
