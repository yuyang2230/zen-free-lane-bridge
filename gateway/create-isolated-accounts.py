#!/usr/bin/env python3
"""Create one isolated gateway account per Zen free model.

Why isolated accounts
---------------------
Zen meters the anonymous free lane per model, while the gateway's cooldown is
per account. Packing several free models into one account means a single 429 /
FreeUsageLimitError on any of them takes every sibling offline with it. One
model per account means a blown quota only cools that model.

Usage
-----
    export AGW_URL=http://gateway-host:8080
    export AGW_ADMIN_KEY=<admin bearer token>
    python gateway/create-isolated-accounts.py

Env
---
    AGW_URL         gateway base URL (default http://127.0.0.1:8080)
    AGW_ADMIN_KEY   Bearer token for /api/v1/admin
    BRIDGE          bridge base URL as the accounts should reach it
    MODELS          comma-separated model list (default: the bridge roster)
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

AGW = os.environ.get("AGW_URL", "http://127.0.0.1:8080").rstrip("/")
KEY = os.environ.get("AGW_ADMIN_KEY", "")
BRIDGE = os.environ.get("BRIDGE", "http://127.0.0.1:8799/v1").rstrip("/")
DEFAULT_MODELS = [
    "space-bunny-free",
    "big-pickle",
    "mimo-v2.6-flash-free",
    "longcat-2.5-preview-free",
    "nemotron-3-ultra-free",
    "step-5-preview-free",   # upstream-flaky; isolated account keeps it contained
]
MODELS = [m.strip() for m in os.environ.get("MODELS", ",".join(DEFAULT_MODELS)).split(",") if m.strip()]

if not KEY:
    sys.exit("set AGW_ADMIN_KEY to the gateway's /api/v1/admin bearer token")


def req(method, path, body=None, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        AGW + "/api/v1/admin" + path,
        data=data,
        method=method,
        headers={
            "Authorization": "Bearer " + KEY,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw
    except OSError as e:
        return 0, str(e)


def list_accounts():
    """The gateway caps pageSize and rejects oversized values outright, so
    fall back to the bare endpoint when a paginated request is refused."""
    for path in ("/upstream-accounts?page=1&pageSize=50", "/upstream-accounts"):
        code, res = req("GET", path)
        if code == 200 and isinstance(res, dict) and "items" in res:
            return res["items"]
    return None


accounts = list_accounts()
if accounts is None:
    sys.exit("cannot list upstream accounts (check AGW_URL / AGW_ADMIN_KEY)")
existing = {a["name"] for a in accounts}
print(f"gateway {AGW} | bridge {BRIDGE}")
print(f"existing accounts: {len(existing)}\n")

created, skipped, failed = [], [], []

for i, m in enumerate(MODELS):
    name = f"Zen-{m}"
    if name in existing:
        print(f"  {name:<30} already exists, skipped")
        skipped.append(name)
        continue

    body = {
        "name": name,
        "provider": "custom",
        "protocolType": "text",
        "credential": "public",
        "serviceBaseURL": BRIDGE,
        "useGatewayProxy": False,
        "protocols": [{"protocol": "openaiChatCompletions", "authMode": "bearer"}],
        "validationModel": m,
        "models": [{"requestModelName": m, "upstreamModelName": m}],
        "priority": 141 + i,
        "maxConcurrency": 1,
        "enabled": True,
        "note": (
            "isolated free-lane account: one model per account so this model's "
            "quota/429 failures cool only itself, not every free model"
        ),
    }

    # The gateway validates upstream on create, which fails while a model is
    # rate-limited or genuinely broken. Retry, then fall back to creating it
    # disabled so the account is in place for when the model recovers.
    ok = False
    for attempt in (1, 2, 3):
        code, res = req("POST", "/upstream-accounts", body)
        if code in (200, 201):
            ok = True
            print(f"  {name:<30} created id={res.get('id')} (prio={body['priority']})")
            created.append(name)
            break
        print(f"  {name:<30} attempt {attempt}: HTTP {code} {str(res)[:110]}")
        time.sleep(20)
    if ok:
        time.sleep(3)
        continue

    body["enabled"] = False
    body["note"] += " | created disabled: upstream validation failed (model down or cooling)"
    code, res = req("POST", "/upstream-accounts", body)
    if code in (200, 201):
        print(f"  {name:<30} created DISABLED id={res.get('id')} — enable it when the model recovers")
        created.append(name + " (disabled)")
    else:
        print(f"  {name:<30} FAILED: HTTP {code} {str(res)[:140]}")
        failed.append(name)
    time.sleep(5)

print(f"\ncreated={len(created)} skipped={len(skipped)} failed={len(failed)}")
if failed:
    print("failed:", ", ".join(failed))
    sys.exit(1)
print("next: add these accounts' models to a user group / model group, then health-check.py")