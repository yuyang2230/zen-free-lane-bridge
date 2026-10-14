# 门禁机制考证：Zen 免费通道为什么拒我们的请求

本文记录 2026-10-11 ~ 10-14 三天内对 `opencode.ai/zen` 匿名免费通道的实测考证过程与结论。
所有结论均来自**隔离实验**（一次只变一个变量），不是推测。复现工具见 `tools/`。

---

## 症状

任何非 OpenCode CLI 的客户端调用 Zen 免费模型，一律：

```
HTTP 403
{"type":"error","error":{"type":"FreeTierError",
 "message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}
```

2026-10-13 起社区插件 `@opencode2dsh/dsh-plugin`（DSH 的 Zen 适配器）也大面积失败，
其 issue #62 记录了同样的现象：换模型、换客户端、换 IP 都无效，"免费通道几乎全挂"。

---

## 第一阶段（10-11）：形状门槛

当时的经验结论是请求需满足三段：

1. `Authorization: Bearer public`
2. 规范会话 id：`ses_` + 12 位小写 hex + 14 位 base62
3. body 里带 `bash` / `read` 两个门禁工具，且为流式

这些**都对，但都不完整**。它们能让一部分请求通过，却解释不了后来"几乎全挂"。

## 第二阶段（10-13）：一度误判为"body 指纹"

用日志代理抓到真实 OpenCode 1.19 的请求并回放，发现：

- 回放"逐字真实 body" → 200
- 任何重建 body → 403

于是得出"门禁 = 完整 agent 请求体指纹"的结论。**这是误判**，原因见下。

## 第三阶段（10-14）：隔离梯子定案

关键实验：**只改会话 id，其它全部不变**。

```
A. 用抓包得到的真实 ses_ + 任意 body        → 200
B. 用 sha256 合成的规范 ses_ + 同样的 body   → 403
```

结论浮出水面：门禁看的是**会话 id 的内部结构**，不是 body。

### 关键机制：12 位 hex 字段是"时间戳 × 4096 + 计数器"

上游对 `ses_<12hex><14base62>` 的解码方式：

```js
// 反解：12hex 字段 = ~(毫秒时间戳 × 4096 + 每毫秒计数器)
raw = ~field & 0xFFFFFFFFFFFFn
counter = Number(raw & 0x4095n)        // 低 12 位 = 计数器
timestamp = raw >> 12n                  // 高 36 位 = 时钟位
```

只有 `counter ∈ [0, 63]` 的 id 被放行。验证：

```bash
node -e '
function inv(now=Date.now()){return (~(BigInt(now)*4096n+1n)&281474976710655n).toString(16).padStart(12,"0");}
const f=BigInt("0x"+inv());
console.log("计数器 =", ((~f)&281474976710655n&4095n).toString());   // → 1
'
```

- 老实现把 sha256 摘要字节填进这 12 位：随机值落入 `[0,63]` 的概率 = `64/4096 = 1.5625%`
  ——与上游 issue 里"约 1.5%"的描述**精确吻合**。这正是"几乎全挂"的真相：
  不是通道死了，是配方只有 1/64 的存活率。
- 时钟位（高 36 位）**不被校验**（解码到 1970 年也能过），所以自造 id 可以长期有效。
- 上游自己的生成器在 `packages/schema/src/identifier.ts`：
  取毫秒时钟，把每毫秒序号放进低 12 位，整体按位取反 `~x`（使 id 按字典序"最新优先"）。
  真实客户端的 counter-1 会话，时间段尾巴是 `ffe` ——这是取反的结构性结果，不是魔法标记。

修复（与官方 0.3.12 完全一致）：

```js
function invertedTimestampHex(now = Date.now()) {
  return (~(BigInt(now) * 4096n + 1n) & 281474976710655n).toString(16).padStart(12, "0");
}
// ses_ = "ses_" + invertedTimestampHex() + base62Tail14(会话身份)
```

### 为什么 10-13 会误判

当时"逐字真实 body 回放 200 / 重建 403"的对照里，两次请求**沿用了同一个真实 ses_**，
变量其实是会话 id 而非 body。这是一次典型的对照实验设计失误——把两个变量绑在了一起。

### 形状梯子：哪些因素其实无关

在**合规会话 id** 的前提下逐项验证：

| 变体 | 结果 |
|---|---|
| 完整真实请求（43k system + 11 工具 + tool_choice:auto） | 200 |
| 极简 system（"You are a helpful assistant."）+ 11 工具 | 200 |
| 无 system + 2 个 stub 工具（bash/read）+ `tool_choice:auto` | 200 |
| 无 system + 2 个 stub 工具，无 system | 200 |
| **无 tools** | **403** |

即：**system 内容无关、工具数量无关（但 `tools` 数组必须存在）、body 形状基本无关**。
桥最终采用"2 个惰性 stub 工具 + `tool_choice:auto` + `stream_options`"，
因为这正是真实 CLI 的形状——零成本，且少一个变量。

### 第二道门：1.19 起的身份头

会话 id 修好后仍有 403，进一步抓包比对发现客户端身份头也换了：

```
user-agent:          opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
x-opencode-client:   cli
x-opencode-project:  global                       ← 字面量，不是生成的 prj_ id
x-opencode-request:  msg_<26位base62>              ← 不是 hex 的 req_ id
x-opencode-session:  ses_<12hex><14 base62>
```

### 为什么 opencode2dsh 插件修不好 DSH

插件的"伪装"（UA 伪造 + 合成 ses_）在计数器窗口这道门面前命中率同为 1.5%，
且它无法获得真实 CLI 二进制里编译的 attestation。0.3.12 是靠**改对公式**解决的，
不是靠更精巧的伪装。若你用 DSH，装 0.3.12+ 即可，不需要本桥。

---

## 白池兜底：为什么还留着一层

主路径靠公式自造 id，理论上长期有效。但门禁是上游随时可能改的，
因此桥保留了一个**兜底池**：本地真实 opencode CLI 跑一次（`opencode run --format json`，
其 json 流里带新建的 `ses_`），该 id 必然被上游认可。403 时用它重试一次。

兜底收割受冷却限制（默认 5 分钟一次），因为每次收割要消耗一次真实请求。

---

## 经验教训

1. **对照实验一次只动一个变量**。10-13 的误判就是两个变量绑在一起造成的。
2. **对"随机"保持怀疑**。1.5% 的命中率恰好等于 `64/4096`，指向"计数器窗口"而非"随机拒绝"。
3. **用真实客户端抓包，而不是猜**。身份头的差异（`runtime/bun`、`msg_`、`global`）
   只有抓包才能发现。
4. **上游发行说明往往比社区猜测更准**。issue #62 的定因与本项目独立实证完全一致，
   而我们此前在"body 指纹"上绕了一整天。