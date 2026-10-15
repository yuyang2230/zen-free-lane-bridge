#!/usr/bin/env node
/**
 * zen-capture-proxy — one-shot capture stand-in for https://opencode.ai/zen/v1.
 *
 * Point opencode's built-in "opencode" provider at http://127.0.0.1:8810 via
 * options.baseURL, run `opencode run` once, and this proxy forwards every
 * request to the real Zen endpoint while dumping the VERBATIM request
 * (method, full headers, raw body) to zen-capture-log.jsonl one JSON line per
 * request. The verbatim line is the gate-passing fingerprint to bake into
 * zen-bridge v2.
 *
 * URL handling: the client may or may not re-prefix /v1 after replacing the
 * baseURL root. Whichever it requests, we normalize to the real path:
 *   - req.url already under /zen  -> forward as-is
 *   - otherwise                    -> /zen/v1 + req.url  (stripping a leading
 *                                      /v1 first so /v1/chat/completions is
 *                                      not doubled)
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ZEN_ORIGIN = process.env.ZEN_ORIGIN || "https://opencode.ai";
const OUT = fileURLToPath(new URL("./zen-capture-log.jsonl", import.meta.url));
const PORT = Number(process.env.PORT || 8810);

function targetPath(reqUrl) {
  if (reqUrl.startsWith("/zen")) return reqUrl;
  return "/zen/v1" + reqUrl.replace(/^\/v1(?=\/|$)/, "");
}

createServer((req, res) => {
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 20 * 1024 * 1024) {
      res.writeHead(413);
      return res.end("body too large for capture proxy");
    }
    chunks.push(c);
  });
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const url = targetPath(req.url);
    // verbatim dump first — the artifact this proxy exists for
    appendFileSync(OUT, JSON.stringify({
      at: new Date().toISOString(),
      method: req.method,
      localUrl: req.url,
      target: url,
      headers: req.headers,
      body: body.toString("utf8"),
    }) + "\n");
    try {
      const fwdHeaders = { ...req.headers, host: "opencode.ai" };
      delete fwdHeaders["connection"];
      const upstream = await fetch(ZEN_ORIGIN + url, {
        method: req.method,
        headers: fwdHeaders,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
        redirect: "manual",
      });
      const resHeaders = {};
      upstream.headers.forEach((v, k) => { resHeaders[k] = v; });
      res.writeHead(upstream.status, resHeaders);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) await new Promise((r) => res.once("drain", r));
        }
      }
      res.end();
    } catch (err) {
      console.error(`capture-proxy forward failed: ${err.message} (${url})`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "capture_proxy_error", message: err.message } }));
    }
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`zen-capture-proxy on http://127.0.0.1:${PORT} -> ${ZEN_ORIGIN}`);
  console.log(`capturing to ${OUT}`);
});
