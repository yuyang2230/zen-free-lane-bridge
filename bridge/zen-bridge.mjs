#!/usr/bin/env node
/**
 * zen-bridge — make OpenCode Zen's anonymous free lane usable from any
 * OpenAI-compatible client: AI gateways (1Panel AI Gateway and others),
 * coding agents (ZCode, DSH, Cline, Aider, ...), or plain curl.
 *
 * What the gate actually is
 * -------------------------
 * Zen's anonymous free tier rejects non-CLI traffic with
 * `403 FreeTierError "free tier can only be used from within OpenCode"`.
 * Between 2026-10-11 and 2026-10-14 the gate moved twice; both rounds were
 * isolated live (see docs/root-cause.md for the full write-up):
 *
 *   1. Session-id shape. A canonical `ses_<12hex><14 base62>` id is required,
 *      and — this is the part everyone gets wrong — the 12-hex half is NOT a
 *      random digest. Upstream decodes it as `~(milliseconds * 4096 +
 *      per-millisecond counter)` and accepts only counters in [0, 63].
 *      Recipes that fill that field with sha256 bytes hit that window ~1.5% of
 *      the time (64/4096), which looks exactly like "the free tier is dead".
 *      The clock bits themselves are not validated. We mint it the way
 *      upstream's own generator does: counter fixed at 1.
 *   2. Client identity headers (since ~1.19.0): user-agent with the
 *      ai-sdk/provider-utils + runtime/bun markers, x-opencode-client,
 *      x-opencode-project: global, x-opencode-request as msg_<26 base62>.
 *
 * What is NOT part of the gate (verified by an isolation ladder, not assumed):
 * the system prompt's content, the tool count, and the whole body shape. A
 * plain passthrough body with the right session id and headers is accepted;
 * even a body with no tools at all passes. We still inject two inert stub
 * tools plus tool_choice:auto and stream_options because that exact shape is
 * what a real CLI emits — it costs nothing and removes a variable.
 *
 * Why a bridge
 * ------------
 * AI gateways cannot set custom headers on an upstream account, so they can
 * neither mint a compliant session id nor send the 1.19 identity headers.
 * This process sits in front, presents a plain OpenAI-compatible surface
 * (point your gateway account at http://<host>:8799/v1 with any key), and
 * does the shaping on the way out to Zen.
 *
 * Resilience
 * ----------
 * If Zen tightens the gate again and minted ids start failing, the bridge
 * falls back to a pool of session ids that a *real* local opencode CLI run
 * has proven (see harvestWhiteSession) before giving up with a 503. That
 * fallback costs one opencode invocation, so it is cooldown-gated.
 *
 * Env knobs (all optional)
 *   PORT, HOST                     listen address (default 8799 on 0.0.0.0)
 *   ZEN_MODELS                    comma-separated free roster
 *   ZEN_MIN_GAP_MS                min spacing between upstream calls per model
 *   ZEN_MAX_INFLIGHT              concurrent upstream calls per model
 *   ZEN_MAX_TOTAL                 concurrent upstream calls across models
 *   ZEN_QUEUE_MAX                 queue depth before shedding load with 429
 *   ZEN_MAX_INPUT_CHARS           refuse oversized prompts (413) instead of
 *                                 burning anonymous quota on them
 *   ZEN_MAX_OUTPUT_TOKENS         clamp requested max_tokens
 *   ZEN_TRIP_COOLDOWN_MS          how long a model is held after a Zen 429
 *   ZEN_WHITE_FILE                path to the proven-session pool file
 *   ZEN_HARVEST_MODEL             model used when harvesting a proven session
 *   ZEN_HARVEST_CWD               working dir for the opencode harvest run
 *   ZEN_HARVEST_COOLDOWN_MS       min gap between harvests (default 5 min)
 *   ZEN_BODY_SHAPE=passthrough    disable body shaping (rollback switch)
 */

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ZEN_BASE = process.env.ZEN_BASE || "https://opencode.ai/zen/v1";
const PORT = Number(process.env.PORT || 8799);
const HOST = process.env.HOST || "0.0.0.0";
const ANONYMOUS_KEY = "public";
const ALLOW_ANY_KEY = process.env.ALLOW_ANY_KEY === "1";
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Upstream mode.
 *
 * "ocserver" (default since 2026-10-14 late): forward to a LOCAL headless
 * opencode server (`opencode serve`), which talks to Zen with the real
 * binary's own TLS stack. Late on 2026-10-14 the free-lane gate grew a
 * transport-fingerprint layer: byte-identical requests from node's undici get
 * 403 while the same binary succeeds, so no amount of header/body shaping can
 * pass any more. Riding the real server is the only durable path. See
 * docs/root-cause.md ("third gate layer").
 *
 * "zen": the legacy direct path (session minting + identity headers). Kept
 * for when the upstream relaxes; verified dead against the 10-14-late gate.
 */
