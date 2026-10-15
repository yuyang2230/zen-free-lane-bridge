# zen-free-lane-bridge

**让 OpenCode Zen 的免费模型在任意 AI 网关 / Agent 客户端里可用。**

OpenCode Zen 有一条匿名免费模型通道（`space-bunny-free`、`big-pickle`、`mimo-v2.6-flash-free`、
`longcat-2.5-preview-free`、`nemotron-3-ultra-free`、`step-5-preview-free`），但它只接受
"看起来像 OpenCode CLI 发出来的请求"，其它客户端一律被拒：

```
403 FreeTierError: OpenCode's free tier can only be used from within OpenCode.
```

本项目提供一个 OpenAI 兼容的桥（单文件 Node 程序，无依赖），让你可以在
**1Panel AI Gateway 等网关**、**ZCode / DSH / Cline / Aider 等编码 Agent**、
甚至普通 `curl` 里直接使用这些免费模型。

> **状态（2026-10-14 深夜）**：上游当晚新增了**传输层指纹**校验——从 node/curl 等非 bun
> 运行时发出的请求，即使逐字节复刻真实 CLI 流量也会 403。因此桥的默认工作模式已改为
> `ocserver`：把请求转交给本机无头 opencode 服务（真实二进制 = 可信传输），桥本身退化为
> 协议适配器。**这要求本机装有 opencode CLI**。旧直连模式（`ZEN_MODE=zen`）保留但当前无效。
> 机制考证见 [`docs/root-cause.md`](docs/root-cause.md)。

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
        │      zen-bridge           │   OpenAI 协议 → opencode 原生 API
        │   (本仓库 bridge/)         │   的适配器 + 限流 + 熔断
        └───────────┬───────────────┘
                    │  opencode 原生 API（本机回环）
                    ▼
        ┌───────────────────────────┐
        │  opencode serve (无头)     │   ← 真实 opencode 二进制
        │  `opencode serve`         │      它对外的 TLS 传输被上游信任
        └───────────┬───────────────┘
                    │
                    ▼
          https://opencode.ai/zen
```

> 如果你的目标只是"在 OpenCode CLI 里用免费模型"，那不需要本项目——直接装 CLI 即可。
> DSH 用户请优先用官方插件 `@opencode2dsh/dsh-plugin` ≥ 0.3.12（若上游的传输指纹同样
> 拦截它，则回到本项目这条链路）。本项目针对的是**网关聚合**与**第三方 Agent**两类场景。

---

## 快速开始

前提：Node.js 18+，本机装有 [opencode CLI](https://opencode.ai)。

### 1. 起两个进程

```bash
git clone https://github.com/<你的账号>/zen-free-lane-bridge.git
cd zen-free-lane-bridge

# 进程 1：无头 opencode 服务（可信传输后端），默认 4096 端口
bash deploy/start-ocserver.sh        # Windows: deploy\start-ocserver.cmd

# 进程 2：桥（默认 ZEN_MODE=ocserver，指向 127.0.0.1:4096），默认 8799 端口
node bridge/zen-bridge.mjs           # 或 bash bridge/start-bridge.sh（自愈循环）
```

自测：

```bash
curl http://127.0.0.1:8799/health          # mode=ocserver, ocServer.reachable=true
curl http://127.0.0.1:8799/v1/models

curl http://127.0.0.1:8799/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"reply with exactly: pong"}]}'
```

应看到 `pong`。桥不做入站鉴权——只在可信内网暴露，或 `HOST=127.0.0.1` 只听本机。

### 2. 接入 AI 网关

以 1Panel AI Gateway 为例（其它支持"OpenAI 兼容上游账号"的网关同理）：

1. 新建上游账号：`协议 = openaiChatCompletions`、`Base URL = http://<桥IP>:8799/v1`、
   凭据随便填、验证模型选一个在册模型。
2. **每个免费模型建一个独立账号**，模型列表里只放这一个。
   原因：Zen 免费额度按模型计、网关冷却按账号计——一模型一账号后，
   一个模型 429 只冷却自己，不会拖垮其它健康模型。
3. 把这些模型挂进用户组/模型组即可。

脚本化创建见 [`gateway/create-isolated-accounts.py`](gateway/create-isolated-accounts.py)，
逐模型体检用 [`gateway/health-check.py`](gateway/health-check.py)。
细节与截图级步骤见 [`docs/gateway-setup.md`](docs/gateway-setup.md)。

