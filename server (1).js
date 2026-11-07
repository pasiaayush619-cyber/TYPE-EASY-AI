'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- Configuration (secrets come ONLY from environment variables) ----------
const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const TEXT_MODEL = process.env.TEXT_MODEL || 'gemini-3.1-flash-lite';
const FALLBACK_TEXT_MODEL = process.env.FALLBACK_TEXT_MODEL || 'gemini-2.5-flash';
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gemini-2.5-flash-image';
const DAILY_TEXT_LIMIT = Number(process.env.DAILY_TEXT_LIMIT) || 200;  // chat messages per user per UTC day
const DAILY_IMAGE_LIMIT = Number(process.env.DAILY_IMAGE_LIMIT) || 10; // successful images per user per UTC day
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';                 // only behind a trusted proxy (Replit, Render, etc.)
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const MAX_BODY_BYTES = 8 * 1024 * 1024;   // room for one base64 image
const MAX_STATE_BYTES = 6 * 1024 * 1024;  // saved chats + preferences per user
const MAX_IMAGE_CHARS = 5.6 * 1024 * 1024; // about 4 MB of image data
const IMAGE_DATA_RE = /^data:(image\/(jpeg|png|webp|gif)|application\/pdf);base64,[A-Za-z0-9+/=]+$/;
const SESSION_DAYS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// Small assets are built into the server, so the project needs only server.js and public/index.html.
const INLINE_ASSETS = {
  '/manifest.webmanifest': {
    type: MIME['.webmanifest'],
    body: JSON.stringify({
      name: 'TYPE EASY AI',
      short_name: 'TYPE EASY',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#0b0d12',
      theme_color: '#0b0d12',
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
    })
  },
  '/icon.svg': {
    type: MIME['.svg'],
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#4cc9f0"/><stop offset="1" stop-color="#7b61ff"/></linearGradient></defs>' +
      '<rect width="512" height="512" rx="120" fill="#0b0d12"/>' +
      '<rect x="64" y="64" width="384" height="384" rx="96" fill="url(#g)"/>' +
      '<text x="256" y="300" font-family="system-ui, Arial, sans-serif" font-size="180" font-weight="800" ' +
      'text-anchor="middle" fill="#ffffff">TE</text></svg>'
  }
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join('; ');

const BASE_SYSTEM =
  'You are TYPE EASY AI, a helpful, accurate and friendly assistant. Answer clearly and concisely. ' +
  'If you are not sure about something, say so instead of guessing. ' +
  'Make answers easy to see: use short headings, bullet or numbered lists, and Markdown tables when comparing things. ' +
  'When the user attaches an image, look at it carefully, describe what is actually visible, and answer the question about it. ' +
  'Never invent details that are not in the image; say when something is unclear.';

const MODE_INSTRUCTIONS = {
  chat: '',
  poem: 'The user wants a poem. Write an original poem with a short title and a clear rhythm. Keep it easy to read. Never copy existing copyrighted poems or song lyrics.',
  joke: 'The user wants jokes. Give clean, family-friendly, original jokes, each with a small emoji. Never tell jokes that insult or hurt any group of people.',
  company: 'The user wants information about a company or brand: founding year, founders, important history, main products, current leadership and recent news. Use the web search tool for current facts, give years where possible, and say when you are unsure.',
  news: 'The user wants current affairs or news. Use the web search tool for anything recent. Give dates for every event, name the source, and say clearly when search results are missing or unclear. Never guess a date or a result.',
  people: 'The user wants information about a public person (creator, actor, singer, politician, sportsperson, etc.). Use the web search tool for current roles, recent work and news. Stick to facts, say when information may be outdated, and never invent details about any person.',
  recipe: 'The user wants a recipe. Give: a short title, servings, prep and cook time, an ingredients table with quantities, numbered step-by-step instructions, and a few tips. Use metric and US units when helpful.',
  prompt: 'The user wants help writing a better prompt for an AI tool. Ask at most two short questions only if essential; otherwise write one improved, ready-to-copy prompt inside a code block, then briefly explain what you improved.',
  code: 'The user wants programming help. Give correct, complete code in fenced code blocks with the language named, and briefly explain the key points.',
  story: 'The user wants creative writing. Write vivid, well-structured text or stories, following any requested tone, length, or characters.',
  translate: 'The user wants translation. Detect the source language and translate exactly as requested. Give the translation first; add notes only if they help.',
  explain: 'The user wants an educational explanation. Explain step by step, starting from the basics, with a simple example and a short summary.'
};

const LANGUAGES = ['English', 'Hindi', 'Urdu', 'Bengali', 'Spanish', 'French', 'German', 'Arabic', 'Portuguese', 'Chinese', 'Japanese', 'Russian'];
const WEB_MODES = new Set(['news', 'people', 'company']);
const EASY_RULE = 'Use very simple words and short sentences, like explaining to a young child. Add relevant emoji (for example 🙂 📚 ✅ 💡) to make the answer friendly, but do not overuse them. Explain hard words in brackets.';

// ---------- Small helpers ----------
function today() {
  return new Date().toISOString().slice(0, 10); // UTC date, limits reset at 00:00 UTC
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sendJson(res, status, obj, extraHeaders) {
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extraHeaders || {}));
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) {
      return reject(httpError(415, 'Requests must be sent as JSON.'));
    }
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(httpError(413, 'Message is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(httpError(400, 'Invalid request format.'));
        }
        resolve(parsed);
      } catch {
        reject(httpError(400, 'Invalid request format.'));
      }
    });
    req.on('error', () => reject(httpError(400, 'Bad request.')));
  });
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// Simple per-IP limit for the free public weather lookups (protects the free services).
const weatherHits = new Map();
function weatherRateOk(ip) {
  const now = Date.now();
  const hits = (weatherHits.get(ip) || []).filter((t) => now - t < 60000);
  if (hits.length >= 30) return false;
  hits.push(now);
  weatherHits.set(ip, hits);
  return true;
}