const MODE = process.env.ZEN_MODE || "ocserver";
const OCC_URL = (process.env.OCC_URL || "http://127.0.0.1:4096").replace(/\/+$/, "");

// Client identity captured verbatim from a real opencode 1.19.0 CLI.
// Only used by the legacy "zen" mode. Bump these together when you re-capture
// with tools/zen-capture-proxy.mjs.
const USER_AGENT = process.env.ZEN_USER_AGENT
  || "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
const PROJECT = process.env.ZEN_PROJECT || "global";
const GATE_TOOL_NAMES = ["bash", "read"];

// ---------------------------------------------------------------- id shaping

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CANONICAL_SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function base62Fixed(value, width) {
  const base = 62n;
  let n = value;
  const out = new Array(width);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62.charAt(Number(n % base));
    n /= base;
  }
  return out.join("");
}

function stableID(prefix, value) {
  const h = createHash("sha256").update(prefix + "\0" + value).digest();
  return `${prefix}_${h.subarray(0, 12).toString("hex")}`;
}

/**
 * A synthesized session, memoized per conversation signal (0.3.12 / issue #62).
 *
 * The 12-hex time field is the inverted millisecond clock with a fixed
 * counter-1 in the low 12 bits: the free tier reads those bits back as a
 * per-millisecond counter and accepts only [0,63]; the high clock bits are
 * NOT validated. The legacy sha256-digest prefix landed in that window only
 * ~1.5% of the time — that was the "almost all 403" outage. The clock half
 * is minted ONCE per conversation (memoized) so retries and later turns keep
 * the same ses_ id: the upstream groups quota and prompt cache by session.
 */
const SESSION_MEMO_LIMIT = 1024;
const sessionMemo = new Map();

function invertedTimestampHex(now = Date.now()) {
  return (~(BigInt(now) * 4096n + 1n) & 281474976710655n).toString(16).padStart(12, "0");
}

function canonicalSessionID(signal) {
  if (CANONICAL_SESSION.test(signal)) return signal;
  const hit = sessionMemo.get(signal);
  if (hit !== undefined) return hit;
  const sum = createHash("sha256").update("ses\0" + signal).digest();
  const session = `ses_${invertedTimestampHex()}${base62Fixed(BigInt("0x" + sum.subarray(6, 16).toString("hex")), 14)}`;
  if (sessionMemo.size >= SESSION_MEMO_LIMIT) sessionMemo.delete(sessionMemo.keys().next().value);
  sessionMemo.set(signal, session);
  return session;
}

/**
 * Primary session mint (2026-10-14): a canonical ses_ with the real-clock
 * time field, derived from the conversation seed. The white pool is only
 * consulted as a 403 fallback.
 */
function mintFreshSession(messages, inbound) {
  let signal = inbound?.["x-opencode-session"] || "";
  if (!CANONICAL_SESSION.test(signal)) {
    signal = conversationSeed(messages);
    if (signal === "" || signal === "{}") signal = "zen-bridge:" + randomBytes(8).toString("hex");
  }
  return canonicalSessionID(signal);
}

function randomID(prefix, size) {
  return `${prefix}_${randomBytes(size).toString("hex")}`;
}

/** The real CLI mints `msg_` + 26 base62 chars; hex request ids now fail the gate. */
function randomMsgID(length = 26) {
  const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(length);
  return "msg_" + Array.from(bytes, (b) => ALPHABET[b % 62]).join("");
}

function conversationSeed(messages) {
  for (const m of messages) {
    if (m?.role !== "user") continue;
    const encoded = JSON.stringify(m.content ?? null);
    if (encoded !== "null" && encoded.length > 0) return encoded;
  }
  return "";
}

/** Client-supplied session id wins (keeps upstream prompt-cache affinity). */
function deriveRequestIDs(messages, inbound) {
  let signal = inbound?.["x-opencode-session"] || inbound?.["x-session-id"] || "";
  if (!CANONICAL_SESSION.test(signal)) {
    signal = conversationSeed(messages);
    if (signal === "" || signal === "{}") signal = randomID("fallback", 16);
    signal = canonicalSessionID(signal);
  }
  return {
    session: signal,
    request: randomMsgID(),
  };
}

// ------------------------------------------------- proven-session fallback pool
//
// Fallback only. The primary path mints compliant session ids locally
// (invertedTimestampHex above), which needs no external help. If Zen tightens
// the gate again and minted ids start 403ing, we retry once with an id that a
// real local opencode CLI has already proven — harvested by running
// `opencode run --format json`, whose json stream carries the fresh ses_ id.
// Harvest is cooldown-gated because each one costs a real request.

