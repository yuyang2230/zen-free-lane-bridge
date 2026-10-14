#!/usr/bin/env node
/**
 * zen-replay-probe — find the minimal body shape the free-lane gate accepts.
 *
 * Reads capture index [1] (the real opencode build-agent request) from
 * zen-capture-log.jsonl and replays three shapes against the live endpoint:
 *   full     — verbatim body (43k system + 11 tools + tool_choice auto)
 *   smallsys — plain tiny system + the verbatim 11 tools + tool_choice auto
 *   notools  — plain tiny system, no tools
 *
 * All three use the VERBATIM identity headers from the capture.
 * Usage: node zen-replay-probe.mjs [full|smallsys|notools]
 */
import { readFileSync } from "node:fs";

const LOG = new URL("./zen-capture-log.jsonl", import.meta.url).pathname.slice(1);
const MODE = process.argv[2] || "full";
const MODEL = "space-bunny-free";
const ZEN = "https://opencode.ai/zen/v1/chat/completions";

const caps = readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const cap = caps[1];
const fullBody = JSON.parse(cap.body);
const verbatimHeaders = {
  authorization: cap.headers.authorization,
  "content-type": "application/json",
  accept: "*/*",
  "user-agent": cap.headers["user-agent"],
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
  "x-opencode-session": cap.headers["x-opencode-session"],
  "x-opencode-session-id": cap.headers["x-opencode-session-id"],
  "x-opencode-request": cap.headers["x-opencode-request"],
};

function stub(name) {
  return {
    type: "function",
    function: { name, description: "Reserved for the host runtime; do not call it.", parameters: { type: "object", properties: {} } },
  };
}

function pickBody() {
  if (MODE === "full") return { ...fullBody, model: MODEL, stream: true };
  const tiny = {
    model: MODEL,
    max_tokens: 32000,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "reply with exactly: pong" },
    ],
    stream: true,
    stream_options: { include_usage: true },
  };
  if (MODE === "smallsys") {
    tiny.tools = fullBody.tools;
    tiny.tool_choice = "auto";
    return tiny;
  }
  if (MODE === "two-tool") {
    tiny.tools = [stub("bash"), stub("read")];
    tiny.tool_choice = "auto";
    return tiny;
  }
  if (MODE === "nosec2tool") {
    tiny.messages = [{ role: "user", content: "reply with exactly: pong" }];
    tiny.tools = [stub("bash"), stub("read")];
    tiny.tool_choice = "auto";
    return tiny;
  }
  return tiny; // notools
}

const body = pickBody();
const res = await fetch(ZEN, {
  method: "POST",
  headers: verbatimHeaders,
  body: JSON.stringify(body),
});
if (!res.ok) {
  const text = await res.text();
  console.log(`[${MODE}] HTTP ${res.status}`);
  console.log(text.slice(0, 300));
  process.exit(0);
}
let sse = "";
const reader = res.body.getReader();
const dec = new TextDecoder();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  sse += dec.decode(value, { stream: true });
  if (sse.length > 4000) break;
}
const bits = sse.split("\n").filter((l) => l.startsWith("data:")).slice(0, 40);
let text = "";
for (const l of bits) {
  try {
    const ev = JSON.parse(l.slice(5).trim());
    if (ev.error) { console.log(`[${MODE}] HTTP 200 but SSE error:`, JSON.stringify(ev.error).slice(0, 200)); process.exit(0); }
    if (typeof ev.choices?.[0]?.delta?.content === "string") text += ev.choices[0].delta.content;
  } catch {}
}
console.log(`[${MODE}] HTTP 200, content=${JSON.stringify(text.slice(0, 120))}`);
