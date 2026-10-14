# zen-free-lane-bridge

**让 OpenCode Zen 的免费模型在任意 AI 网关 / Agent 客户端里可用。**

OpenCode Zen 有一条匿名免费模型通道（`space-bunny-free`、`big-pickle`、`mimo-v2.6-flash-free`、
`longcat-2.5-preview-free`、`nemotron-3-ultra-free`、`step-5-preview-free`），但它只接受
"看起来像 OpenCode CLI 发出来的请求"，其它客户端一律被拒：

```
403 FreeTierError: OpenCode's free tier can only be used from within OpenCode.
```

本项目提供一个 OpenAI 兼容的桥（单文件 Node 程序，无依赖），把这类客户端的请求整形后转发到 Zen，
从而让你可以在 **1Panel AI Gateway 等网关**、**ZCode / DSH / Cline / Aider 等编码 Agent**、
甚至普通 `curl` 里直接使用这些免费模型。

```
   ZCode / DSH / Cline / curl                任意 OpenAI 兼容客户端
                    │  OpenAI Chat Completions
                    ▼
        ┌───────────────────────────┐
        │   AI 网关 (1Panel 等)     │   ← 网关侧无需任何定制：上游账号
        │   智能路由 / 配额 / 日志    │      指向桥的 http://<host>:8799/v1
        └───────────┬───────────────┘
                    │  同一个 OpenAI 接口
                    ▼
        ┌───────────────────────────┐
        │      zen-bridge          │   ← 本项目：会话 id 合成 + 身份头
        │   (本仓库 bridge/)        │      + 限流 + 熔断
        └───────────┬───────────────┘
                    │  CLI 形状的匿名请求
                    ▼
          https://opencode.ai/zen/v1
```

> 如果你的目标只是"在 OpenCode CLI 里用免费模型"，那不需要本项目——直接装 CLI 即可。
> 本项目针对的是**网关聚合**与**第三方 Agent**两类场景。

---

## 快速开始

### 1. 跑起桥

需要 Node.js 18+。

```bash
git clone https://github.com/<你的账号>/zen-free-lane-bridge.git
cd zen-free-lane-bridge
node bridge/zen-bridge.mjs
```

默认监听 `0.0.0.0:8799`。先自测：

```bash
curl http://127.0.0.1:8799/health
curl http://127.0.0.1:8799/v1/models

curl http://127.0.0.1:8799/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"reply with exactly: pong"}]}'
```

应看到 `pong`。任何 `Bearer` key 都可以（桥不做鉴权，上游走匿名 `public` 通道）——
建议只在可信内网暴露，或用 `HOST=127.0.0.1` 只监听本机。

### 2. 接入 AI 网关

以 1Panel AI Gateway 为例（其它网关同理，原理都是"上游账号 = OpenAI 兼容地址"）：

1. 新建上游账号：`协议 = openaiChatCompletions`、`Base URL = http://<桥的IP>:8799/v1`、
   凭据随便填（`public` 即可）、验证模型选一个在册模型。
2. **每个免费模型建一个独立账号**，模型列表里只放这一个。
   原因：Zen 的免费额度是**按模型**计的，一个模型 429 会让网关把整个账号冷却掉。
   一模型一账号后，被打爆的模型只影响自己，健康的模型照常可用。
3. 把这些模型挂进你的用户组/模型组即可。

脚本化创建见 [`gateway/create-isolated-accounts.py`](gateway/create-isolated-accounts.py)
（需先设置网关地址与 admin key）。

<details>
<summary>健康巡检</summary>

```bash
python gateway/health-check.py     # 逐模型 test-model，一次看清哪些真的活着
```

</details>

### 3. 接入编码 Agent

Agent 侧不需要任何特殊适配，把"供应商"指向网关、把模型选成免费模型即可：

| 客户端 | 配置位置 | 要点 |
|---|---|---|
| **ZCode** | 模型设置 → 自定义供应商（OpenAI Chat Completions） | Base URL 填网关 `/v1`；**上下文窗口标注**见下方注意事项 |
| **DSH (DeepSeek Harness)** | 用 `@opencode2dsh/dsh-plugin` ≥ 0.3.12 直接走 Zen | 0.3.12 起官方已修好免费通道（与本桥同一公式），无需本项目 |
| **Cline / Roo / Continue** | OpenAI Compatible 供应商 | Base URL 填网关 `/v1` |
| **Aider / OpenWebUI / LobeChat / Cherry Studio** | OpenAI 兼容端点 | 同上 |
| **curl / 脚本** | — | 见上文快速开始 |

