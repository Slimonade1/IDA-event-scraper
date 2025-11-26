// ida-watch-email.mjs
// Node 18+ (global fetch)
// Overvåger IDA-arrangementer i København og sender e-mail ved nye events.
// Enkel e-mail: kun liste med titel + link (ingen tabel, pris osv.)

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';

// ======= KONFIGURATION =======
const SEARCH_ENDPOINT = 'https://api.cludo.com/api/v3/2677/12845/search';
const AUTH_HEADER = process.env.IDA_AUTH ?? ''; // fx: "SiteKey <din nøgle>"
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 10 * 60 * 1000); // default 10 min
const PER_PAGE = Number(process.env.PER_PAGE ?? 50);
const STATE_FILE = path.join(process.cwd(), 'seen.json');
const SKIP_PAST_EVENTS = (process.env.SKIP_PAST_EVENTS ?? 'false').toLowerCase() === 'true'; // default: false for at undgå afhængighed af dato-parsing

// SMTP-konfig
const SMTP_HOST = process.env.SMTP_HOST ?? '';
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
const SMTP_SECURE = (process.env.SMTP_SECURE ?? 'false').toLowerCase() === 'true'; // true = 465
const SMTP_USER = process.env.SMTP_USER ?? '';
const SMTP_PASS = process.env.SMTP_PASS ?? '';
const MAIL_FROM = process.env.MAIL_FROM ?? SMTP_USER ?? '';
const MAIL_TO = process.env.MAIL_TO ?? ''; // en eller flere, komma-separeret

// ======= VALIDERING =======
function requireEnv(name, value) {
  if (!value) throw new Error(`Manglende env: ${name}`);
}
requireEnv('IDA_AUTH', AUTH_HEADER);
requireEnv('SMTP_HOST', SMTP_HOST);
requireEnv('SMTP_USER', SMTP_USER);
requireEnv('SMTP_PASS', SMTP_PASS);
requireEnv('MAIL_FROM', MAIL_FROM);
requireEnv('MAIL_TO', MAIL_TO);

// ======= HJÆLPEFUNKTIONER =======
function canonicalUrl(u) {
  try {
    const url = new URL(u);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return u;
  }
}

function stripTags(s) {
  return (s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Brug præcis den regex som efterspurgt (for at undgå syntaksfejl)
const reNum = /\b(\d{1,2}).\-\/.\-\/\b/;

function toIsoDateFromNumeric(text) {
  // Finder dd.mm.yyyy | dd-mm-yyyy | dd/mm/yyyy
  const m = text.match(reNum);
  if (!m) return '';
  const d = m[1].padStart(2, '0');
  const mo = m[2].padStart(2, '0');
  let y = m[3];
  if (y.length === 2) y = `20${y}`;
  return `${y}-${mo}-${d}`;
}

function extractDateAndTime(contextText) {
  const clean = stripTags(contextText);
  const dateIso = toIsoDateFromNumeric(clean);
  // Tid "kl. 19:00" eller "kl 19.00"
  const timeMatch = clean.match(/\bkl\.?\s*([0-2]?\d[:.]\d{2})\b/i);
  const timeText = timeMatch ? timeMatch[1].replace('.', ':') : '';
  return { date: dateIso, time: timeText };
}

function extractEventsFromHtml(html) {
  const events = [];
  const anchorRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1];
    const inner = match[2];
    const isEventLink =
      /\/event\//i.test(href) ||
      /\/arrangementer-og-kurser\/arrangementer\//i.test(href);
    if (!isEventLink) continue;

    const title = stripTags(inner);
    const absolute =
      href.startsWith('http')
        ? href
        : href.startsWith('/')
        ? `https://ida.dk${href}`
        : `https://ida.dk/${href}`;

    // Tag lidt kontekst efter linket for at fange dato/tid
    const start = anchorRegex.lastIndex;
    const end = Math.min(html.length, start + 800);
    const contextAfter = html.slice(start, end);
    const { date, time } = extractDateAndTime(contextAfter);

    events.push({
      city: 'København',              // hardcoded som ønsket
      title,
      date,
      time,
      link: canonicalUrl(absolute),
    });
  }

  // Dedup på link
  const seen = new Set();
  return events.filter(e => {
    if (seen.has(e.link)) return false;
    seen.add(e.link);
    return true;
  });
}

// ======= API & POLLING =======
function makeBody(page = 1, perPage = PER_PAGE) {
  return {
    ResponseType: 'JsonHtml',
    Template: 'SearchContent',
    facets: {
      Category: ['Arrangementer'],
      CourseCategory: [],
      AdditionalType: [], // alle typer
      City: ['København'], // KUN København via facet
      Organizer: [],
      CourseLanguage: [],
      RelevantFor: [],
      date: [],
      range: [],
      Status: ['Afholdes', 'Venteliste'],
    },
    filters: {},
    page,
    query: '*',
    text: '',
    traits: [],
    sort: {
      StartDate_date: 'asc',
      DatePublished_date: 'asc',
    },
    rangeFacets: {},
    perPage,
    enableRelatedSearches: false,
    applyMultiLevelFacets: true,
    topHitsFields: [{ field: 'TopHits', maxFieldValues: 10 }],
  };
}

