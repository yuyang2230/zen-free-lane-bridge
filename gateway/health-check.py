#!/usr/bin/env python3
"""Per-model health sweep for the Zen free lane.

Two layers, both reported, because they fail for different reasons:

  1. bridge  - talks to zen-bridge directly. This is the authoritative signal
               for "can Zen serve this model right now".
  2. gateway - asks the gateway to test each upstream account, i.e. the signal
               your users actually experience.

Use bridge results when the two disagree: gateway cooldown is per account, so
one blown quota can make healthy models look broken.

Usage:
    export AGW_URL=http://gateway-host:8080
    export AGW_ADMIN_KEY=<admin bearer token>
    python gateway/health-check.py
"""

import json
import os
import sys
import urllib.error
import urllib.request

BRIDGE = os.environ.get("BRIDGE", "http://127.0.0.1:8799").rstrip("/")
AGW = os.environ.get("AGW_URL", "").rstrip("/")
KEY = os.environ.get("AGW_ADMIN_KEY", "")

PROMPT = "reply with exactly: pong"


def post_json(url, body, headers=None, timeout=90):
    r = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except OSError as e:
        return 0, str(e)


def get_json(url, headers=None, timeout=30):
    r = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            return e.code, {}
    except OSError as e:
        return 0, {"error": str(e)}


def classify(code, raw):
    low = raw.lower()
    if code == 200:
        try:
            content = (json.loads(raw)["choices"][0]["message"].get("content") or "").strip()
        except Exception:
            return "DEFECT", "unparsable 200"
        return ("OK", content[:20]) if content else ("DEFECT", "empty content")
    if "freeusagelimit" in low or "rate limit" in low or code == 429:
        return "QUOTA", "free-lane quota exhausted (429)"
    if "free tier" in low or "free tier" in low.replace("'", "'") or "free tier" in low:
        return "DEFECT", "gate rejected the request (403 FreeTierError)"
    if "endpoint is unavailable" in low:
        return "DEFECT", "upstream Endpoint is unavailable"
    if "not found" in low or "unsupport" in low or "deprecat" in low:
        return "DEFECT", "model unavailable upstream"
    if code == 503:
        return "QUOTA", "bridge circuit open / retry later (503)"
    return "DEFECT", f"HTTP {code}: {raw[:80]}"


def sweep_bridge(models):
    print("=" * 72)
    print(f"BRIDGE sweep  {BRIDGE}")
    print("=" * 72)
    code, data = get_json(f"{BRIDGE}/v1/models")
    if code != 200:
        sys.exit(f"bridge not reachable: HTTP {code} {data}")
    listed = [m["id"] for m in data.get("data", [])]
    print(f"roster ({len(listed)}): {', '.join(listed)}\n")

    results = {}
    for m in models:
        if m not in listed:
            print(f"  {m:<30} NOT IN ROSTER")
            results[m] = ("SKIP", "not in roster")
            continue
        c, raw = post_json(
            f"{BRIDGE}/v1/chat/completions",
            {"model": m, "messages": [{"role": "user", "content": PROMPT}],
             "stream": False, "max_tokens": 32},
        )
        verdict, info = classify(c, raw)
        results[m] = (verdict, info)
        print(f"  {m:<30} {verdict:<7} {info}")
    return results


def sweep_gateway():
    if not AGW or not KEY:
        print("\n(set AGW_URL + AGW_ADMIN_KEY to also sweep the gateway layer)")
        return
    print("\n" + "=" * 72)
    print(f"GATEWAY sweep  {AGW}")
    print("=" * 72)
    hdr = {"Authorization": "Bearer " + KEY}
    code, accs = get_json(f"{AGW}/api/v1/admin/upstream-accounts?page=1&pageSize=50", hdr)
    if code != 200 or "items" not in (accs if isinstance(accs, dict) else {}):
        # pageSize caps vary by gateway build; the bare endpoint always works.
        code, accs = get_json(f"{AGW}/api/v1/admin/upstream-accounts", hdr)
    if code != 200:
        print(f"cannot list accounts: HTTP {code}")
        return
    for a in accs.get("items", []):
        if not a.get("name", "").startswith("Zen-"):
            continue
        for m in a.get("models", []):
            name = m.get("requestModelName")
            c, res = post_json(
                f"{AGW}/api/v1/admin/upstream-accounts/{a['id']}/test-model",
                {"requestModelName": name}, hdr)
            ok = c in (200, 201) and not (isinstance(res, dict) and res.get("code"))
            ms = res.get("durationMs") if isinstance(res, dict) else None
            print(f"  {name:<30} {'OK' if ok else 'FAIL':<7} "
                  f"HTTP{c}{f' {ms}ms' if ms else ''} {'' if ok else str(res)[:100]}")


def main():
    code, data = get_json(f"{BRIDGE}/health")
    if code == 200:
        wp = data.get("whitePool", {})
        print(f"bridge health: {data.get('status')} | whitePool {wp.get('live')}/{wp.get('total')} live")
        tripped = {m: v["openForMs"] for m, v in (data.get("circuits") or {}).items() if v.get("openForMs", 0) > 0}
        if tripped:
            print(f"circuits open: {tripped}")
        print()

    models_env = os.environ.get("MODELS", "")
    models = [m.strip() for m in models_env.split(",") if m.strip()] if models_env else None
    if models is None:
        code, data = get_json(f"{BRIDGE}/v1/models")
        models = [m["id"] for m in data.get("data", [])] if code == 200 else []

    results = sweep_bridge(models)
    sweep_gateway()

    ok = [m for m, (v, _) in results.items() if v == "OK"]
    print("\n" + "=" * 72)
    print(f"usable now ({len(ok)}/{len(results)}): {', '.join(ok) if ok else 'none'}")
    for m, (v, info) in results.items():
        if v != "OK":
            print(f"  {m:<30} {v}: {info}")
    print("=" * 72)


if __name__ == "__main__":
    main()