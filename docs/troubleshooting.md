# Troubleshooting：症状 → 病因速查

按"你看到的现象"查。每条都给出**确认方法**，而不只是猜测。

---

## Agent 客户端

### UI 一直"重新连接中 N/10"

**病因**：请求被桥以 413 拒绝，Agent 把它当成可重试的网络错误。

**确认**：
```bash
# 用同样大小的 body 打桥，看是否 413
curl -s http://127.0.0.1:8799/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"<放一段超过上限的长文本>"}]}'
```
响应里有 `free_lane_input_too_large` 即确诊。

**处理**：把客户端里该模型的**上下文窗口标注**改小（如 128K），
或调大桥的 `ZEN_MAX_INPUT_CHARS`。参见 README「Agent 接入」的注意事项。

---

### 首字很慢 / 中途断流

**病因 A**：桥按模型串行 + 最小间隔限流，免费模型本身也慢。
**确认**：`/health` 里看目标模型的 `gapLeftMs` / `queued`，非 0 说明在排队。

**病因 B**：Agent 上下文过大，模型首 token 迟迟不来，客户端先超时。
**处理**：缩小上下文标注，或换更快的模型（如 `mimo-v2.6-flash-free`、`big-pickle`）。

---

### 某些模型完全不可用，另一些正常

**病因**：上游个别模型自身缺陷（典型：`step-5-preview-free` 长期
`Upstream request failed: Endpoint is unavailable`）。这是上游侧问题，本桥无能为力。

**确认**：
```bash
curl -s http://127.0.0.1:8799/health   # 看 circuits 里是否该模型 openForMs > 0
```

**处理**：该模型在网关里保持独立账号（坏了只冷却自己）；健康模型不受影响。

---

## 网关侧

### 创建上游账号报 502

**病因**：网关创建时会用验证模型打一次上游；上游当时不可用（含桥的 429 熔断期）。

**处理**：以 `enabled: false` 创建，上游恢复后在面板启用；
或用 `gateway/create-isolated-accounts.py`（内置重试与降级逻辑）。

---

### 网关返回 `upstream_auth_failed` / 403

**病因**：桥的会话 id 配方过期（上游改了门禁），或 `USER_AGENT` 与当前 CLI 版本脱节。

**确认**：直连桥。
```bash
curl -s http://127.0.0.1:8799/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"pong"}]}'
```
直连也 403 → 门禁问题；直连 200 而网关 403 → 网关侧配置问题（Base URL 填错等）。

**处理（门禁变了）**：
1. 更新 `bridge/zen-bridge.mjs` 中的 `USER_AGENT`（见下节重新抓包）。
2. 若新门禁不再接受自造 id，桥会自动落到兜底池（需本机装有真实 opencode CLI）。

---

### 网关返回 503 `white_sessions_unavailable`

**病因**：自造 id 全部 403，且兜底池为空 / 收割冷却中 / 本机没有 opencode CLI。

**处理**：安装真实 opencode CLI 并让桥能调用它（设置 `ZEN_HARVEST_CWD`），
等待冷却结束后重试（响应带 `retry-after`）。

---

## 直连桥

### `403 FreeTierError`

**确认**：属于门禁问题，按上文「网关返回 403」处理。

**自查计数器窗口**（若你改过 id 生成逻辑）。填入**真实会话 id**（形如
`ses_` + 12 位 hex + 14 位 base62，共 30 字符；可从抓包日志或桥日志里拿）：

```bash
node -e '
const ses = process.argv[1];                    // 例如 ses_ec6066bcfffeqgMqkTnQ61WNq1
if (!/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(ses)) { console.log("不是规范形状"); process.exit(1); }
const f = BigInt("0x" + ses.slice(4, 16));      // 12 位 hex 字段
const counter = Number((~f) & 281474976710655n & 4095n);
console.log("counter =", counter, "(必须在 0..63 才能过门禁)");
' ses_ec6066bcfffeqgMqkTnQ61WNq1
```

---

### `429` / `503 free_lane_tripped`

**病因**：该模型的匿名额度被打满，或触发桥的本地熔断（默认 120s）。

**确认**：`/health` → `circuits.<model>.openForMs > 0`。

**处理**：等待 `retry-after`；确认没有失控的长上下文 Agent 在高频调用
（额度按模型按 IP 计）；必要时调大 `ZEN_MIN_GAP_MS` 降低速率。

---

### `413 free_lane_input_too_large`

见上文「UI 一直重新连接」。这是**保护机制**：宁可拒绝，也不白烧免费额度。

---

## 上游门禁再次变化时怎么更新身份头

`USER_AGENT` / `x-opencode-*` 是从真实 CLI 抓来的，需要更新时：

```bash
# 1. 起抓包代理
node tools/zen-capture-proxy.mjs        # 监听 127.0.0.1:8810，转发到上游并落盘请求

# 2. 把 opencode 的 opencode 供应商 baseURL 临时指到代理
#    （~/.config/opencode/opencode.json 里 provider.opencode.options.baseURL）
opencode run -m opencode/<某个免费模型> "reply with exactly: pong"

# 3. 从 zen-capture-log.jsonl 里读 user-agent 与各 x-opencode-* 字段
# 4. 更新 bridge/zen-bridge.mjs 顶部的 USER_AGENT / PROJECT 等常量
```

> 抓包后**务必还原** opencode 配置。

用 `tools/zen-replay-probe.mjs` 可以在不改动生产桥的前提下验证新配方是否被放行
（需先用 `tools/zen-capture-proxy.mjs` 抓一次真实请求；工具缺抓包文件时会打印操作步骤）。

---

## 桥本身起不来

- **端口占用**：`netstat -ano | findstr 8799`，换 `PORT=8800`。
- **Node 版本**：需 18+（用到内置 fetch）。
- **想看启动日志**：`bash bridge/start-bridge.sh` 前台跑，或看 `bridge.log`。

---

## ocserver 模式（当前默认）

### `/health` 里 `ocServer.reachable: false`

**病因**：`opencode serve` 没起或端口不对。

**处理**：先起后端（`deploy/start-ocserver.cmd|sh`，默认 4096），或把 `OCC_URL` 指到实际地址。

---

### 一切请求 502，错误信息带 FreeTierError

**病因**：opencode server 对上游的请求也被 403 了——通常意味着门禁又变了
（例如 body 层新增校验），或 opencode CLI 版本更新改变了请求形状。

**处理**：升级 opencode CLI 后重试；仍失败则按 root-cause.md 的隔离梯子重新定位，
必要时重抓请求（`tools/zen-capture-proxy.mjs`）。

---

### 模型回复带 opencode CLI 口吻（"我来运行命令"之类）

**病因**：门禁要求 opencode 工具保持启用，模型自带 agent 人格；未传 system 时桥
只注入一句默认提示词。

**处理**：在请求里带上你自己的 system（透传是支持的），明确"直接回答，不要使用工具"。
这是当前门禁下的结构性限制，无法完全消除。

---

### 请求后机器上出现了工具执行痕迹

**严重**：门禁强制工具启用，模型真的可以执行 opencode 工具（bash 等）。
确认 `opencode serve` 跑在低权限/专用目录/容器里，并检查调用方是否可信。