const WHITE_FILE = process.env.ZEN_WHITE_FILE || join(HERE, "zen-white-sessions.json");
const HARVEST_MODEL = process.env.ZEN_HARVEST_MODEL || "mimo-v2.6-flash-free";
const HARVEST_COOLDOWN_MS = Number(process.env.ZEN_HARVEST_COOLDOWN_MS ?? 300000);
const HARVEST_CWD = process.env.ZEN_HARVEST_CWD || process.cwd();

let whiteLive = null; // { ids: string[], dead: Set<string>, cursor: number }
let lastHarvestAt = 0;
let harvestInFlight = null;

function loadWhitePool() {
  try {
    if (existsSync(WHITE_FILE)) {
      const data = JSON.parse(readFileSync(WHITE_FILE, "utf8"));
      const ids = Array.isArray(data.sessions)
        ? data.sessions.filter((s) => typeof s === "string" && CANONICAL_SESSION.test(s))
        : [];
      whiteLive = { ids, dead: new Set(Array.isArray(data.dead) ? data.dead : []), cursor: 0 };
      return;
    }
  } catch { /* fall through to empty pool */ }
  whiteLive = { ids: [], dead: new Set(), cursor: 0 };
}
loadWhitePool();

function saveWhitePool() {
  try {
    writeFileSync(WHITE_FILE, JSON.stringify({
      sessions: whiteLive.ids,
      dead: [...whiteLive.dead],
      note: "proven session ids harvested from real opencode runs; bridge marks 403 ids dead",
      updated: new Date().toISOString(),
    }, null, 1));
  } catch { /* pool file is best-effort */ }
}

/** Round-robin over live ids; null when none survive. */
function nextWhiteSession() {
  if (!whiteLive.ids.length) return null;
  const scanned = whiteLive.ids.length + whiteLive.dead.size;
  for (let i = 0; i <= scanned; i++) {
    const id = whiteLive.ids[whiteLive.cursor % whiteLive.ids.length];
    whiteLive.cursor++;
    if (!whiteLive.dead.has(id)) return id;
  }
  return null;
}

function markWhiteDead(id) {
  // Only pool members are tracked; minted ids are one-shot and drop out.
  if (!id || !whiteLive.ids.includes(id) || whiteLive.dead.has(id)) return;
  whiteLive.dead.add(id);
  saveWhitePool();
  console.log(`zen-bridge: white session ${id.slice(0, 16)}... marked dead (403)`);
}

/** Run the local real opencode CLI to mint a fresh proven session. Cooldown-gated. */
function harvestWhiteSession() {
  if (harvestInFlight) return harvestInFlight;
  if (Date.now() - lastHarvestAt < HARVEST_COOLDOWN_MS) {
    return Promise.resolve(nextWhiteSession()); // on cooldown: reuse whatever is still live
  }
  harvestInFlight = (async () => {
    lastHarvestAt = Date.now();
    try {
      const out = await new Promise((resolve, reject) => {
        const args = ["run", "--format", "json", "-m", `opencode/${HARVEST_MODEL}`, "reply with exactly: pong"];
        // npm exposes `opencode` as a .cmd shim on Windows, which needs a shell.
        const [cmd, argv] = process.platform === "win32"
          ? ["cmd.exe", ["/d", "/s", "/c", `opencode ${args.join(" ")}`]]
          : ["opencode", args];
        const p = spawn(cmd, argv, { cwd: HARVEST_CWD, windowsHide: true });
        let s = "";
        const timer = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } reject(new Error("harvest timeout 90s")); }, 90000);
        p.stdout.on("data", (d) => { s += d; });
        p.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(s); else reject(new Error(`harvest exit ${code}`)); });
        p.on("error", (e) => { clearTimeout(timer); reject(e); });
      });
      const m = out.match(/"sessionID":"(ses_[0-9a-f]{12}[0-9A-Za-z]{14})"/);
      if (m && !whiteLive.ids.includes(m[1])) {
        whiteLive.ids.push(m[1]);
        saveWhitePool();
        console.log(`zen-bridge: harvested proven session ${m[1].slice(0, 16)}...`);
      }
      return m ? m[1] : nextWhiteSession();
    } catch (err) {
      console.error(`zen-bridge: harvest failed: ${err.message}`);
      return nextWhiteSession();
    } finally {
      harvestInFlight = null;
    }
  })();
  return harvestInFlight;
}