// ---------- Data store (users, sessions, saved chats) ----------
// Stored in data/store.json. Write is atomic (temp file, then rename) and serialized.
// Keep the data/ folder private and out of any shared or public copy of the project.
let store = { users: {}, sessions: {} };

function loadStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    store = {
      users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
    };
  } catch (err) {
    // Refuse to start rather than overwrite a damaged file and lose every user's data.
    console.error('data/store.json is damaged. Fix or move the file, then start again.');
    throw err;
  }
}

let saveChain = Promise.resolve();
function saveStore() {
  const snapshot = JSON.stringify(store);
  saveChain = saveChain.then(() => new Promise((resolve, reject) => {
    const tmp = STORE_FILE + '.tmp';
    fs.writeFile(tmp, snapshot, (err) => {
      if (err) return reject(err);
      fs.rename(tmp, STORE_FILE, (renameErr) => (renameErr ? reject(renameErr) : resolve()));
    });
  })).catch((err) => console.error('Could not save data:', err.message));
  return saveChain;
}

// ---------- Passwords and sessions ----------
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt.toString('hex')}$${key.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3) return Promise.resolve(false);
  return new Promise((resolve) => {
    crypto.scrypt(password, Buffer.from(parts[1], 'hex'), 64, (err, key) => {
      if (err) return resolve(false);
      const expected = Buffer.from(parts[2], 'hex');
      resolve(expected.length === key.length && crypto.timingSafeEqual(key, expected));
    });
  });
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // ignore malformed cookie
      }
    }
  });
  return out;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  store.sessions[sha256(token)] = { userId, expires: Date.now() + SESSION_DAYS * 86400000 };
  return token;
}

function currentUser(req) {
  const token = parseCookies(req.headers.cookie).te_session;
  if (!token) return null;
  const key = sha256(token);
  const session = store.sessions[key];
  if (!session) return null;
  if (session.expires < Date.now()) {
    delete store.sessions[key];
    return null;
  }
  return store.users[session.userId] || null;
}

