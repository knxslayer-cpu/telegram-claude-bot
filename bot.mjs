// telegram-vyce-railway — single-process Telegram bot backed by Vyce AI API.
// OpenAI-compatible endpoint, 42+ models, $50 free credits.
// Designed for Railway.app: one container, one port, zero dependencies.
//
// Architecture:
//   Telegram ──long poll──> this process ──OpenAI format──> vyceai.com/v1
//
// Railway env vars:
//   TELEGRAM_BOT_TOKEN   — from @BotFather
//   VYCE_API_KEY         — from https://vyceai.com (your API key)
//   ALLOWED_USERS        — comma-separated Telegram user IDs (optional)
//
// Railway auto-provides PORT. We listen on it for health checks.
// Telegram uses long polling (outbound), so no inbound webhook port needed.

import http from 'node:http';
import fs from 'node:fs';

// ─── config ───────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API_KEY = process.env.VYCE_API_KEY || '';
const BASE_URL = (process.env.VYCE_BASE_URL || 'https://vyceai.com/v1').replace(/\/+$/, '');
const MODEL = process.env.VYCE_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 4096);
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  'You are a smart, helpful assistant. You take notes, answer questions, and help with work. ' +
  'Reply in the same language the user wrote. Be concise but thorough.';
const PER_USER_RPM = Number(process.env.PER_USER_RPM || 10);
const GLOBAL_RPM = Number(process.env.GLOBAL_RPM || 30);
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
const CONTEXT_TURNS = Number(process.env.CONTEXT_TURNS || 20);
const HEALTH_PORT = Number(process.env.PORT || 3000);
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const CHAT_URL = `${BASE_URL}/chat/completions`;

// ─── state ────────────────────────────────────────────────────────────
const userTimestamps = new Map();
const globalTimestamps = [];
const conversations = new Map();
const notes = new Map();
let usage = { tokens: 0, calls: 0 };
let offset = 0;