### 3. 接入编码 Agent

Agent 侧不需要任何特殊适配，把"供应商"指向网关、模型选免费模型即可：

| 客户端 | 配置位置 | 要点 |
|---|---|---|
| **ZCode** | 模型设置 → 自定义供应商（OpenAI Chat Completions） | Base URL 填网关 `/v1`；**上下文窗口标注**见下 |
| **Cline / Roo / Continue** | OpenAI Compatible 供应商 | Base URL 填网关 `/v1` |
| **Aider / OpenWebUI / LobeChat / Cherry Studio** | OpenAI 兼容端点 | 同上 |
| **curl / 脚本** | — | 见上文快速开始 |

⚠️ **上下文窗口标注**：Agent 按标注决定是否裁剪历史。若把免费模型标成 1M，Agent 永不裁剪，
请求超桥上限（`ZEN_MAX_INPUT_CHARS`）时会得到明确的 `413 free_lane_input_too_large`，
客户端表现为反复重连。要么把标注改小（如 128K），要么调大该上限
（覆盖 1M token 对话约需 `ZEN_MAX_INPUT_CHARS=4000000`）。

---

## ocserver 模式的能力边界（务必读）

桥通过 opencode server 的原生会话 API 发请求，上游门禁对这条链路有硬性约束
（全部实测得出，见 root-cause 文档）：

1. **system 提示词可以自定义**：调用方的 system 会被透传，模型按它行事。
2. **工具必须保持启用**：禁用任何工具都会 403。这意味着模型**理论上可以执行 opencode
   工具**（跑 bash 等）在 `opencode serve` 所在机器上。请把该服务跑在专用目录/低权限
   账号/容器里，且只让可信调用方使用。
3. **多轮对话以"对话展平"实现**：桥为每个请求新建会话，多轮历史拼成带角色标签的
   转录文本放入单条 prompt（单条 user 消息则原样直发）。
4. **流式输出**：v1 为整段单块 SSE（多数客户端兼容）；逐 token 流式需要接 server 的
   `/event` 订阅，留待后续。
5. **计量开销**：每个请求隐含 opencode 自身的 agent 上下文，上游按实际 input 计费，
   免费额度消耗比裸 API 略高——这正是限流默认值偏保守的原因。

---

## 项目结构

```
bridge/zen-bridge.mjs              桥本体（单文件，零依赖；ZEN_MODE=ocserver|zen）
bridge/start-bridge.cmd / .sh      常驻启动器（5s 自愈循环）
deploy/start-ocserver.cmd / .sh    opencode serve 自愈启动器（桥的后端）
deploy/install-windows-task.ps1    一键装为 Windows 计划任务（-Component bridge|ocserver|both）
deploy/start-*-hidden.vbs          计划任务的隐藏窗口包装
deploy/zen-bridge.service          systemd 单元（桥）
deploy/zen-ocserver.service        systemd 单元（opencode server）
gateway/create-isolated-accounts.py    批量创建"一模型一账号"的上游账号
gateway/health-check.py                逐模型健康巡检（桥层 + 网关层）
tools/zen-capture-proxy.mjs            抓取真实 OpenCode 请求（排查升级时用）
tools/zen-replay-probe.mjs             请求形状隔离梯子（复现门禁行为）
docs/root-cause.md                     门禁机制完整考证（三层门禁演变）
docs/gateway-setup.md                  网关接入详解
docs/troubleshooting.md                症状 → 病因速查表
```

---

## 重要前提与边界

- **免费通道是上游的赠品，门禁三天改了三次**（形状 → 会话计数器 → 传输指纹）。
  本项目的考证方法与工具（`tools/`）比任何单一配方更持久——门禁再变，按
  `docs/root-cause.md` 的隔离梯子重新定位即可。
- **个别模型天生不稳**：`step-5-preview-free` 长期间歇 `Endpoint is unavailable`
  （上游侧缺陷）。它必须在独立网关账号里，坏了只冷却自己。
- **额度按模型 + IP 计费**：保留桥的限流默认值；失控的长上下文 Agent 一天能烧光全部额度。
- 本项目仅做协议适配与流量整形，不修改、不代理、不存储你的业务数据。

## License

MIT