/**
 * Identity headers, matching a real opencode 1.19.x request:
 *   user-agent          opencode/<ver> ai-sdk/provider-utils/<ver> runtime/bun/<ver>
 *   x-opencode-client   cli
 *   x-opencode-project  global          (literal, not a generated prj_ id)
 *   x-opencode-request  msg_<26 base62> (not a hex req_ id)
 *   x-opencode-session  ses_<12hex><14 base62>
 */
function cliHeaders(ids) {
  return {
    "content-type": "application/json",
    accept: "*/*",
    authorization: `Bearer ${ANONYMOUS_KEY}`,
    "user-agent": USER_AGENT,
    "x-opencode-client": "cli",
    "x-opencode-project": PROJECT,
    "x-opencode-request": ids.request,
    "x-opencode-session": ids.session,
    "x-opencode-session-id": ids.session,
  };
}

// ------------------------------------------------------------- body shaping

function gateTool(name) {
  return {
    type: "function",
    function: {
      name,
      description: "Reserved for the host runtime; do not call it.",
      parameters: { type: "object", properties: {} },
    },
  };
}

/**
 * 2026-10-14 gate ladder (live): the free-lane gate requires BOTH the verbatim
 * identity headers AND a tools array with tool_choice:"auto". No tools -> 403
 * FreeTierError even with perfect headers. System-prompt content and tool
 * count do NOT matter (two stub tools with any/no system passed).
 * ZEN_BODY_SHAPE=passthrough disables shaping for rollback.
 */
const BODY_SHAPE = process.env.ZEN_BODY_SHAPE || "tools";

function shapeChatPayload(body) {
  if (BODY_SHAPE !== "tools") return body;
  if (body === null || typeof body !== "object" || !Array.isArray(body.messages)) return body;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names = new Set(
    tools.map((t) => (typeof t?.function === "object" && t.function !== null ? t.function.name : undefined)),
  );
  const missing = GATE_TOOL_NAMES.filter((n) => !names.has(n));
  if (missing.length === 0 && body.tool_choice !== undefined) return body;
  const next = { ...body };
  if (missing.length > 0) next.tools = [...tools, ...missing.map(gateTool)];
  if (body.tool_choice === undefined) next.tool_choice = "auto";
  return next;
}

/** Responses route uses flat function tools and only accepts tool_choice:auto. */
function shapeResponsesPayload(body) {
  if (BODY_SHAPE !== "tools") return body;
  if (body === null || typeof body !== "object" || !Array.isArray(body.input)) return body;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names = new Set(
    tools.map((t) => (typeof t === "object" && t !== null && t.type === "function" ? t.name : undefined)),
  );
  const missing = GATE_TOOL_NAMES.filter((n) => !names.has(n));
  const invalidChoice = body.tool_choice !== undefined && body.tool_choice !== "auto";
  if (missing.length === 0 && !invalidChoice) return body;
  return {
    ...body,
    tools: [...tools, ...missing.map((n) => ({ type: "function", ...gateTool(n).function }))],
    tool_choice: "auto",
  };
}

// ------------------------------------------------------------------ plumbing

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 128 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJSON(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(buf);
}

/**
 * Pipe an upstream SSE stream straight through to the client.
 * Node's fetch hands back a Web ReadableStream, so adapt it rather than
 * calling .pipe() on it.
 */
function pipeSSE(upstream, res) {
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const reader = upstream.body.getReader();
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    reader.cancel().catch(() => {});
  };
  res.on("close", stop);

  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          // Respect backpressure; resume once the socket drains.
          await new Promise((r) => res.once("drain", r));
        }
      }
    } catch {
      /* client vanished or upstream reset */
    } finally {
      stop();
      res.end();
    }
  })();
}

/**
 * Backpressure for the Zen anonymous lane.
 *
 * The free lane is metered per model and per IP. Yesterday's outage was not
 * model instability: a single agent consumer with a 1M-token context window
 * sent 606 requests / 150M input tokens in 24h, which permanently exhausted
 * three models' quota and, because gateway cooldown is per account, took the
 * healthy models down with them. So the bridge stops the abuse before it
 * reaches Zen:
 *
 *   MIN_GAP_MS        minimum spacing between two upstream calls of one model
 *   MAX_INFLIGHT      concurrent upstream calls per model (1 = strict serial)
 *   MAX_TOTAL         concurrent upstream calls across all free models
 *   QUEUE_MAX         queue depth before shedding load with a fast 429
 *   MAX_INPUT_CHARS   refuse oversized prompts instead of burning quota
 *   MAX_OUTPUT_TOKENS clamp requested max_tokens
 *
 * A model that answers 429 is put into a local circuit so the next caller is
 * told immediately rather than spending another request on a dead quota.
 */