> **DSH 用户注意**：DSH 有官方插件 `@opencode2dsh/dsh-plugin`，v0.3.12（2026-10-14）
> 已修复免费通道，**优先用官方插件**，不必绕本桥。

⚠️ **ZCode 用户注意：上下文窗口标注**
Agent 会按你标注的上下文窗口决定要不要裁剪历史。若把免费模型标成 1M，Agent 就永不裁剪，
请求体轻易超过桥的输入上限（`ZEN_MAX_INPUT_CHARS`，默认 12 万字符），表现为
**UI 一直"重新连接中 N/10"**。两种处理任选：

- 把该模型的上下文标注改小（如 128K），让 Agent 自己管理历史；
- 或调大桥的上限，例如覆盖 1M token 对话：
  `ZEN_MAX_INPUT_CHARS=4000000`（Windows 用 `start-bridge.cmd` 里的同名变量）。

超限时桥返回的是明确的 `413 free_lane_input_too_large`，不会白白消耗上游额度。

---

## 它到底做了什么（简版）

Zen 的匿名通道对请求做形状校验，2026-10-11 / 10-14 两次收紧。**实测定论**（详见
[`docs/root-cause.md`](docs/root-cause.md)）：

1. **会话 id 的 12 位十六进制字段不是随机数**。上游把它解码成
   `~(毫秒时间戳 × 4096 + 每毫秒计数器)`，只接受计数器落在 `[0, 63]`。
   老实现填 sha256 摘要字节，命中率约 `64/4096 ≈ 1.5%`——看起来就像"免费通道全挂"。
   本桥按上游生成器的公式自行合成（计数器固定为 1），时钟位本身不被校验。
2. **1.19 起的身份头**：`user-agent` 需带 `ai-sdk/provider-utils` 与 `runtime/bun` 标记，
   `x-opencode-project: global`，`x-opencode-request` 是 `msg_<26位base62>`。
3. **body 形状其实不敏感**（用隔离梯子逐项验证过，不是猜的）：system 内容、工具数量都无所谓。
   桥仍注入两个惰性 stub 工具 + `tool_choice:auto` + `stream_options`，因为这正是真实 CLI 的形状，
   零成本且少一个变量。

另外内置了免费额度保护：按模型串行 + 最小间隔、每模型 429 熔断、输入体积上限、
队列深度超限快速 429。这些不是装饰——匿名免费额度按模型按 IP 计费，
一个失控的长上下文 Agent 就能把它烧光。

---

## 项目结构

```
bridge/zen-bridge.mjs              桥本体（单文件，零依赖）
bridge/start-bridge.cmd            Windows 常驻启动器（计划任务 + 5s 自愈循环）
bridge/start-bridge.sh             Linux/macOS 常驻启动器
deploy/install-windows-task.ps1    一键部署为 Windows 计划任务（开机自启、隐藏窗口）
gateway/create-isolated-accounts.py    批量创建"一模型一账号"的上游账号
gateway/health-check.py                逐模型健康巡检
tools/zen-capture-proxy.mjs            抓取真实 OpenCode 请求（排查升级时用）
tools/zen-replay-probe.mjs             请求形状隔离梯子（复现门禁行为）
docs/root-cause.md                     门禁机制完整考证
docs/gateway-setup.md                  网关接入详解（含 1Panel 操作步骤）
docs/troubleshooting.md                症状 → 病因速查表
```

---

## 重要前提与边界

- **免费通道本身是上游的赠品，随时可能变更**：模型下架、改名、额度策略调整都发生过。
  `health-check.py` 的存在就是为了让"哪个模型还活着"随时可查。
- **个别模型天生不稳**：`step-5-preview-free` 长期间歇性 `Endpoint is unavailable`，
  这是上游侧缺陷而非本桥问题；因此它被放在独立账号里，坏了只冷却自己。
- **额度按模型 + IP 计费**：请保留桥自带的限流默认值，别为了"更快"把它们调到很低。
- 本项目仅做协议适配与流量整形，不修改、不代理、不存储你的业务数据；
  请求内容仍然直接发往 `opencode.ai`。

## License

MIT