function isSecure(req) {
  return TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(req, res, token) {
  const secure = isSecure(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `te_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

function clearSessionCookie(req, res) {
  const secure = isSecure(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `te_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
}

// ---------- Daily credits (per user, counted only on success) ----------
// "pending" holds requests that are still running, so parallel requests cannot go past the limit.
const pending = new Map();

function todayUsage(user) {
  const day = today();
  if (!user.usage || user.usage.date !== day) user.usage = { date: day, text: 0, image: 0 };
  return user.usage;
}

function limitFor(kind) {
  return kind === 'image' ? DAILY_IMAGE_LIMIT : DAILY_TEXT_LIMIT;
}

function credits(user) {
  const usage = todayUsage(user);
  return {
    text: Math.max(0, DAILY_TEXT_LIMIT - usage.text),
    image: Math.max(0, DAILY_IMAGE_LIMIT - usage.image)
  };
}

function reserveCredit(user, kind) {
  const key = `${user.id}|${kind}`;
  const used = todayUsage(user)[kind] + (pending.get(key) || 0);
  if (used >= limitFor(kind)) {
    const what = kind === 'image' ? 'images' : 'chat messages';
    throw httpError(429, `You have used your ${limitFor(kind)} free ${what} for today. The limit resets at midnight UTC.`);
  }
  pending.set(key, (pending.get(key) || 0) + 1);
  return key;
}

function finishCredit(key, user, kind, succeeded) {
  const left = (pending.get(key) || 1) - 1;
  if (left > 0) pending.set(key, left); else pending.delete(key);
  if (succeeded) {
    todayUsage(user)[kind] += 1;
    saveStore();
  }
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw httpError(401, 'Please log in first.');
  return user;
}

// ---------- Auth routes ----------
const EMAIL_LOWER = (value) => String(value || '').trim().toLowerCase();

async function handleRegister(req, res) {
  const body = await readJson(req);
  const email = EMAIL_LOWER(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!EMAIL_RE.test(email) || email.length > 254) throw httpError(400, 'Please enter a valid email address.');
  if (password.length < 8 || password.length > 200) throw httpError(400, 'Password must be 8 to 200 characters.');

  const passwordHash = await hashPassword(password);
  // Check for duplicates only after the await, so two sign-ups cannot slip through together.
  if (Object.values(store.users).some((u) => u.email === email)) {
    throw httpError(409, 'This email is already registered. Please log in instead.');
  }
  const id = crypto.randomUUID();
  const user = { id, email, name: email.split('@')[0], passwordHash, createdAt: Date.now(), usage: null, state: null };
  store.users[id] = user;
  const token = createSession(id);
  await saveStore();
  setSessionCookie(req, res, token);
  return sendJson(res, 201, { user: publicUser(user), credits: credits(user) });
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const email = EMAIL_LOWER(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const user = Object.values(store.users).find((u) => u.email === email);
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!ok) throw httpError(401, 'Email or password is wrong.');
  const token = createSession(user.id);
  await saveStore();
  setSessionCookie(req, res, token);
  return sendJson(res, 200, { user: publicUser(user), credits: credits(user) });
}

async function handleLogout(req, res) {
  const token = parseCookies(req.headers.cookie).te_session;
  if (token) {
    delete store.sessions[sha256(token)];
    await saveStore();
  }
  clearSessionCookie(req, res);
  return sendJson(res, 200, { ok: true });
}

// ---------- Saved chats and preferences (synced per account) ----------
function handleGetState(req, res) {
  const user = requireUser(req);
  return sendJson(res, 200, { state: user.state || null });
}

async function handlePutState(req, res) {
  const user = requireUser(req);
  const body = await readJson(req);
  if (!body.state || typeof body.state !== 'object') throw httpError(400, 'State must be an object.');
  const size = Buffer.byteLength(JSON.stringify(body.state), 'utf8');
  if (size > MAX_STATE_BYTES) throw httpError(413, 'Your saved chats are too large. Delete some old chats or images.');
  user.state = body.state;
  await saveStore();
  return sendJson(res, 200, { ok: true });
}

// ---------- Message handling ----------
function sanitizeMessages(input) {
  if (!Array.isArray(input)) throw httpError(400, 'Messages must be a list.');
  const cleaned = input
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && (m.content.trim() || m.image))
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000), image: m.image }))
    .slice(-16);

  // Merge consecutive turns with the same role, since the API expects alternating turns.
  const merged = [];
  for (const m of cleaned) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = [last.content, m.content].filter(Boolean).join('\n\n');
      if (m.image) last.image = m.image;
    } else {
      merged.push({ ...m });
    }
  }
  // The conversation must begin and end with a user turn.
  while (merged.length && merged[0].role !== 'user') merged.shift();
  if (!merged.length || merged[merged.length - 1].role !== 'user') {
    throw httpError(400, 'Please type a message first.');
  }
  for (const m of merged) {
    if (m.image === undefined) continue;
    if (typeof m.image !== 'string' || m.image.length > MAX_IMAGE_CHARS || !IMAGE_DATA_RE.test(m.image)) {
      throw httpError(400, 'Unsupported or too large attachment. Use a JPG, PNG, WEBP or PDF under 4 MB.');
    }
  }
  // Only the newest attachment is sent to the AI, to keep requests small and cheap.
  merged.forEach((m, i) => { if (i !== merged.length - 1) delete m.image; });
  return merged;
}