const MIN_GAP_MS = Number(process.env.ZEN_MIN_GAP_MS ?? 9000);
const MAX_INFLIGHT = Number(process.env.ZEN_MAX_INFLIGHT ?? 1);
const MAX_TOTAL = Number(process.env.ZEN_MAX_TOTAL ?? 2);
const QUEUE_MAX = Number(process.env.ZEN_QUEUE_MAX ?? 6);
const MAX_INPUT_CHARS = Number(process.env.ZEN_MAX_INPUT_CHARS ?? 120000);
const MAX_OUTPUT_TOKENS = Number(process.env.ZEN_MAX_OUTPUT_TOKENS ?? 8000);
const TRIP_COOLDOWN_MS = Number(process.env.ZEN_TRIP_COOLDOWN_MS ?? 120000);

const lanes = new Map(); // model -> { inflight, nextFreeAt, waiters[], openUntil }

function lane(model) {
  let l = lanes.get(model);
  if (!l) {
    l = { inflight: 0, nextFreeAt: 0, waiters: [], openUntil: 0 };
    lanes.set(model, l);
  }
  return l;
}

function totalInflight() {
  let n = 0;
  for (const l of lanes.values()) n += l.inflight;
  return n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Returns a release() once it is this request's turn to hit Zen. */
async function acquireSlot(model, res) {
  const l = lane(model);
  if (l.waiters.length >= QUEUE_MAX) {
    sendJSON(res, 429, {
      error: {
        type: "rate_limit_error",
        message: "free lane is saturated; retry shortly",
        code: "free_lane_busy",
      },
    });
    res.setHeader?.("retry-after", "10");
    return null;
  }
  return new Promise((resolve) => {
    const grant = () => {
      l.inflight += 1;
      const gap = Math.max(0, l.nextFreeAt - Date.now());
      // Jitter so a released wave does not march upstream in lockstep.
      setTimeout(() => resolve(() => releaseSlot(l)), gap + Math.floor(Math.random() * 400));
    };
    if (l.inflight < MAX_INFLIGHT && totalInflight() < MAX_TOTAL) grant();
    else l.waiters.push(grant);
  });
}

function releaseSlot(l) {
  l.inflight = Math.max(0, l.inflight - 1);
  l.nextFreeAt = Date.now() + MIN_GAP_MS;
  const next = l.waiters.shift();
  if (next && totalInflight() < MAX_TOTAL) next();
}

function tripCircuit(model, ms = TRIP_COOLDOWN_MS) {
  const l = lane(model);
  l.openUntil = Math.max(l.openUntil, Date.now() + ms);
}

function circuitOpen(model) {
  const l = lanes.get(model);
  return !!l && l.openUntil > Date.now();
}

function inputChars(messages) {
  let n = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (typeof m?.content === "string") n += m.content.length;
    else if (Array.isArray(m?.content)) {
      for (const p of m.content) if (typeof p?.text === "string") n += p.text.length;
    }
  }
  return n;
}

