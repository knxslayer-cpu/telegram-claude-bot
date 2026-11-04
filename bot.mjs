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
const MODEL = process.env.VYCE_MODEL || 'beam-1.0';
const MAX_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 4096);
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  '你是「บอล」(Ball) — คนจดงานและผู้ช่วยอัจฉริยะของกลุ่มนี้。' +
  'คุณคือ AI ผู้ช่วยเต็มรูปแบบ สามารถตอบคำถามทั่วไปได้ทุกเรื่อง เช่น วันนี้วันอะไร กี่โมง อากาศ ความรู้ทั่วไป คำนวณ แปลภาษา หรือสนทนาได้ปกติ。' +
  'หน้าที่พิเศษเพิ่มเติม: จดงานที่คนพิมพ์ในกลุ่ม แยกตามเป้าหมาย ถ้ามีคำระบุเจาะจง เช่น "ฝ่าย X" "ของ X" "ให้ X" ให้ tag งานนั้นไว้กับ X นั้น ถ้าไม่มีให้ใช้ชื่อคนสั่ง。' +
  'เมื่อมีคนขอสรุป เช่น "สรุปงานฝ่ายหน้าบ้าน" "ส่งงานให้สมชาย" ให้ดึงเฉพาะบันทึกที่ tag ตรงกับชื่อนั้นมาแสดง ไม่เอาอันอื่นมารวม。' +
  'ถ้าขอสรุปแบบไม่ระบุเป้าหมาย (เช่น "สรุปงานให้หน่อย") ให้แสดงงานทั้งหมดแยกตาม tag。' +
  'รับคำสั่งเป็นภาษาพูดธรรมดาได้ ไม่ต้องใช้ / คำสั่ง。' +
  'ถ้าได้รับคำสั่งให้จดงานชัดเจน ให้ตอบยืนยันสั้นๆ ว่า "จดแล้ว ✅"。' +
  'ถ้าเป็นคำถามทั่วไปหรือบทสนทนา ให้ตอบตามปกติเหมือน AI ผู้ช่วยทั่วไป。' +
  'ตอบกลับด้วยภาษาที่ผู้ใช้พิมพ์ (ไทย/อังกฤษ)。Keep it concise but thorough。' +
  'นอกจากนี้ หากถูกถามถึงบุคคล (ระบุ acc หรือ @username) ให้ใช้ข้อมูลชื่อ/ตำแหน่งที่ระบบให้มาตอบ และบอกว่าจดไว้จากใคร。';
const PER_USER_RPM = Number(process.env.PER_USER_RPM || 10);
const GLOBAL_RPM = Number(process.env.GLOBAL_RPM || 30);
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
const CONTEXT_TURNS = Number(process.env.CONTEXT_TURNS || 20);
const HEALTH_PORT = Number(process.env.PORT || 3000);
let BOT_USERNAME = '';
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const CHAT_URL = `${BASE_URL}/chat/completions`;

// ─── state ────────────────────────────────────────────────────────────
const userTimestamps = new Map();
const globalTimestamps = [];
const conversations = new Map();
const notes = new Map();
const groupContext = new Map(); // chatId -> recent messages ring buffer
const GROUP_CONTEXT_TURNS = Number(process.env.GROUP_CONTEXT_TURNS || 15);
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

// ─── runtime config (taught rules + group trigger) ────────────────────
// Persisted to CONFIG_FILE so settings survive restarts without code edits.
const CONFIG_FILE = process.env.CONFIG_FILE || 'bot-config.json';
let config = { groupTrigger: 'บอล', rules: [] };
let triggerRegex = null;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a regex from a comma-separated trigger list. Empty => reply to ALL group messages.
function buildTriggerRegex(t) {
  if (!t || !t.trim()) return null;
  const parts = t.split(',').map(s => s.trim()).filter(Boolean).map(escapeRegex);
  return new RegExp(parts.join('|'), 'i');
}

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = { groupTrigger: c.groupTrigger ?? 'บอล', rules: Array.isArray(c.rules) ? c.rules : [] };
  } catch {}
  triggerRegex = config.groupTrigger ? buildTriggerRegex(config.groupTrigger) : null;
  log('config: trigger=%s rules=%d', config.groupTrigger || '(all)', config.rules.length);
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config)); } catch {}
}

