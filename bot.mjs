// telegram-claude-railway — single-process Telegram bot backed by Anthropic API.
// Designed for Railway.app: one container, one port, zero dependencies.
//
// Architecture:
//   Telegram ──long poll──> this process ──API Key──> api.anthropic.com
//
// Railway env vars:
//   TELEGRAM_BOT_TOKEN      — from @BotFather
//   ANTHROPIC_API_KEY       — from https://console.anthropic.com/settings/keys
//   ALLOWED_USERS           — comma-separated Telegram user IDs (optional)
//
// Railway auto-provides PORT. We listen on it for health checks.
// Telegram uses long polling (outbound), so no inbound webhook port needed.

import http from 'node:http';
import fs from 'node:fs';

// ─── config ───────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const UPSTREAM = (process.env.ANTHROPIC_UPSTREAM || 'https://api.anthropic.com').replace(/\/+$/, '');
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const MAX_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 2048);
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 'You are a helpful assistant. Reply concisely in the same language the user wrote.';
const PER_USER_RPM = Number(process.env.PER_USER_RPM || 10);
const GLOBAL_RPM = Number(process.env.GLOBAL_RPM || 40);
const MONTHLY_CREDIT_CAP = Number(process.env.MONTHLY_CREDIT_CAP || 5);
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
const CONTEXT_TURNS = Number(process.env.CONTEXT_TURNS || 6);
const HEALTH_PORT = Number(process.env.PORT || 3000);
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── state ────────────────────────────────────────────────────────────
const userTimestamps = new Map();
const globalTimestamps = [];
const conversations = new Map();
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

// ─── state persistence (in-memory on Railway — ephemeral) ────────────
// Railway containers restart = state lost. Token counter resets on redeploy.
// For persistence, add a Railway Volume and set STATE_FILE to the mounted path.

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
    log('state loaded: calls=%d tokens=%d', usage.calls, usage.tokens);
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
    fs.writeFileSync(sf, JSON.stringify({ offset, usage, conversations: convObj }));
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

// ─── anthropic API call ───────────────────────────────────────────────
class RateLimitError extends Error {
  constructor(retryAfter, raw) {
    super(`rate limited: retry after ${retryAfter}s`);
    this.retryAfter = retryAfter;
    this.raw = raw;
  }
}

async function callClaude(messages, systemPrompt) {
  const payload = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages,
    stream: false,
  };

  const url = `${UPSTREAM}/v1/messages`;
  log('-> anthropic %s model=%s msgs=%d', url, MODEL, messages.length);

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'user-agent': 'telegram-claude-bot/1.0.0',
    },
    body: JSON.stringify(payload),
  });

  const raw = await r.text();

  if (r.status === 429) {
    let retryAfter = 60;
    try {
      const j = JSON.parse(raw);
      const msg = j.error?.message || '';
      const m = msg.match(/(\d+)\s*second/i);
      if (m) retryAfter = Number(m[1]);
    } catch {}
    throw new RateLimitError(retryAfter, raw);
  }

  if (!r.ok) {
    throw new Error(`anthropic ${r.status}: ${raw.slice(0, 500)}`);
  }

  const j = JSON.parse(raw);

  let inputTokens = j.usage?.input_tokens || 0;
  let outputTokens = j.usage?.output_tokens || 0;
  let total = inputTokens + outputTokens;

  let text = '';
  if (j.content && Array.isArray(j.content)) {
    text = j.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  } else if (typeof j.content === 'string') {
    text = j.content;
  }

  usage.calls += 1;
  usage.tokens += total;
  saveState();

  log('<- tokens: in=%d out=%d total=%d calls=%d', inputTokens, outputTokens, total, usage.calls);

  return { text, inputTokens, outputTokens, total };
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

// ─── message handling ─────────────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || '';
  const replyTo = msg.message_id;

  if (!text) return;

  if (text === '/start' || text === '/help') {
    await sendMessage(chatId, [
      '*Claude Telegram Bot*',
      '',
      'Send any message — Claude will reply.',
      '',
      `/clear — clear chat history`,
      `/usage — token usage`,
      `/model — current model`,
      '',
      `Rate: ${PER_USER_RPM} msg/min/user`,
      `Credit cap warning: $${MONTHLY_CREDIT_CAP} USD`,
    ].join('\n'), replyTo);
    return;
  }

  if (text === '/clear') {
    clearHistory(userId);
    await sendMessage(chatId, 'History cleared.', replyTo);
    return;
  }

  if (text === '/usage') {
    await sendMessage(chatId, [
      '*Token Usage (this deploy)*',
      '',
      `Calls: ${usage.calls.toLocaleString()}`,
      `Tokens: ${usage.tokens.toLocaleString()}`,
      `Cap warning: $${MONTHLY_CREDIT_CAP} USD`,
    ].join('\n'), replyTo);
    return;
  }

  if (text === '/model') {
    await sendMessage(chatId, `Model: \`${MODEL}\`\nMax output: ${MAX_TOKENS} tokens`, replyTo);
    return;
  }

  const allow = userAllowed(userId);
  if (!allow.ok) {
    await sendMessage(chatId, `⏳ ${allow.reason}`, replyTo);
    return;
  }

  pushHistory(userId, 'user', text);
  await sendTyping(chatId);

  const messages = getHistory(userId).slice();

  try {
    const result = await callClaude(messages, SYSTEM_PROMPT);
    pushHistory(userId, 'assistant', result.text);

    let reply = result.text;
    if (reply.length > 4000) {
      reply = reply.slice(0, 3900) + '\n\n... (truncated)';
    }

    const footer = process.env.SHOW_TOKEN_INFO !== 'false'
      ? `\n\n_\`${result.total} tokens • ${usage.tokens} total\`_`
      : '';
    await sendMessage(chatId, reply + footer, replyTo);

  } catch (e) {
    if (e instanceof RateLimitError) {
      await sendMessage(chatId, `⏳ Claude rate limited — wait ${e.retryAfter}s`, replyTo);
      pushHistory(userId, 'assistant', '[rate limited]');
    } else {
      log('error: %s', e.message);
      await sendMessage(chatId, `Error: ${e.message.slice(0, 200)}`, replyTo);
      pushHistory(userId, 'assistant', `[error: ${e.message}]`);
    }
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
    console.error('FATAL: ANTHROPIC_API_KEY not set');
    console.error('Get one from https://console.anthropic.com/settings/keys');
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