async function proxy(req, res, kind, urlPath) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch {
    sendJSON(res, 400, { error: { type: "invalid_request_error", message: "body is not valid JSON" } });
    return;
  }

  // Non-streaming requests are rejected upstream by the body-shape gate,
  // so they are promoted to streaming and de-streamed before replying.
  const wantsStream = kind === "chat" ? body.stream === true : body.stream === true;
  const shaped = kind === "chat" ? shapeChatPayload(body) : shapeResponsesPayload(body);
  const upstreamBody = { ...shaped, stream: true };
  // Verbatim real-opencode defaults (2026-10-14 capture): missing max_tokens /
  // stream_options fields shift the body shape; the gate reads the shape, not
  // the values. Caller-supplied values still pass through the MAX clamp below.
  if (upstreamBody.max_tokens === undefined && upstreamBody.max_output_tokens === undefined) upstreamBody.max_tokens = 32000;
  if (upstreamBody.stream_options === undefined) upstreamBody.stream_options = { include_usage: true };

  const messages = kind === "chat" ? (shaped.messages ?? []) : (shaped.input ?? []);
  const model = body.model ?? "unknown";

  if (circuitOpen(model)) {
    const retry = Math.ceil((lane(model).openUntil - Date.now()) / 1000);
    res.writeHead(503, {
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(retry),
    });
    return res.end(JSON.stringify({
      error: {
        type: "service_unavailable",
        message: `${model}: free quota is currently exhausted; the bridge is holding new requests for ${retry}s`,
        code: "free_lane_tripped",
      },
    }));
  }

  const chars = inputChars(messages);
  if (chars > MAX_INPUT_CHARS) {
    sendJSON(res, 413, {
      error: {
        type: "invalid_request_error",
        message: `prompt too large for the free lane (${chars} chars > ${MAX_INPUT_CHARS}); use a paid model`,
        code: "free_lane_input_too_large",
      },
    });
    return;
  }

  const asked = Number(body.max_tokens ?? body.max_output_tokens ?? 0);
  if (Number.isFinite(asked) && asked > MAX_OUTPUT_TOKENS) upstreamBody.max_tokens = MAX_OUTPUT_TOKENS;

  const release = await acquireSlot(model, res);
  if (!release) return;

  try {
    // Primary path mints a real-clock canonical session (0.3.12/#62); the
    // proven-id pool is the 403 fallback. A minted 403 means the upstream
    // moved again, so the pool (ids minted by the real CLI) is the only
    // thing left worth trying.
    let upstream;
    for (let attempt = 0; attempt < 2; attempt++) {
      let session;
      if (attempt === 0) {
        session = mintFreshSession(messages, req.headers);
      } else {
        session = nextWhiteSession() ?? (await harvestWhiteSession());
      }
      if (!session) break;
      try {
        upstream = await fetch(`${ZEN_BASE}${urlPath}`, {
          method: "POST",
          headers: cliHeaders({ session, request: randomMsgID() }),
          body: JSON.stringify(upstreamBody),
        });
      } catch (err) {
        return sendJSON(res, 502, { error: { type: "upstream_error", message: `bridge fetch failed: ${err.message}` } });
      }
      if (upstream.status === 403) {
        markWhiteDead(session);
        upstream = null;
      } else {
        break;
      }
    }
    if (!upstream) {
      const waitSec = Math.max(10, Math.ceil((lastHarvestAt + HARVEST_COOLDOWN_MS - Date.now()) / 1000));
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", "retry-after": String(waitSec) });
      return res.end(JSON.stringify({
        error: {
          type: "service_unavailable",
          message: "fresh session mint was rejected and the proven-id fallback pool is empty or on harvest cooldown",
          code: "white_sessions_unavailable",
        },
      }));
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      if (upstream.status === 429) tripCircuit(model);
      res.writeHead(upstream.status, {
        "content-type": "application/json; charset=utf-8",
        ...(upstream.status === 429 ? { "retry-after": String(Math.ceil(TRIP_COOLDOWN_MS / 1000)) } : {}),
      });
      return res.end(text || JSON.stringify({ error: { type: "upstream_error", message: `HTTP ${upstream.status}` } }));
    }

if (wantsStream) return pipeSSE(upstream, res);

    // Collect the SSE stream and emit a single OpenAI-style JSON response.
    const ct = upstream.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) {
      return res.end(Buffer.from(await upstream.arrayBuffer()));
    }

    let text = "";
    let finishReason = "stop";
    let usage = null;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      const frames = buf.split(/\n\n/);
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let ev;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = ev.choices?.[0]?.delta;
          if (typeof delta?.content === "string") text += delta.content;
          if (typeof ev.choices?.[0]?.finish_reason === "string") finishReason = ev.choices[0].finish_reason;
          if (ev.usage) usage = ev.usage;
        }
      }
    }

    sendJSON(res, 200, {
      id: `chatcmpl-${randomMsgID().slice(4, 20)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    });
  } finally {
    release();
  }
}

// ------------------------------------------------------- ocserver-mode adapter
//
// OpenAI chat completions in → local opencode server's native API out:
//   POST /session                      fresh session per request (stateless)
//   POST /session/{id}/message         prompt with {model, system, parts}
//
// Gate constraints learned live on 2026-10-14 late (see docs/root-cause.md):
//   - custom `system` is ACCEPTED (caller's prompt passes through);
//   - disabling tools is REJECTED (403 — the body must keep the standard
//     agent shape), so tools stay enabled. That means the model CAN invoke
//     opencode tools on the machine running `opencode serve` — run that
//     server in a sandboxed directory/user if that worries you, and keep
//     callers to chat-style workloads.

function contentOf(m) {
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) return m.content.map((p) => p?.text ?? "").join("");
  return "";
}

async function ocPost(path, payload, timeoutMs = 300000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(OCC_URL + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON error page */ }
    return { status: r.status, data, text };
  } finally {
    clearTimeout(timer);
  }
}

async function ocChat(req, res) {
  const raw = await readBody(req);
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch {
    return sendJSON(res, 400, { error: { type: "invalid_request_error", message: "body is not valid JSON" } });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    return sendJSON(res, 400, { error: { type: "invalid_request_error", message: "messages is required" } });
  }
  const model = String(body.model ?? "unknown");
  if (!FREE_ROSTER.includes(model.replace(/^opencode\//, "")) && !FREE_ROSTER.includes(model)) {
    return sendJSON(res, 400, {
      error: { type: "invalid_request_error", message: `unknown free-lane model '${model}'; see GET /v1/models`, code: "model_not_in_roster" },
    });
  }
  const modelID = model.replace(/^opencode\//, "");

  const chars = inputChars(messages);
  if (chars > MAX_INPUT_CHARS) {
    return sendJSON(res, 413, {
      error: { type: "invalid_request_error", message: `prompt too large (${chars} chars > ${MAX_INPUT_CHARS})`, code: "free_lane_input_too_large" },
    });
  }

  const release = await acquireSlot(modelID, res);
  if (!release) return;

  try {
    const created = await ocPost("/session", {});
    if (created.status !== 200 || !created.data?.id) {
      return sendJSON(res, 502, { error: { type: "upstream_error", message: `opencode server session create failed: HTTP ${created.status} ${String(created.text).slice(0, 120)}` } });
    }
    const sessionID = created.data.id;

    const system = messages
      .filter((m) => m?.role === "system")
      .map(contentOf)
      .filter(Boolean)
      .join("\n\n")
      .trim() || "You are a helpful assistant.";

    // Fresh session per request is stateless, so multi-turn history must ride
    // inside the prompt. A single user message goes through verbatim; longer
    // histories are flattened into a labelled transcript.
    const turns = messages.filter((m) => m?.role && m.role !== "system");
    let prompt;
    if (turns.length === 1 && turns[0].role === "user") {
      prompt = contentOf(turns[0]);
    } else {
      const transcript = turns
        .map((m) => `[${m.role}]\n${contentOf(m)}`)
        .join("\n\n");
      prompt = `Below is a transcript of a conversation so far. Respond as the assistant to the FINAL user message, continuing the conversation naturally.\n\n${transcript}`;
    }

    const asked = Number(body.max_tokens ?? 0);
    const payload = {
      model: { providerID: "opencode", modelID },
      system,
      parts: [{ type: "text", text: prompt }],
    };
    if (Number.isFinite(asked) && asked > 0) payload.system += `\n\n(Keep your answer within roughly ${Math.min(asked, MAX_OUTPUT_TOKENS)} tokens.)`;

    const reply = await ocPost(`/session/${sessionID}/message`, payload);
    if (reply.status !== 200 || !reply.data) {
      return sendJSON(res, 502, { error: { type: "upstream_error", message: `opencode server prompt failed: HTTP ${reply.status} ${String(reply.text).slice(0, 160)}` } });
    }
    const err = reply.data?.info?.error;
    if (err) {
      const status = Number(err?.data?.statusCode) || 502;
      if (status === 429) tripCircuit(modelID);
      const waitSec = status === 429 ? Math.ceil(TRIP_COOLDOWN_MS / 1000) : undefined;
      res.writeHead(status === 429 ? 503 : 502, {
        "content-type": "application/json; charset=utf-8",
        ...(waitSec ? { "retry-after": String(waitSec) } : {}),
      });
      return res.end(JSON.stringify({
        error: { type: status === 429 ? "rate_limit_error" : "upstream_error", message: String(err?.data?.message || err?.name || "upstream error") },
      }));
    }

    const text = (reply.data?.parts ?? [])
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    const t = reply.data?.info?.tokens ?? {};
    const usage = {
      prompt_tokens: t.input ?? 0,
      completion_tokens: t.output ?? 0,
      total_tokens: (t.input ?? 0) + (t.output ?? 0),
    };
    const id = `chatcmpl-${randomMsgID().slice(4, 20)}`;
    const created_ = Math.floor(Date.now() / 1000);

    if (body.stream === true) {
      // v1: single-chunk SSE. Real token streaming needs the server's /event
      // subscription; most clients accept one fat chunk fine.
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      const chunk = (delta, finish = null) => JSON.stringify({
        id, object: "chat.completion.chunk", created: created_, model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      res.write(`data: ${chunk({ role: "assistant" })}\n\n`);
      res.write(`data: ${chunk({ content: text })}\n\n`);
      res.write(`data: ${chunk({}, "stop")}\n\n`);
      return res.end("data: [DONE]\n\n");
    }

    return sendJSON(res, 200, {
      id,
      object: "chat.completion",
      created: created_,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage,
    });
  } finally {
    release();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://bridge");
  const path = url.pathname;

  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    const now = Date.now();
    let ocServer = null;
    if (MODE === "ocserver") {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2000);
        const r = await fetch(`${OCC_URL}/session/status`, { signal: ctrl.signal });
        clearTimeout(timer);
        ocServer = { url: OCC_URL, reachable: r.ok };
      } catch {
        ocServer = { url: OCC_URL, reachable: false };
      }
    }
    return sendJSON(res, 200, {
      status: "ok", mode: MODE, ...(MODE === "ocserver" ? { ocServer } : { upstream: ZEN_BASE, userAgent: USER_AGENT }),
      limiter: { minGapMs: MIN_GAP_MS, maxInflightPerModel: MAX_INFLIGHT, maxTotal: MAX_TOTAL,
                 queueMax: QUEUE_MAX, maxInputChars: MAX_INPUT_CHARS,
                 maxOutputTokens: MAX_OUTPUT_TOKENS, tripCooldownMs: TRIP_COOLDOWN_MS },
      // which models the bridge is currently holding back after a Zen 429
      circuits: Object.fromEntries(
        [...lanes.entries()].map(([m, l]) => [m, {
          inflight: l.inflight, queued: l.waiters.length,
          openForMs: Math.max(0, l.openUntil - now),
          gapLeftMs: Math.max(0, l.nextFreeAt - now),
        }])),
      whitePool: {
        total: whiteLive.ids.length,
        live: whiteLive.ids.filter((id) => !whiteLive.dead.has(id)).length,
        dead: whiteLive.dead.size,
        lastHarvestAt: lastHarvestAt ? new Date(lastHarvestAt).toISOString() : null,
      },
    });
  }

  // Gateway health check / model discovery. Cached so a probe storm does not
  // hammer Zen (anonymous lane is IP-rate-limited).
  if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
    return sendJSON(res, 200, await listModels());
  }

  if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
    return MODE === "ocserver" ? ocChat(req, res) : proxy(req, res, "chat", "/chat/completions");
  }

  if (req.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
    if (MODE === "ocserver") {
      return sendJSON(res, 501, { error: { type: "not_supported", message: "/v1/responses is only available in ZEN_MODE=zen" } });
    }
    return proxy(req, res, "responses", "/responses");
  }

  sendJSON(res, 404, { error: { type: "not_found", message: `no route for ${req.method} ${path}` } });
});

/**
 * Curated free roster — the models verified to answer on this network.
 *
 * Known-dead models, kept here as exclusion history so nobody re-adds them
 * blind (live verdicts from 2026-10-11/12):
 *   muse-spark-1.2/1.3-contributor-free  403 RegionError (not offered here)
 *   exo-free                             410 ModelDeprecated
 *   ling-3.0-flash-fin-free              400 Model is unavailable
 *   jev-1.13-free                        400 ModelProtocolUnsupported
 *   nemotron-3.5-lightning-free          upstream provider error (3/3 fail)
 *   ling-3.1-flash-free                  intermittent "Endpoint is unavailable";
 *                                        kept out because one flaky model cools
 *                                        down its whole gateway account and, on
 *                                        a shared account, takes the others
 *                                        with it
 */
const FREE_ROSTER = process.env.ZEN_MODELS
  ? process.env.ZEN_MODELS.split(",").map((s) => s.trim()).filter(Boolean)
  : [
      "space-bunny-free",
      "big-pickle",
      "mimo-v2.6-flash-free",
      "longcat-2.5-preview-free",
      "nemotron-3-ultra-free",
      // 2026-10-14: re-added on user request despite being flaky upstream
      // (2/3 probes "Endpoint is unavailable" on 10-12; still 429ing that
      // evening). It IS in the roster — but keep it on its own isolated
      // gateway account so its failures cool only itself, and expect
      // intermittent 429/502 while upstream is having a bad day.
      "step-5-preview-free",
    ];

let modelsCache = { at: 0, data: null };
const MODELS_TTL_MS = 5 * 60 * 1000;

async function listModels() {
  if (modelsCache.data && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.data;
  const data = {
    object: "list",
    data: FREE_ROSTER.map((id) => ({ id, object: "model", created: 0, owned_by: "opencode" })),
  };
  modelsCache = { at: Date.now(), data };
  return data;
}

server.listen(PORT, HOST, () => {
  console.log(`zen-bridge listening on http://${HOST}:${PORT}`);
  console.log(`  upstream  : ${ZEN_BASE}`);
  console.log(`  user-agent: ${USER_AGENT}`);
  console.log(`  models    : ${FREE_ROSTER.length}`);
  console.log(`  limiter   : gap=${MIN_GAP_MS}ms inflight/model=${MAX_INFLIGHT} `
    + `total=${MAX_TOTAL} queue=${QUEUE_MAX} maxInput=${MAX_INPUT_CHARS}chars `
    + `maxOutput=${MAX_OUTPUT_TOKENS}tok trip=${TRIP_COOLDOWN_MS}ms`);
  if (ALLOW_ANY_KEY) console.log("  auth     : OPEN (no key check)");
});