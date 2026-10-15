# 网关接入详解

以 1Panel AI Gateway 为主线。其它支持"OpenAI 兼容上游账号"的网关
（OneAPI / New API / LiteLLM / LocalAI 等）步骤完全相同——本桥对网关而言
就是一个普通的 OpenAI 兼容上游。

---

## 架构位置

```
用户 / Agent ──► AI 网关 ──► zen-bridge ──► opencode.ai/zen
   (sk-Key)      (路由/配额/日志)   (无鉴权)      (匿名免费通道)
```

桥**必须**部署在网关能直连的地址上。它没有鉴权，建议只部署在可信内网，
或用 `HOST=127.0.0.1` 配合本机端口转发。

---


## 前置条件：本机要跑一个 opencode serve

2026-10-14 深夜起，上游门禁按**传输层指纹**放行——只有真实 opencode 二进制发出的
连接能过（详见 root-cause.md 第三层门禁）。因此桥默认工作在 `ZEN_MODE=ocserver`：

1. 本机安装 opencode CLI（https://opencode.ai）。
2. 常驻启动无头服务（保持 4096 端口）：
   - Windows：`powershell -ExecutionPolicy Bypass -File deploy\install-windows-task.ps1 -Component both`
     （同时装 ZenBridge 与 ZenOcServer 两个计划任务，登录自启、隐藏窗口、5s 自愈）
   - Linux/macOS：`bash deploy/start-ocserver.sh`，或用 `deploy/zen-ocserver.service`
3. 桥会自动把免费模型的请求转给它（`OCC_URL`，默认 `http://127.0.0.1:4096`）。
4. `/health` 里 `ocServer.reachable: true` 即链路就绪。

**安全提醒**：门禁要求 opencode 工具保持启用，模型因此**可以**在该机器上执行工具调用
（bash 等）。务必让 `opencode serve` 跑在专用目录 + 低权限账号（或容器）里，
并只允许可信调用方访问网关与桥。

## 上游账号配置

在网关新增上游账号（1Panel AI Gateway：`AI 网关 → 上游账号 → 添加`）：

| 字段 | 值 |
|---|---|
| 名称 | `Zen-<模型名>`，例如 `Zen-big-pickle` |
| 供应商类型 | `custom` / OpenAI 兼容 |
| 协议 | `openaiChatCompletions`（Chat Completions） |
| Base URL | `http://<桥IP>:8799/v1` |
| 凭据 / API Key | `public`（桥不校验，上游走匿名通道） |
| 验证模型 | 该账号挂的那个模型 |
| 模型列表 | **只放这一个模型** |
| 最大并发 | `1`（免费通道按模型串行更稳） |
| 优先级 | 任意，按需排 |

### 为什么必须"一模型一账号"

Zen 的免费额度是**按模型**计的，网关的冷却也是**按账号**的。
若把 5 个免费模型塞进一个账号，任意一个模型触发 429/FreeUsageLimitError，
整个账号进入冷却，**5 个模型一起下线**。拆成独立账号后，被打爆的模型只冷却自己。

批量创建：

```bash
export AGW_URL=http://<网关IP>:8080
export AGW_ADMIN_KEY=<admin key>      # /api/v1/admin 的 Bearer token
python gateway/create-isolated-accounts.py
```

脚本会跳过已存在的账号，可安全重复运行。

### 账号创建时的上游验证

网关在创建账号时会用"验证模型"打一次上游。桥自身健康时没问题；
但若某模型上游确实坏了（如间歇 `Endpoint is unavailable`），创建会返回 502。
脚本对这种情况会尝试以 `enabled: false` 创建——**先建好、暂不启用**，
等上游恢复再在面板里启用。这不是 bug，是网关的既有行为。

---

## 智能路由接入（可选）

把免费模型挂进用户组即可被调用。若想参与智能路由（例如 `auto` 模型）：

1. 建一个模型组，把免费模型加进去（注意组内模型最好是**同一档**能力）。
2. 在智能路由策略里把该组设为"简单/复杂"档的目标之一。
3. 免费通道的上游可用性天然不如付费通道，**建议付费模型兜底**：
   智能路由或网关侧任选其一做故障转移，避免免费通道抽风时整体不可用。

> 本项目只解决"免费通道能不能调通"，不替你决定路由策略。

---

## 常驻运行

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File deploy/install-windows-task.ps1
```

创建计划任务 `ZenBridge`，登录时触发，经 VBS 隐藏窗口启动
（直接跑 `.cmd` 会弹黑框，因为计划任务默认在交互会话里运行）。
`start-bridge.cmd` 内含 5 秒自愈循环：桥异常退出自动拉起。

### Linux / macOS

```bash
nohup bash bridge/start-bridge.sh > bridge.log 2>&1 &
# systemd:
sudo cp deploy/zen-bridge.service /etc/systemd/system/
sudo systemctl enable --now zen-bridge
```

### 环境变量

桥的所有行为都可用环境变量覆盖，常用几项见 README 的"Env knobs"。
生产上建议显式设置 `ZEN_MAX_INPUT_CHARS`（配合客户端的上下文标注），
其余保持默认即可。

---

## 监控要点

```bash
curl http://<桥IP>:8799/health
```

关注三个字段：

- `circuits.<model>.openForMs` —— 该模型被 429 熔断的剩余秒数（>0 表示上游额度耗尽中）
- `circuits.<model>.gapLeftMs` —— 串行间隔剩余（正常，说明限流在工作）
- `whitePool.live / dead` —— 兜底池状态；`dead` 增长说明上游又改了门禁

逐模型健康巡检：

```bash
python gateway/health-check.py
```

---

## 数据与安全

- 桥不做鉴权、不落盘请求内容，只在 `zen-white-sessions.json` 里存兜底用的会话 id。
- 上游是**匿名**通道：不需要也无法携带你的 OpenCode 账号。
- 免费通道的可用性、内容政策由上游决定，本项目不承担 SLA。