// ─── people / profile memory ───────────────────────────────────────────
// Remembers each person's name & position keyed by their Telegram @username (acc).
// Learns passively from group/private messages and answers lookups like
// "acc X ชื่ออะไร" / "@X ตำแหน่งอะไร".
const PROFILES_FILE = process.env.PROFILES_FILE || 'bot-profiles.json';
const profiles = new Map(); // acc(lower) -> { name, position, by, at }

function loadProfiles() {
  try {
    const raw = fs.readFileSync(PROFILES_FILE, 'utf8');
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) profiles.set(k.toLowerCase(), v);
    log('profiles loaded: %d', profiles.size);
  } catch {}
}

function saveProfiles() {
  try {
    const obj = {};
    for (const [k, v] of profiles) obj[k] = v;
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(obj));
  } catch {}
}

function saveProfile(acc, data) {
  if (!acc) return;
  acc = acc.toLowerCase();
  const prev = profiles.get(acc) || {};
  profiles.set(acc, { ...prev, ...data, at: Date.now() });
  saveProfiles();
}

function getProfile(acc) {
  if (!acc) return null;
  return profiles.get(acc.toLowerCase()) || null;
}

// Extract a name/position declaration from a message.
// Returns { acc, name, position, explicit } or null.
//   explicit = the acc was named directly ("acc X" / "@X ..."), not just the sender.
function detectProfileDeclaration(text, senderUsername) {
  const botAcc = (BOT_USERNAME || '').toLowerCase();
  const sender = (senderUsername || '').toLowerCase();

  const posM = text.match(/(?:ตำแหน่ง|ทำหน้าที่|งานคือ|บทบาท|position|role)\s*[:：]?\s*([\p{L}\p{M}\p{N} ]{2,40}?)(?=\s*(?:ชื่อ|คือ|เป็น|และ|เพิ่มเติม|,|$|。|\.))/iu);
  let position = posM ? posM[1].trim() : null;

  const accM = text.match(/(?:^|\s)(?:acc|แอค)\s*@?(\w+)/iu) || text.match(/(?:^|\s)@(\w+)/);
  let declaredAcc = accM ? (accM[1] || accM[2] || '').toLowerCase() : null;
  if (declaredAcc && declaredAcc === botAcc) declaredAcc = null;
  const explicit = !!declaredAcc;

  const nameM = text.match(/(?:ชื่อ|คือ|เป็น|ตัวชื่อ|my name is|i am|我叫)\s*[:：]?\s*([\p{L}\p{M}\p{N} ]{2,40}?)(?=\s*(?:ตำแหน่ง|ทำหน้าที่|position|role|และ|เพิ่มเติม|,|$|。|\.))/iu);
  let name = nameM ? nameM[1].trim() : null;
  if (!name) {
    const selfM = text.match(/(?:ฉัน|ผม|เรา|ชั้น|กระผม|หนู|my name)\s+([\p{L}\p{M}\p{N} ]{2,30}?)(?=\s*(?:ตำแหน่ง|ทำหน้าที่|position|role)|$)/iu);
    if (selfM) name = selfM[1].trim();
  }

  // Reject obvious question fragments that slipped through.
  const junk = /(อะไร|ใคร|ไหม|หรือไม่|是谁|是什么|\?)/i;
  if (name && (junk.test(name) || name.length > 30)) name = null;
  if (position && (junk.test(position) || position.length > 40)) position = null;

  const acc = declaredAcc || sender;
  if (!acc) return null;
  if (!name && !position) return null;
  return { acc, name: name || null, position: position || null, explicit };
}