function toGeminiContents(messages) {
  return messages.map((m) => {
    const parts = [];
    if (m.image) {
      const match = /^data:([a-z/\-]+);base64,(.+)$/.exec(m.image);
      parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
    if (m.content) parts.push({ text: m.content });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
}

function buildChatPayload(messages, mode, language, easy, place, memory) {
  const memoryRule = sanitizeMemory(memory);
  const languageRule = language && language !== 'English'
    ? `Write your whole answer in ${language}, using correct grammar and script.`
    : '';
  const placeRule = place
    ? `The user is near ${place}. Use this only when it is relevant, for example for local places or weather.`
    : '';
  const system = [
    BASE_SYSTEM,
    `Today's date is ${today()}.`,
    MODE_INSTRUCTIONS[mode],
    languageRule,
    easy ? EASY_RULE : '',
    placeRule,
    memoryRule
  ].filter(Boolean).join('\n\n');
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toGeminiContents(messages),
    generationConfig: { maxOutputTokens: 2048 }
  };
  // Gemini's built-in Google Search grounding supports search-enabled modes.
  if (WEB_MODES.has(mode)) payload.tools = [{ google_search: {} }];
  return payload;
}
// Memory notes the user chose (saved in the account). Sent with every chat so the AI remembers them.
function sanitizeMemory(memory) {
  if (!Array.isArray(memory)) return '';
  const items = memory
    .filter((m) => typeof m === 'string')
    .map((m) => m.replace(/\s+/g, ' ').trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 30);
  return items.length
    ? `Things to remember about this user (use them naturally when relevant; never list them unless asked):\n${items.map((m) => '- ' + m).join('\n')}`
    : '';
}

// Live Gemini streaming: text is forwarded to the browser the moment it arrives.
// If a model is busy or missing, the next model is tried. Nothing is re-sent once text has started.
async function streamGeminiLive(payload, onText, signal) {
  const models = [...new Set([TEXT_MODEL, FALLBACK_TEXT_MODEL].filter(Boolean))];
  let lastError = null;

  for (const model of models) {
    if (signal?.aborted) throw httpError(499, 'Request was cancelled.');

    // Thinking delays the first word. Gemini 3 uses thinkingLevel; Gemini 2.5 uses thinkingBudget.
    // Both are set to the fastest option.
    const body = { ...payload };
    if (/gemini-3/.test(model)) {
      body.generationConfig = { ...payload.generationConfig, thinkingConfig: { thinkingLevel: 'minimal' } };
    } else if (/gemini-2\.5/.test(model)) {
      body.generationConfig = { ...payload.generationConfig, thinkingConfig: { thinkingBudget: 0 } };
    }

    let upstream;
    try {
      upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
          body: JSON.stringify(body),
          signal
        }
      );
    } catch (error) {
      if (signal?.aborted) throw httpError(499, 'Request was cancelled.');
      console.error(`Gemini connection error (${model}):`, error.message);
      lastError = { status: 504 };
      continue;
    }

    if (!upstream.ok) {
      const data = await upstream.json().catch(() => ({}));
      console.error(`Gemini model ${model} error:`, upstream.status, data?.error?.message);
      if ([404, 429, 500, 502, 503].includes(upstream.status)) {
        lastError = { status: upstream.status };
        continue;
      }
      if (upstream.status === 401 || upstream.status === 403) throw httpError(502, 'Please check your Gemini API key.');
      throw httpError(502, 'Gemini returned an error. Please try again.');
    }

    let full = '';
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line.startsWith('data:')) continue;
          let obj;
          try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (obj.error) throw httpError(502, obj.error.message || 'Gemini returned an error.');
          const text = (obj.candidates?.[0]?.content?.parts || [])
            .map((p) => (typeof p.text === 'string' ? p.text : ''))
            .join('');
          if (text) {
            full += text;
            onText(text);
          }
        }
      }
    } catch (error) {
      if (error.status) throw error;
      if (signal?.aborted) throw httpError(499, 'Request was cancelled.');
      console.error(`Gemini stream interrupted (${model}):`, error.message);
    }

    if (full.trim()) return full.trim();
    lastError = { status: 502 }; // empty answer: try the next model
  }

  console.error('All Gemini models failed:', lastError);
  if (lastError?.status === 429) throw httpError(429, 'Gemini quota reached. Please try again later.');
  if ([500, 502, 503].includes(lastError?.status)) {
    throw httpError(503, 'Gemini is busy right now. Please try again in a moment.');
  }
  throw httpError(504, 'All Gemini models failed. Please try again later.');
}