// fetch med timeout + simple retries
async function fetchPage(page, perPage, attempts = 3) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: AUTH_HEADER,
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json',
        Origin: 'https://ida.dk',
        Referer: 'https://ida.dk/soeg',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (IDA-events-watcher-email)',
      },
      body: JSON.stringify(makeBody(page, perPage)),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);

    // Nogle svar bruger SearchResult, andre SearchResultHtml
    const rawHtml = data.SearchResult ?? data.SearchResultHtml ?? '';
    const events = extractEventsFromHtml(rawHtml);
    const total = Number(data.TotalDocuments ?? 0);
    return { events, total };
  } catch (err) {
    if (attempts > 1) {
      const backoff = Math.pow(2, 3 - attempts) * 500; // 0.5s, 1s
      await new Promise(r => setTimeout(r, backoff));
      return fetchPage(page, perPage, attempts - 1);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAllPages() {
  const first = await fetchPage(1, PER_PAGE);
  let all = [...first.events];
  const total = first.total;
  const pages = total > 0 ? Math.ceil(total / PER_PAGE) : 1;

  console.log(`TotalDocuments: ${total}, pages: ${pages}, perPage: ${PER_PAGE}, firstPageEvents: ${first.events.length}`);

  for (let p = 2; p <= pages; p++) {
    const { events } = await fetchPage(p, PER_PAGE);
    const existing = new Set(all.map(e => e.link));
    const newOnPage = events.filter(e => !existing.has(e.link));
    console.log(`Page ${p}: fetched ${events.length}, new after dedup: ${newOnPage.length}`);
    all.push(...newOnPage);
  }

  // Ingen post-filtering på city (facet allerede begrænser til København)
  // Valgfrit: skip fortid (afhænger af om dato blev fundet)
  if (SKIP_PAST_EVENTS) {
    const today = new Date().toISOString().slice(0, 10);
    all = all.filter(e => !e.date || e.date >= today);
  }

  return all;
}

// ======= STATE =======
function loadSeen() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const arr = JSON.parse(raw);
      return new Set(arr);
    }
  } catch {}
  return new Set();
}

function saveSeen(seenSet) {
  try {
    const arr = Array.from(seenSet);
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('Kunne ikke gemme state:', err.message);
  }
}

// ======= EMAIL =======
function buildEmailHtml(events) {
  // Enkelt layout: liste med klikbare titler
  const items = events
    .map(e => {
      const title = (e.title ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const link = e.link ?? '';
      return `<li>${link}${title}</a></li>`;
    })
    .join('');

  return `
<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;">
  <p>Der er fundet <strong>${events.length}</strong> IDA-event(s) i København:</p>
  <ul>
    ${items}
  </ul>
  <p style="color:#666;margin-top:16px;">Automatisk besked – ${new Date().toLocaleString('da-DK')}</p>
</div>
  `.trim();
}

function buildEmailText(events) {
  return events.map(e => `• ${e.title ?? ''}\n${e.link ?? ''}`).join('\n\n');
}

function createTransporter() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE, // true = SMTPS/465, false = STARTTLS/587
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function sendEmail(events) {
  const transporter = createTransporter();
  const subjectBase = `IDA events (København)`;
  const subject =
    events.length === 1
      ? `${subjectBase}: ${events[0].title}`
      : `${subjectBase}: ${events.length} fundet`;

  const info = await transporter.sendMail({
    from: MAIL_FROM,
    to: MAIL_TO, // komma-separeret liste understøttes
    subject,
    html: buildEmailHtml(events),
    text: buildEmailText(events),
  });
  console.log(`📧 E-mail sendt: ${info.messageId} til ${MAIL_TO}`);
}

// ======= WATCH LOOP =======
async function cycle(seen) {
  try {
    const events = await fetchAllPages();
    const newEvents = events.filter(e => !seen.has(e.link));
    if (newEvents.length > 0) {
      // opdater state først
      newEvents.forEach(e => seen.add(e.link));
      saveSeen(seen);
      // send e-mail
      await sendEmail(newEvents);
    } else {
      console.log(`[${new Date().toISOString()}] Ingen nye events.`);
    }
  } catch (err) {
    console.error('Fejl i cycle:', err.message);
  }
}

async function sendCurrentEventsOnce() {
  const events = await fetchAllPages();
  if (!events.length) {
    console.log('Ingen events at sende (København).');
    return;
  }
  await sendEmail(events);
  console.log(`Engangsmail sendt med ${events.length} events.`);
}

// --- start ---
const args = process.argv.slice(2);
if (args.includes('--send-now')) {
  // Engangskørsel: send nuværende events og stop (ingen state)
  sendCurrentEventsOnce().catch(err => {
    console.error('Fejl i --send-now:', err);
    process.exitCode = 1;
  });
} else {
  // Normal watcher
  run().catch(err => {
    console.error('Fatal fejl:', err);
    process.exitCode = 1;
  });
}

async function run() {
  console.log(`Starter IDA watcher (København). Interval: ${Math.round(POLL_INTERVAL_MS / 60000)} min.`);
  const seen = loadSeen();
  // Første kørsel med det samme
  await cycle(seen);
  // Kontinuerligt loop
  const timer = setInterval(() => {
    cycle(seen);
  }, POLL_INTERVAL_MS);

  // Gem state ved exit
  const shutdown = () => {
    console.log('Stopper… gemmer state.');
    clearInterval(timer);
    saveSeen(seen);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