// Detect a query about an acc's name/position.
// Returns { acc, ask: 'name'|'position'|'both' } or null.
function detectProfileQuery(text) {
  const botAcc = (BOT_USERNAME || '').toLowerCase();
  const accM = text.match(/(?:acc|แอค)\s*@?(\w+)/iu) || text.match(/@(\w+)/);
  if (!accM) return null;
  const acc = (accM[1] || accM[2] || '').toLowerCase();
  if (acc === botAcc) return null;
  const askName = /(ชื่อ|ใคร|是谁|name|ใครชื่อ|ชื่อคือ|อะไรชื่อ|เรียก)/iu.test(text);
  const askPos = /(ตำแหน่ง|position|role|หน้าที่|ทำอะไร|ทำหน้าที่|งานคือ)/iu.test(text);
  if (!askName && !askPos) return null;
  let ask = 'both';
  if (askName && !askPos) ask = 'name';
  else if (askPos && !askName) ask = 'position';
  return { acc, ask };
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

async function sendOne(chatId, text, replyTo) {
  try {
    return await tg('sendMessage', { chat_id: chatId, text, reply_to_message_id: replyTo, parse_mode: 'Markdown' });
  } catch (e) {
    // LLM output often breaks legacy Markdown (e.g. stray ** or _). Retry as plain text.
    if (/400|parse|entity|markdown/i.test(e.message)) {
      return await tg('sendMessage', { chat_id: chatId, text, reply_to_message_id: replyTo });
    }
    throw e;
  }
}

async function sendMessage(chatId, text, replyTo) {
  const maxLen = 4096;
  if (text.length <= maxLen) {
    return sendOne(chatId, text, replyTo);
  }
  for (let i = 0; i < text.length; i += maxLen) {
    await sendOne(chatId, text.slice(i, i + maxLen), i === 0 ? replyTo : undefined);
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
  if (config.rules.length) {
    sysContent += '\n\nกฎเพิ่มเติมที่ผู้ใช้สอนให้ (ต้องปฏิบัติตามเสมอ):\n' + config.rules.map(r => `- ${r}`).join('\n');
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

// Save a task note, tagging by target if specified (ฝ่าย X / ของ X / ให้ X), else by person.
function saveTaskNote(userId, msg, content) {
  const who = msg.from?.first_name || msg.from?.username || `user${userId}`;
  // Try to detect a target: "ฝ่าย X", "ของ X", "ให้ X", "สำหรับ X"
  const targetMatch = content.match(/(?:ฝ่าย|ของ|ให้|สำหรับ)\s*([^\s:：]+)/);
  let tag;
  if (targetMatch) {
    const raw = targetMatch[1];
    tag = raw.startsWith('ฝ่าย') ? raw : `${raw}`;
  } else {
    tag = who;
  }
  addNote(userId, `[${tag}] ${content}`);
}

// Keep a ring buffer of recent group messages for context-based logging.
function pushGroupContext(chatId, entry) {
  let buf = groupContext.get(chatId);
  if (!buf) { buf = []; groupContext.set(chatId, buf); }
  buf.push(entry);
  while (buf.length > GROUP_CONTEXT_TURNS) buf.shift();
}

// Use AI to decide which recent messages are actual work tasks and log them.
async function analyzeAndLogTasks(userId, chatId) {
  const buf = groupContext.get(chatId) || [];
  if (!buf.length) return 'ไม่มีข้อความในบริบทให้จด';

  const transcript = buf.map(e => `${e.who}: ${e.text}`).join('\n');
  const prompt = `นี่คือประวัติแชทล่าสุดในกลุ่ม:\n${transcript}\n\n` +
    `จงวิเคราะห์หา "การสั่งงานที่ชัดเจน" เท่านั้น — นั่นคือข้อความที่มีการมอบหมาย กำชับ หรือสั่งให้ทำสิ่งใดสิ่งหนึ่งอย่างชัดเจน ` +
    `(เช่น "ทำรายงาน", "ติดตั้ง X", "นัดประชุมวันX", "ส่งของให้ Y")。\n` +
    `ห้ามจดข้อความที่เป็นเพียงบทสนทนาทั่วไป คำถาม ความคิดเห็น ตอบรับ แสดงความเห็น หรือพูดเล่น。\n` +
    `ห้ามเดาจากบริบทที่ไม่ชัดเจน — ถ้าไม่แน่ใจว่าใช่การสั่งงานหรือไม่ ให้ข้าม。\n` +
    `ถ้ามีคำระบุเป้าหมายชัดเจนในข้อความ (เช่น "ฝ่ายIT", "ของสมชาย", "ให้มานี้") ให้ใช้เป็น tag。\n` +
    `ตอบกลับในรูปแบบ JSON เท่านั้น: {"tasks": [{"who": "ชื่อคนพิมพ์", "tag": "ฝ่ายหรือชื่อเป้าหมาย หรือชื่อคนพิมพ์ถ้าไม่มี", "task": "เนื้อหางานที่สั่งชัดเจน"}]}\n` +
    `ถ้าไม่มีงานที่ชัดเจนเลย ให้ตอบ {"tasks": []}`;

  const payload = {
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: MAX_TOKENS,
    stream: false,
    response_format: { type: 'json_object' },
  };

  const r = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(payload),
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`vyce ${r.status}: ${raw.slice(0, 300)}`);
  const j = JSON.parse(raw);
  let text = j.choices?.[0]?.message?.content || '{}';

  let parsed;
  try { parsed = JSON.parse(text); } catch { return 'ไม่สามารถวิเคราะห์ได้'; }

  const tasks = parsed.tasks || [];
  if (!tasks.length) return 'ไม่พบการสั่งงานในบริบทนี้';

  let logged = 0;
  for (const t of tasks) {
    const who = t.who || 'unknown';
    const tag = t.tag || who;
    const task = t.task || '';
    if (task.trim().length > 1) {
      addNote(userId, `[${tag}] ${task}`);
      logged++;
    }
  }
  return `จดแล้ว ✅ (${logged} รายการ • รวม ${getNotes(userId).length})`;
}

// ─── message handling ─────────────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || '';
  const replyTo = msg.message_id;

  if (!text) return;

  log('recv chat=%d user=%d group=%s: %s', chatId, userId, chatId < 0 ? 'Y' : 'N', text.slice(0, 100));

  // Telegram appends @username to commands inside groups, e.g. "/start@Nahsebot_bot".
  // Normalize so command matching works whether or not the suffix is present.
  let cmd = text;
  const cm = text.match(/^(\/[A-Za-z0-9_]+)(@[A-Za-z0-9_]+)?/);
  if (cm) cmd = cm[1];

  // Private chat: always reply, but also remember every message.
  // Group chat: only reply when mentioned/replied; only auto-log when "บอลจดงาน" appears.
  const isGroup = chatId < 0;
  let shouldReply = true;
  let autoLog = false;
  let explicitLogCommand = false;

  if (isGroup) {
    // Always store group messages in the context ring buffer.
    const who = msg.from?.first_name || msg.from?.username || `user${userId}`;
    pushGroupContext(chatId, { who, text });

    const mentionsMe = msg.entities &&
      msg.entities.some(e => e.type === 'mention' && text.slice(e.offset, e.offset + e.length).startsWith('@'));
    const replyToBot = msg.reply_to_message &&
      msg.reply_to_message.from &&
      msg.reply_to_message.from.is_bot === true &&
      msg.reply_to_message.from.username === BOT_USERNAME;
    const mentionsByName = triggerRegex ? triggerRegex.test(text) : true;
    // Group: only react when the configured trigger word(s) appear (reply to all if disabled).
    shouldReply = mentionsByName;
    // Strip the leading @mention so the model isn't confused by it.
    if (mentionsMe) {
      const m = text.match(/^@\w+\s*/);
      if (m) msg.text = text.slice(m[0].length).trim();
    }
    // "บอลจดงาน" anywhere in a group message = analyze context and log tasks.
    if (/บอล\s*จดงาน/i.test(text)) {
      explicitLogCommand = true;
    }
  } else {
    // Private chat: remember every message automatically.
    autoLog = true;
  }

  if (cmd === '/start' || cmd === '/help') {
    await sendMessage(chatId, [
      '👤 *บอล* — คนจดงานประจำกลุ่ม',
      '',
      'ฉันอ่านทุกข้อความในกลุ่มแล้วจดงานไว้',
      'พิมพ์แบบคุยธรรมดาได้เลย เช่น:',
      '• "สรุปงานให้หน่อย" → ฉันสรุปงานที่จดไว้ทั้งหมด',
      '• "สรุปงานฝ่ายหน้าบ้าน" → ฉันสรุปเฉพาะฝ่ายนั้น',
      '• "จดงานนี้: ..." → ฉันบันทึกเพิ่ม',
      '• "ล้างประวัติ" → ฉันล้างบันทึก',
      '• ถามอะไรก็ได้ → ฉันตอบ',
      '',
      'ฉันจดงานแยกตามเป้าหมายอัตโนมัติ — พิมพ์ "ของ X" "ให้ X" "ฝ่าย X" ในข้อความใด ๆ ฉันจะจดไว้ให้คน/ฝ่ายนั้น',
      '',
      'การจดงาน:',
      '• แชทส่วนตัว: ฉันจำทุกข้อความให้อัตโนมัติ',
      '• กลุ่ม: พิมพ์ "บอลจดงาน" (ไม่ว่าจะตรงไหนในข้อความ) ฉันจะวิเคราะห์แชทย้อนหลัง หางานที่สั่งแล้วจดเอง',
      '• สั่งจดเฉพาะข้อความ: "จดงานนี้: ..." หรือ "ของ X ทำ Y"',
      'ไม่ต้องใช้ / คำสั่ง — พิมพ์เป็นภาษาพูดก็ได้',
      '',
      'ในกลุ่ม: ตอบเฉพาะเมื่อข้อความมีคำว่า "บอล" (พิมพ์ตรงไหนก็ได้ในข้อความ)',
      '• จำคนในกลุ่ม: พิมพ์แนะนำตัว "ฉันชื่อ X ตำแหน่ง Y" (หรือบอก "acc Z ชื่อ X ตำแหน่ง Y") บอทจะจดไว้ — แล้วตอบเมื่อมีคนถาม "acc Z ชื่ออะไร" / "acc Z ตำแหน่งอะไร" (หรือใช้ /who Z)',
      'พิมพ์ "บอลจดงาน" (ไม่ว่าตรงไหน) เพื่อให้ฉันวิเคราะห์แชทย้อนหลังแล้วจดงาน',
      'หมายเหตุ: ในกลุ่มฉันจะเงียบหากข้อความไม่มีคำว่า "บอล"',
      '',
      'ตั้งค่าเองได้ (ไม่ต้องแก้โค้ด): /trigger <คำ> เปลี่ยนคำเรียกกลุ่ม • /teach <ข้อความ> สอนกฎ • /rules ดู • /resetrules ล้าง',
      '',
      `Model: ${MODEL}`,
      `Context: ${CONTEXT_TURNS} turns`,
      `Rate: ${PER_USER_RPM} msg/min`,
    ].join('\n'), replyTo);
    return;
  }

  if (cmd === '/clear') {
    clearHistory(userId);
    clearNotes(userId);
    await sendMessage(chatId, 'ล้างประวัติและบันทึกแล้ว', replyTo);
    return;
  }

  // Keep /usage and /model as quick info commands
  if (cmd === '/usage') {
    await sendMessage(chatId, [
      '*การใช้งาน (deploy นี้)*',
      '',
      `Calls: ${usage.calls.toLocaleString()}`,
      `Tokens: ${usage.tokens.toLocaleString()}`,
      `Model: ${MODEL}`,
    ].join('\n'), replyTo);
    return;
  }

  if (cmd === '/model') {
    await sendMessage(chatId, `Model: \`${MODEL}\`\nMax output: ${MAX_TOKENS} tokens\nEndpoint: ${BASE_URL}`, replyTo);
    return;
  }

  // ─── runtime teaching commands (no code edits needed) ───────────────
  if (cmd === '/teach' || cmd === '/สอน') {
    const instr = text.replace(/^\/(teach|สอน)\s*/i, '').trim();
    if (!instr) {
      await sendMessage(chatId, 'ใช้งาน: /teach <ข้อความที่จะสอน> เช่น /teach ตอบด้วยภาษาอังกฤษ', replyTo);
      return;
    }
    config.rules.push(instr);
    saveConfig();
    await sendMessage(chatId, `สอนแล้ว ✅ (${config.rules.length} กฎ)\n• ${instr}`, replyTo);
    return;
  }

  if (cmd === '/trigger') {
    const w = text.replace(/^\/trigger\s*/i, '').trim();
    config.groupTrigger = w;
    triggerRegex = buildTriggerRegex(w);
    saveConfig();
    await sendMessage(chatId, w
      ? `ตั้งคำเรียกในกลุ่มเป็น: "${w}" (ตอบเฉพาะเมื่อข้อความมีคำนี้ — รองรับหลายคำคั่นด้วยคอมมา เช่น บอล,ball)`
      : `ปิดการจำกัด — บอทจะตอบข้อความกลุ่มทั้งหมด`, replyTo);
    return;
  }

  if (cmd === '/rules') {
    const t = config.groupTrigger ? `"${config.groupTrigger}"` : 'ตอบทั้งหมด';
    const rs = config.rules.length ? config.rules.map((r, i) => `${i + 1}. ${r}`).join('\n') : '(ยังไม่มี)';
    await sendMessage(chatId, `*คำเรียกกลุ่ม:* ${t}\n\n*กฎที่สอน:*\n${rs}`, replyTo);
    return;
  }

  if (cmd === '/resetrules') {
    config.rules = [];
    saveConfig();
    await sendMessage(chatId, 'ล้างกฎที่สอนแล้ว (คำเรียกกลุ่มคงเดิม)', replyTo);
    return;
  }

  // Look up a remembered person by their Telegram @username (acc).
  if (cmd === '/who' || cmd === '/profile') {
    const a = text.replace(/^\/(who|profile)\s*/i, '').trim().replace(/^@/, '').toLowerCase();
    if (!a) {
      await sendMessage(chatId, 'ใช้งาน: /who <acc> เช่น `/who somchai`', replyTo);
      return;
    }
    const p = getProfile(a);
    if (p) {
      await sendMessage(chatId, [
        `ข้อมูล acc *${a}*:`,
        `• ชื่อ: *${p.name || '-'}*`,
        `• ตำแหน่ง: *${p.position || '-'}*`,
        p.by ? `• จดโดย: @${p.by}` : '',
      ].filter(Boolean).join('\n'), replyTo);
    } else {
      await sendMessage(chatId, `ยังไม่มีข้อมูลของ acc *${a}* — ให้คนนั้นแนะนำตัวก่อน (เช่น "ฉันชื่อ ... ตำแหน่ง ...") หรือพิมพ์ "acc ${a} ชื่อ ... ตำแหน่ง ..."`, replyTo);
    }
    return;
  }

  // Natural-language teaching in private: "สอนว่า ..." / "จงจำว่า ..."
  if (!isGroup) {
    const nat = text.match(/^(สอนว่า|จงจำว่า|สอนให้|ให้จำว่า)\s*(.+)$/s);
    if (nat) {
      const instr = nat[2].trim();
      config.rules.push(instr);
      saveConfig();
      await sendMessage(chatId, `สอนแล้ว ✅ (${config.rules.length} กฎ)\n• ${instr}`, replyTo);
      return;
    }
  }

  // ─── people / profile memory ─────────────────────────────────────────
  // Passively learn names/positions from ANY message (group or private), then
  // answer lookups when the bot is actually called. Keyed by Telegram @username (acc).
  const senderAccRaw = msg.from?.username;
  const decl = detectProfileDeclaration(text, senderAccRaw);
  let declared = false;
  let declKey = null;
  if (decl && (decl.name || (decl.explicit && decl.position))) {
    const botAcc = (BOT_USERNAME || '').toLowerCase();
    declKey = (decl.acc && decl.acc !== botAcc) ? decl.acc : (senderAccRaw || `user${userId}`).toLowerCase();
    saveProfile(declKey, { name: decl.name, position: decl.position, by: senderAccRaw || `user${userId}` });
    declared = true;
    log('profile saved: acc=%s name=%s position=%s', declKey, decl.name || '-', decl.position || '-');
  }

  // Lookup query (only when the bot is called).
  if (shouldReply && !declared) {
    const q = detectProfileQuery(text);
    if (q) {
      const p = getProfile(q.acc);
      if (p) {
        const bits = [];
        if (q.ask === 'name' || q.ask === 'both') bits.push(`ชื่อ: *${p.name || '-'}*`);
        if (q.ask === 'position' || q.ask === 'both') bits.push(`ตำแหน่ง: *${p.position || '-'}*`);
        const src = p.by ? `\n(บันทึกจาก @${p.by})` : '';
        await sendMessage(chatId, `ข้อมูล acc *${q.acc}*:\n${bits.join('\n')}${src}`, replyTo);
      } else {
        await sendMessage(chatId, `ยังไม่มีข้อมูลของ acc *${q.acc}* — ให้คนนั้นแนะนำตัวก่อน (เช่น "ฉันชื่อ ... ตำแหน่ง ...") หรือพิมพ์ "acc ${q.acc} ชื่อ ... ตำแหน่ง ..."`, replyTo);
      }
      return;
    }
  }

  // Confirmation when the bot was called to record a profile.
  if (shouldReply && declared) {
    const bits = [];
    if (decl.name) bits.push(`ชื่อ: *${decl.name}*`);
    if (decl.position) bits.push(`ตำแหน่ง: *${decl.position}*`);
    await sendMessage(chatId, `จดข้อมูล acc *${declKey}* แล้ว ✅\n${bits.join('\n')}`, replyTo);
    return;
  }

  // Explicit "บอลจดงาน" in a group -> analyze recent context and log tasks via AI.
  if (explicitLogCommand && isGroup) {
    await sendTyping(chatId);
    try {
      const result = await analyzeAndLogTasks(userId, chatId);
      await sendMessage(chatId, result, replyTo);
    } catch (e) {
      log('analyze error: %s', e.message);
      await sendMessage(chatId, `Error: ${e.message.slice(0, 150)}`, replyTo);
    }
    return;
  }

  // Explicit "จดงาน" style command -> save directly, confirm briefly (no AI call).
  if (/จด|บันทึก|note|save|เพิ่มงาน/i.test(text)) {
    const m = text.match(/(?:จดงานนี้|จด|บันทึก|note|save|เพิ่มงาน)\s*[:：]?\s*(.*)/is);
    const content = m && m[1] ? m[1].trim() : text;
    if (content && content.length > 1) {
      saveTaskNote(userId, msg, content);
      await sendMessage(chatId, `จดแล้ว ✅ (${getNotes(userId).length} รายการ)`, replyTo);
      return;
    }
  }

  // Private chat: silently remember every message, but STILL answer as a normal AI.
  if (autoLog && text && text.length > 2) {
    saveTaskNote(userId, msg, text);
  }

  // In groups, stay silent unless the message contains "บอล".
  if (!shouldReply) return;

  const allow = userAllowed(userId);
  if (!allow.ok) {
    await sendMessage(chatId, `⏳ ${allow.reason}`, replyTo);
    return;
  }

  // Detect "สรุปงานฝ่าย X" / "ส่งงานฝ่าย X" — filter notes to that department only.
  const deptReq = text.match(/สรุป|ส่ง|แสดง|ดู|งาน\s*(?:ของ|ฝ่าย)?\s*ฝ่าย\s*([^\s:：]+)/);
  let filteredNotes = getNotes(userId);
  let deptFilter = '';
  if (deptReq && deptReq[1]) {
    deptFilter = `ฝ่าย${deptReq[1]}`;
    filteredNotes = filteredNotes.filter(n => n.startsWith(`[${deptFilter}]`));
  }

  // Inject known profiles for any acc mentioned, so the AI can answer naturally.
  const mentioned = new Set();
  for (const m of text.matchAll(/(?:acc|แอค)\s*@?(\w+)/giu)) mentioned.add(m[1].toLowerCase());
  for (const m of text.matchAll(/(?:^|\s)@(\w+)/g)) mentioned.add(m[1].toLowerCase());
  const profNotes = [];
  const botAcc = (BOT_USERNAME || '').toLowerCase();
  for (const a of mentioned) {
    if (a === botAcc) continue;
    const p = getProfile(a);
    if (p) profNotes.push(`ข้อมูลของ acc ${a}: ชื่อ "${p.name || '-'}" ตำแหน่ง "${p.position || '-'}"`);
  }
  const extraNotes = filteredNotes.concat(profNotes);

  pushHistory(userId, 'user', text);
  await sendTyping(chatId);

  const history = getHistory(userId).slice();

  try {
    const result = await callVyce(history, SYSTEM_PROMPT, extraNotes);
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
    if (/conflict/i.test(e.message)) {
      log('⚠️ CONFLICT: another instance is polling token for @%s. Stop the duplicate OR rotate the token in @BotFather, then redeploy. Retry in 10s', BOT_USERNAME);
      await new Promise(r => setTimeout(r, 10000));
    } else {
      log('poll error: %s — retry in 5s', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
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
      profiles: profiles.size,
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
  loadConfig();
  loadProfiles();

  healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    log('health server on :%d', HEALTH_PORT);
  });

  const me = await tg('getMe');
  BOT_USERNAME = me.username;
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