async function handleChat(req, res, stream) {
  const user = requireUser(req);
  if (!GEMINI_API_KEY) throw httpError(503, 'Gemini chat is not configured on this server yet.');
  const body = await readJson(req);
  const messages = sanitizeMessages(body.messages);
  const mode = typeof body.mode === 'string' && Object.prototype.hasOwnProperty.call(MODE_INSTRUCTIONS, body.mode) ? body.mode : 'chat';
  const language = LANGUAGES.includes(body.language) ? body.language : 'English';
  const easy = body.easy === true;
  const place = typeof body.place === 'string' ? body.place.trim().slice(0, 120) : '';
  const memory = Array.isArray(body.memory) ? body.memory : [];
  const payload = buildChatPayload(messages, mode, language, easy, place, memory);

  const key = reserveCredit(user, 'text');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  if (!stream) {
    let reply = '';
    try {
      reply = await streamGeminiLive(payload, (t) => { reply += t; }, controller.signal);
      if (!reply) throw httpError(502, 'The AI returned an empty response. Please try again.');
    } catch (err) {
      finishCredit(key, user, 'text', false);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    finishCredit(key, user, 'text', true);
    return sendJson(res, 200, { reply, credits: credits(user) });
  }

  // Streaming: we send the response headers only after the AI has accepted the request.
  let started = false;
  let streamed = '';
  try {
    streamed = await streamGeminiLive(payload, (text) => {
      if (!started) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        started = true;
      }
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }, controller.signal);
    if (!streamed) throw httpError(502, 'The AI returned an empty response. Please try again.');
    finishCredit(key, user, 'text', true);
    if (!started) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    }
    res.write(`data: ${JSON.stringify({ done: true, credits: credits(user) })}\n\n`);
    res.end();
  } catch (err) {
    finishCredit(key, user, 'text', false);
    if (!started) throw err; // nothing sent yet: normal JSON error
    res.write(`data: ${JSON.stringify({ error: err.message || 'Something went wrong.' })}\n\n`);
    res.end();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Image generation (Google Gemini free image model) ----------
async function callGeminiImage(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(IMAGE_MODEL)}:generateContent`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] }
      }),
      signal: AbortSignal.timeout(120000)
    });
  } catch {
    throw httpError(504, 'Image generation timed out. Please try again.');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Gemini image error:', response.status, data?.error?.message);
    if (response.status === 429) throw httpError(429, 'The free image service is busy right now. Please try again later.');
    throw httpError(502, 'Image generation failed. Try a different description.');
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const part = parts.find((p) => p.inlineData || p.inline_data);
  const inline = part ? (part.inlineData || part.inline_data) : null;
  if (!inline || !inline.data) {
    throw httpError(502, 'The image service returned no picture. Try a different description.');
  }
  const mime = inline.mimeType || inline.mime_type || 'image/png';
  return `data:${mime};base64,${inline.data}`;
}

async function handleImage(req, res) {
  const user = requireUser(req);
  if (!GEMINI_API_KEY) throw httpError(503, 'Image generation is not configured on this server yet.');
  const body = await readJson(req);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length < 3 || prompt.length > 1000) throw httpError(400, 'Please describe the image in 3 to 1000 characters.');

  const key = reserveCredit(user, 'image');
  try {
    const image = await callGeminiImage(prompt);
    finishCredit(key, user, 'image', true);
    return sendJson(res, 200, { image, credits: credits(user) });
  } catch (err) {
    finishCredit(key, user, 'image', false); // failed images are not counted
    throw err;
  }
}

// ---------- Weather and location (free public services, no key) ----------
const WEATHER_CODES = {
  0: ['Clear sky', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌦️'],
  61: ['Light rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'],
  80: ['Rain showers', '🌦️'], 81: ['Rain showers', '🌧️'], 82: ['Heavy showers', '⛈️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm with hail', '⛈️'], 99: ['Thunderstorm with hail', '⛈️']
};

function parseCoord(value, min, max) {
  const n = Number(value);
  return value !== null && Number.isFinite(n) && n >= min && n <= max ? n : null;
}

async function getWeather(lat, lon) {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.searchParams.set('latitude', String(lat));
  u.searchParams.set('longitude', String(lon));
  u.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m');
  u.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min');
  u.searchParams.set('timezone', 'auto');
  u.searchParams.set('forecast_days', '3');

  let response;
  try {
    response = await fetch(u, { signal: AbortSignal.timeout(15000) });
  } catch {
    throw httpError(504, 'The weather service is unreachable. Please try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.current) throw httpError(502, 'Weather could not be loaded right now.');

  const info = (code) => WEATHER_CODES[code] || ['Unknown', '🌡️'];
  const now = info(data.current.weather_code);
  const days = (data.daily?.time || []).map((date, i) => {
    const w = info(data.daily.weather_code[i]);
    return { date, max: data.daily.temperature_2m_max[i], min: data.daily.temperature_2m_min[i], text: w[0], icon: w[1] };
  });
  return {
    now: {
      temp: data.current.temperature_2m,
      feels: data.current.apparent_temperature,
      humidity: data.current.relative_humidity_2m,
      wind: data.current.wind_speed_10m,
      precipitation: data.current.precipitation,
      text: now[0],
      icon: now[1]
    },
    days
  };
}

async function getPlace(lat, lon) {
  const u = new URL('https://nominatim.openstreetmap.org/reverse');
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('lat', String(lat));
  u.searchParams.set('lon', String(lon));
  u.searchParams.set('zoom', '10');
  u.searchParams.set('accept-language', 'en');
  try {
    const response = await fetch(u, {
      headers: { 'User-Agent': 'TYPE-EASY-AI/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json();
    const a = data.address || {};
    const city = a.city || a.town || a.village || a.county || a.state || 'your area';
    return [city, a.country].filter(Boolean).join(', ');
  } catch {
    return 'your area';
  }
}

// ---------- Routing ----------
async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  if (method === 'GET' && p === '/api/config') {
    const user = currentUser(req);
    return sendJson(res, 200, {
      model: TEXT_MODEL,
      textEnabled: Boolean(GEMINI_API_KEY),
      imageEnabled: Boolean(GEMINI_API_KEY),
      limits: { text: DAILY_TEXT_LIMIT, image: DAILY_IMAGE_LIMIT },
      user: user ? publicUser(user) : null,
      credits: user ? credits(user) : null
    });
  }

  if (method === 'POST' && p === '/api/auth/register') return handleRegister(req, res);
  if (method === 'POST' && p === '/api/auth/login') return handleLogin(req, res);
  if (method === 'POST' && p === '/api/auth/logout') return handleLogout(req, res);

  if (method === 'GET' && p === '/api/auth/me') {
    const user = requireUser(req);
    return sendJson(res, 200, { user: publicUser(user), credits: credits(user) });
  }

  if (method === 'GET' && p === '/api/state') return handleGetState(req, res);
  if ((method === 'PUT' || method === 'POST') && p === '/api/state') return handlePutState(req, res);

  if (method === 'GET' && p === '/api/weather') {
    if (!weatherRateOk(clientIp(req))) throw httpError(429, 'Too many weather requests. Please wait a minute.');
    const lat = parseCoord(url.searchParams.get('lat'), -90, 90);
    const lon = parseCoord(url.searchParams.get('lon'), -180, 180);
    if (lat === null || lon === null) throw httpError(400, 'Your location is missing or invalid.');
    const [weather, place] = await Promise.all([getWeather(lat, lon), getPlace(lat, lon)]);
    return sendJson(res, 200, Object.assign({ place }, weather));
  }

  if (method === 'POST' && p === '/api/chat') return handleChat(req, res, false);
  if (method === 'POST' && p === '/api/chat/stream') return handleChat(req, res, true);
  if (method === 'POST' && p === '/api/image') return handleImage(req, res);

  throw httpError(404, 'Not found.');
}

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad request');
  }
  if (pathname === '/') pathname = '/index.html';

  if (Object.prototype.hasOwnProperty.call(INLINE_ASSETS, pathname)) {
    const asset = INLINE_ASSETS[pathname];
    res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    return res.end(req.method === 'HEAD' ? undefined : asset.body);
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const headers = {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    };
    if (path.extname(filePath) === '.html') headers['Content-Security-Policy'] = CSP;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const allowed = ['GET', 'POST', 'PUT'];
      if (!allowed.includes(req.method)) throw httpError(405, 'Method not allowed.');
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method not allowed.');
    return serveStatic(req, res, url);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (res.headersSent) {
      res.end();
    } else {
      sendJson(res, status, { error: status === 500 ? 'Something went wrong. Please try again.' : err.message });
    }
  }
});

loadStore();
server.listen(PORT, () => {
  console.log(`TYPE EASY AI running on http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) console.warn('Warning: GEMINI_API_KEY is not set. Chat and image generation will be unavailable.');
  
});