function log(fmt, ...args) {
  const ts = new Date().toISOString();
  const msg = fmt.replace(/%[sdj]/g, () => {
    const v = args.shift();
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
  console.log(ts, msg);
}

// ─── state persistence ────────────────────────────────────────────────
function loadState() {
  const sf = process.env.STATE_FILE;
  if (!sf) return;
  try {
    const raw = fs.readFileSync(sf, 'utf8');
    const s = JSON.parse(raw);
    offset = s.offset || 0;
    usage = s.usage || { tokens: 0, calls: 0 };
    if (s.conversations) {
      for (const [k, v] of Object.entries(s.conversations)) {
        conversations.set(Number(k), v);
      }
    }
    if (s.notes) {
      for (const [k, v] of Object.entries(s.notes)) {
        notes.set(Number(k), v);
      }
    }
    log('state loaded: calls=%d tokens=%d notes=%d', usage.calls, usage.tokens, notes.size);
  } catch {
    log('no prior state, starting fresh');
  }
}

function saveState() {
  const sf = process.env.STATE_FILE;
  if (!sf) return;
  try {
    const convObj = {};
    for (const [k, v] of conversations) convObj[k] = v;
    const notesObj = {};
    for (const [k, v] of notes) notesObj[k] = v;
    fs.writeFileSync(sf, JSON.stringify({ offset, usage, conversations: convObj, notes: notesObj }));
  } catch {}
}

// ─── rate limiter ─────────────────────────────────────────────────────
function pruneOld(arr, windowMs) {
  const cutoff = Date.now() - windowMs;
  while (arr.length && arr[0] < cutoff) arr.shift();
}

function userAllowed(userId) {
  const now = Date.now();
  if (ALLOWED_USERS.length && !ALLOWED_USERS.includes(String(userId))) {
    return { ok: false, reason: 'not in allowlist' };
  }
  let ts = userTimestamps.get(userId);
  if (!ts) { ts = []; userTimestamps.set(userId, ts); }
  pruneOld(ts, 60_000);
  if (ts.length >= PER_USER_RPM) {
    return { ok: false, reason: `rate limited: ${PER_USER_RPM} msg/min. Wait ${Math.ceil((ts[0] + 60_000 - now) / 1000)}s` };
  }
  pruneOld(globalTimestamps, 60_000);
  if (globalTimestamps.length >= GLOBAL_RPM) {
    return { ok: false, reason: `global rate limit (${GLOBAL_RPM} rpm). Wait ${Math.ceil((globalTimestamps[0] + 60_000 - now) / 1000)}s` };
  }
  ts.push(now);
  globalTimestamps.push(now);
  return { ok: true };
}

// ─── telegram api ─────────────────────────────────────────────────────
async function tg(method, payload) {
  const r = await fetch(`${API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || JSON.stringify(j)}`);
  return j.result;
}

async function sendMessage(chatId, text, replyTo) {
  const maxLen = 4096;
  if (text.length <= maxLen) {
    return tg('sendMessage', { chat_id: chatId, text, reply_to_message_id: replyTo, parse_mode: 'Markdown' });
  }
  for (let i = 0; i < text.length; i += maxLen) {
    await tg('sendMessage', { chat_id: chatId, text: text.slice(i, i + maxLen), reply_to_message_id: i === 0 ? replyTo : undefined, parse_mode: 'Markdown' });
  }
}

async function sendTyping(chatId) {
  try { await tg('sendChatAction', { chat_id: chatId, action: 'typing' }); } catch {}
}

// ─── vyce AI call (OpenAI-compatible) ─────────────────────────────────
async function callVyce(history, systemPrompt, userNotes) {
  let sysContent = systemPrompt;
  if (userNotes && userNotes.length) {
    sysContent += '\n\nNotes from previous conversations:\n' + userNotes.map(n => `- ${n}`).join('\n');
  }

  const messages = [
    { role: 'system', content: sysContent },
    ...history.map(m => ({ role: m.role, content: m.content })),
  ];

  const payload = {
    model: MODEL,
    messages,
    max_tokens: MAX_TOKENS,
    stream: false,
  };

  log('-> vyce model=%s msgs=%d notes=%d', MODEL, messages.length, userNotes?.length || 0);

  const r = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const raw = await r.text();

  if (r.status === 429) {
    throw new Error('vyce rate limited — wait a moment and try again');
  }

  if (!r.ok) {
    throw new Error(`vyce ${r.status}: ${raw.slice(0, 500)}`);
  }

  const j = JSON.parse(raw);

  let text = '';
  if (j.choices && j.choices[0]) {
    text = j.choices[0].message?.content || j.choices[0].text || '';
  }

  let totalTokens = j.usage?.total_tokens || 0;

  usage.calls += 1;
  usage.tokens += totalTokens;
  saveState();

  log('<- tokens: %d calls=%d', totalTokens, usage.calls);

  return { text, totalTokens };
}

// ─── conversation context ─────────────────────────────────────────────
function getHistory(userId) {
  let h = conversations.get(userId);
  if (!h) { h = []; conversations.set(userId, h); }
  return h;
}

function pushHistory(userId, role, text) {
  const h = getHistory(userId);
  h.push({ role, content: text });
  while (h.length > CONTEXT_TURNS * 2) h.shift();
}

function clearHistory(userId) {
  conversations.delete(userId);
  saveState();
}

function getNotes(userId) {
  let n = notes.get(userId);
  if (!n) { n = []; notes.set(userId, n); }
  return n;
}

function addNote(userId, text) {
  const n = getNotes(userId);
  n.push(text);
  while (n.length > 100) n.shift();
  saveState();
}

function clearNotes(userId) {
  notes.delete(userId);
  saveState();
}

// ─── message handling ─────────────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || '';
  const replyTo = msg.message_id;

  if (!text) return;

  if (text === '/start' || text === '/help') {
    await sendMessage(chatId, [
      '*Vyce AI Bot* — ผู้ช่วยอัจฉริยะ',
      '',
      'ส่งข้อความอะไรก็ได้ — จดบันทึก ถามคำถาม หรือคุยงาน',
      '',
      'คำสั่ง:',
      '/clear — ล้างประวัติแชท',
      '/notes — ดูบันทึกทั้งหมด',
      '/savenote <ข้อความ> — บันทึก',
      '/clearnotes — ล้างบันทึก',
      '/usage — ดูการใช้งาน',
      '/model — ดูโมเดลปัจจุบัน',
      '',
      `Model: ${MODEL}`,
      `Context: ${CONTEXT_TURNS} turns`,
      `Rate: ${PER_USER_RPM} msg/min`,
    ].join('\n'), replyTo);
    return;
  }

  if (text === '/clear') {
    clearHistory(userId);
    await sendMessage(chatId, 'ล้างประวัติแชทแล้ว', replyTo);
    return;
  }

  if (text.startsWith('/savenote ')) {
    const noteText = text.slice('/savenote '.length).trim();
    if (noteText) {
      addNote(userId, noteText);
      await sendMessage(chatId, `บันทึกแล้ว (${getNotes(userId).length} บันทึก)`, replyTo);
    }
    return;
  }

  if (text === '/notes') {
    const userNotes = getNotes(userId);
    if (!userNotes.length) {
      await sendMessage(chatId, 'ยังไม่มีบันทึก', replyTo);
    } else {
      await sendMessage(chatId, '*บันทึก:*\n\n' + userNotes.map((n, i) => `${i + 1}. ${n}`).join('\n'), replyTo);
    }
    return;
  }

  if (text === '/clearnotes') {
    clearNotes(userId);
    await sendMessage(chatId, 'ล้างบันทึกแล้ว', replyTo);
    return;
  }

  if (text === '/usage') {
    await sendMessage(chatId, [
      '*การใช้งาน (deploy นี้)*',
      '',
      `Calls: ${usage.calls.toLocaleString()}`,
      `Tokens: ${usage.tokens.toLocaleString()}`,
      `Model: ${MODEL}`,
    ].join('\n'), replyTo);
    return;
  }

  if (text === '/model') {
    await sendMessage(chatId, `Model: \`${MODEL}\`\nMax output: ${MAX_TOKENS} tokens\nEndpoint: ${BASE_URL}`, replyTo);
    return;
  }

  const allow = userAllowed(userId);
  if (!allow.ok) {
    await sendMessage(chatId, `⏳ ${allow.reason}`, replyTo);
    return;
  }

  pushHistory(userId, 'user', text);
  await sendTyping(chatId);

  const history = getHistory(userId).slice();
  const userNotes = getNotes(userId);

  try {
    const result = await callVyce(history, SYSTEM_PROMPT, userNotes);
    pushHistory(userId, 'assistant', result.text);

    let reply = result.text;
    if (reply.length > 4000) {
      reply = reply.slice(0, 3900) + '\n\n... (truncated)';
    }

    const footer = process.env.SHOW_TOKEN_INFO !== 'false'
      ? `\n\n_\`${result.totalTokens} tokens • ${usage.tokens} total\`_`
      : '';
    await sendMessage(chatId, reply + footer, replyTo);

  } catch (e) {
    log('error: %s', e.message);
    await sendMessage(chatId, `Error: ${e.message.slice(0, 200)}`, replyTo);
    pushHistory(userId, 'assistant', `[error: ${e.message}]`);
  }
}

// ─── long polling ─────────────────────────────────────────────────────
async function poll() {
  try {
    const updates = await tg('getUpdates', {
      offset,
      timeout: 30,
      allowed_updates: ['message'],
    });

    for (const upd of updates) {
      offset = upd.update_id + 1;
      if (upd.message) {
        handleMessage(upd.message).catch(e => log('handle error: %s', e.message));
      }
    }

    if (updates.length) saveState();
  } catch (e) {
    log('poll error: %s — retry in 5s', e.message);
    await new Promise(r => setTimeout(r, 5000));
  }
}

// ─── health server (Railway needs a port to listen on) ─────────────────
const healthServer = http.createServer(async (req, res) => {
  const url = req.url || '/';
  if (url === '/health' || url === '/') {
    const keyOk = !!API_KEY;
    res.writeHead(keyOk ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: keyOk,
      bot: !!BOT_TOKEN,
      model: MODEL,
      endpoint: BASE_URL,
      calls: usage.calls,
      tokens: usage.tokens,
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

// ─── startup ──────────────────────────────────────────────────────────
async function main() {
  if (!BOT_TOKEN) {
    console.error('FATAL: TELEGRAM_BOT_TOKEN not set');
    process.exit(1);
  }

  if (!API_KEY) {
    console.error('FATAL: VYCE_API_KEY not set');
    console.error('Get one from https://vyceai.com');
    process.exit(1);
  }

  loadState();

  healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    log('health server on :%d', HEALTH_PORT);
  });

  const me = await tg('getMe');
  log('bot online: @%s (%s)', me.username, me.first_name);
  log('model: %s  max_tokens: %d  context: %d turns', MODEL, MAX_TOKENS, CONTEXT_TURNS);
  log('rate: %d rpm/user  %d rpm global', PER_USER_RPM, GLOBAL_RPM);
  if (ALLOWED_USERS.length) log('allowlist: %s', ALLOWED_USERS.join(', '));

  log('polling started');
  for (;;) {
    await poll();
  }
}

main();
