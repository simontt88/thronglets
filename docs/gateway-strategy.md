# Gateway 策划方案 — 采集 · Dispatch · 游戏化

> 状态：**Phase A–F 全部实现并各自闭环通过**（详见文末「实现进度」）
>
> 一句话：把 runtime 从「调用厂商 SDK 拿一段文本」改成「坐在模型 API 前面当网关」，
> 从此能看见 agent 干活的**全过程**——这是让 vibe coding 从"一团雾水"变成
> "清晰可见、好理解、有趣、流畅"的唯一地基。

## 实现进度（截至当前分支）

| 阶段 | 状态 | 关键文件 | 闭环测试 |
|------|:----:|---------|---------|
| **P0** 网关 PoC | ✅ | `src/gateway/proxy.ts` | `test/gateway-openai.ts` |
| **A** 模型三档 + per-task 切换 | ✅ | `gateway/models.ts` `gateway/directives.ts` | `test/gateway-model-switch.ts` |
| **B** 采集脊柱（SSE 流式 + trace） | ✅ | `gateway/sse.ts` `gateway/trace.ts` | `test/gateway-streaming.ts` |
| **C** Dispatch 引擎 | ✅ | `fleet/dispatch-engine.ts` | `test/dispatch-engine.test.ts` |
| **D** 游戏化内核 | ✅ | `fleet/game-state.ts` | `test/game-state.test.ts` |
| **E** Dashboard 时间线 + 游戏视图 | ✅ | `dashboard/components/ActivityTimeline.tsx` | `test/e2e-pipeline.ts` |
| **F** 自研 agent loop（北极星） | ✅ | `runtimes/native/` | `test/native-tools.test.ts` `test/native-loop.test.ts` `test/native-runtime.ts` |

- **Cursor 已弃用**：`CursorRuntime` 标注 `@deprecated` 并在运行时打警告；默认 runtime 改为 `codex`。
- 纯逻辑测试（C/D）已纳入 vitest CI；网关测试为独立脚本（需 `OPENAI_API_KEY`，兼作 demo）。
- 逃生阀：`THRONGLETS_GATEWAY_ENABLED=false` 一键回退到纯 SDK 调用。

---

## 0. 核心转变：数据源变了

旧地基（`src/runtimes/interface.ts`）：

```ts
interface AgentSession {
  send(text: string): Promise<string>;   // 全部信息量 = 最后一段文本
  close(): void;
}
```

系统对 agent 内部发生的一切只能看到**最后吐出来的那句话**。看不到读了什么文件、
改了哪几行、跑了什么命令、烧了多少 token。你想把一个黑盒游戏化，但数据源只有黑盒的
最后一句话——这就是"雾"的根因。

新地基（网关）：让每个 agent 把 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` 指向
本地网关，截获**完整协议流**：

- 每一次请求里的完整上下文（context window）
- 每一个 `tool_call`（OpenAI）/ `tool_use`（Anthropic）——文件读写、bash、grep，带完整参数
- 下一次请求里回带的 `role:"tool"` 结果——动作的**结果**（测试过没过、报错内容）
- `usage`：prompt / completion / cached / reasoning tokens → 成本、延迟
- 错误、限流、拒绝

比 `send()->string` 丰富 100 倍。**这是采集、dispatch、游戏化三件事共同的原材料。**

PoC 已验证（`test/gateway-openai.ts`）：OpenAI tool-calling 请求经网关 → 拦截
2 个 `get_weather` 调用 → 发出 `tool_call` 事件 ✅。

---

## 1. 取舍：弃用 Cursor

| Runtime | 模型流量 | 网关可观测 | 决策 |
|---------|---------|:---------:|------|
| **Cursor** | Cursor 自己的云 | ❌ 永远不行（流量不经过本机） | **弃用** |
| **Codex** | OpenAI API | ✅ `OPENAI_BASE_URL` 可配 | 主力（成本优先） |
| **Claude Code** | Anthropic API | ✅ `ANTHROPIC_BASE_URL` 可配 | 备用 / 高难度任务 |
| **Native** (Phase F) | OpenAI / Anthropic API（进程内自跑 loop） | ✅ 遥测直连总线，无需网关 | **北极星**：最彻底的控制 |

Cursor 在结构上就与"全程可见"的目标冲突——它的整条思维链都在 Cursor 云端，本机没有
拦截点。要让整条管线自洽（一切可见、可计费、可调度），就必须以可观测的 runtime 为核心。

**落地动作：**
- 默认 runtime 改为 `codex`，所有 `defaultModels` 与文档示例切到 codex/claude-code
- `CursorRuntime` 标记 `@deprecated`，README 对比表重写（不再宣传 Cursor primary）
- 不必第一天就删代码，但停止在任何新功能里支持它

---

## 2. 总体架构

```
            ┌──────────────────────────────────────────────────────────┐
   agent ──▶│  GATEWAY (传感器)  — 唯一的真相来源                          │
 (codex/cc) │  · 透传请求到 OpenAI/Anthropic                              │
            │  · 解析 tool_call / tool_result / usage / error            │
            │  · 归一化成 ThrongTrace 事件                                │
            └───────────────┬──────────────────────────────────────────┘
                            │  ThrongTrace events (bus.publish)
        ┌───────────────────┼───────────────────┬───────────────────┐
        ▼                   ▼                   ▼                   ▼
  ┌───────────┐     ┌──────────────┐     ┌──────────────┐   ┌──────────────┐
  │ 持久化     │     │ 指标引擎      │     │ Dispatch 引擎 │   │ 游戏状态      │
  │ trace.jsonl│     │ tokens/cost/ │     │ 文件锁/预算/  │   │ XP/stats/mood│
  │           │     │ 延迟/测试结果 │     │ 负载/能力路由 │   │              │
  └───────────┘     └──────┬───────┘     └──────┬───────┘   └──────┬───────┘
                            │                    │                  │
                            └────────────────────┴──────────────────┘
                                                 │  WebSocket (现有 ws.ts)
                                                 ▼
                              ┌──────────────────────────────────┐
                              │  DASHBOARD                         │
                              │  · 实时活动时间线（散雾）           │
                              │  · RTS 代码库地图（拟物）           │
                              │  · 任务/quest 卡片 · 成本仪表       │
                              └──────────────────────────────────┘
```

网关是整个系统的**单一传感器**。现有的 `FleetEventBus.publish()` →
`ws.ts` 已经把所有事件广播给前端，所以接入成本很低。

---

## 3. Layer 1 — 采集（Telemetry Spine）

目标：把网关从"打印 tool_call"升级成一条**机器可读、可回放、可统计**的事件流。

### 3.1 统一事件模型 ThrongTrace

把 Anthropic 与 OpenAI 两种格式归一化成一种内部事件：

```ts
type ThrongTraceKind =
  | "request"      // 一次模型调用开始（带 context 摘要）
  | "model_text"   // 模型产出的自然语言
  | "tool_call"    // 模型决定调用工具（name + input）
  | "tool_result"  // 工具执行结果（来自下一次请求的回带）
  | "usage"        // token / 成本 / 延迟
  | "error";       // 报错 / 限流 / 拒绝

interface ThrongTrace {
  agent: string;
  session: string;
  ts: string;
  kind: ThrongTraceKind;
  provider: "openai" | "anthropic";
  // kind-specific payload
  tool?: { id: string; name: string; input: Record<string, unknown>; summary: string };
  result?: { toolId: string; ok: boolean; preview: string };
  usage?: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; latencyMs: number };
  error?: { type: string; message: string };
}
```

落地：`src/gateway/proxy.ts` 里两个 provider 的解析器都产出 `ThrongTrace`，
统一经 `bus.publish("tool_call" | "tool_result" | "usage" | "error", ...)` 发出。
`types.ts` 的 `FleetEventType` 已含 `tool_call` / `tool_result`，仅需补 `usage`。

### 3.2 必须解决的三个技术点（按优先级）

**① SSE 流式透传（最高优先级 / 当前 PoC 缺口）**
当前网关用 `await upstream.json()`——**只对非流式请求有效**。真实 agent（Codex/
Claude Code SDK）几乎都用 `stream: true`，响应是 SSE。必须改成：
- 透传 `text/event-stream`，逐 chunk 转发给 agent（不破坏体验）
- 同时旁路解析 delta，拼出 `tool_calls`（OpenAI 的 function arguments 是分片拼接的）
- 这是 PoC → 生产的第一道关，没有它网关对真实 agent 不可用

**② Marker 不污染上下文**
现在用首条消息里的 `[GATEWAY_AGENT:name|session]` 标识 agent——会进模型上下文。
改进：网关读到 marker 后**在转发上游前删掉它**，模型永远看不到。干净、零副作用。

**③ tool_result 关联**
解析进来的请求体里 `role:"tool"`（OpenAI）/ `tool_result` block（Anthropic），
按 `tool_call_id` 与之前的 `tool_call` 配对，得到"动作 → 结果"完整时间线。
对 `bash` 结果做轻量解析（如 `npm test` 退出码、报错关键字）→ 喂给指标与游戏化。

### 3.3 持久化与派生指标

- 持久化：每个 agent/session 追加 `~/.thronglets/fleet/traces/{agent}/{session}.jsonl`
  （与现有 sessions 目录平行），成为可回放的"录像"。
- 实时派生：tokens 累计、$ 成本、平均延迟、工具调用次数、触碰文件集合、命令列表、
  错误率、测试通过率。这些是 dispatch 与游戏化的输入。

---

## 4. Layer 2 — Dispatch（从"问 LLM"到"策略引擎"）

现状（`src/fleet/dispatcher.ts` + `tools.ts`）：dispatcher 是个 LLM agent，读
`fleet_status` 文本然后用自然语言决定派给谁。有了遥测，可以加一层**结构化决策**，
让 LLM dispatcher 调用，或在网关里直接当护栏运行。

### 4.1 网关解锁的调度策略

| 策略 | 依赖的遥测 | 网关能做的动作 |
|------|-----------|---------------|
| **成本感知路由** | 每 agent 累计 $ | 贵活给强模型、杂活给便宜模型；超预算时网关**直接拦请求**返回合成错误 |
| **文件归属防撞车** ⭐ | tool_call 里的文件路径 | 维护实时"文件锁地图"；A 正在改 `auth.ts` 时，B 对它的写入被网关**拦截/告警** → 协议级防 merge 冲突 |
| **负载/健康路由** | tool_call 速率 | 区分"真在干活"vs"状态卡 working"；把任务派给真空闲的 throng |
| **能力/专精路由** | 按任务类型的历史成功率 | throng 形成"技能"，对口任务优先 |
| **难度升级** | 错误率 / 反复 thrashing | 检测到一个 throng 在原地打转 → 通知 dispatcher 换更强模型重派 |

⭐ **文件归属防撞车是杀手锏**：多 agent 协作最大的痛是同时改一个文件导致冲突，
网关在协议层就能阻止，这是 SDK 集成永远做不到的。

### 4.2 工程形态

- 新模块 `src/fleet/dispatch-engine.ts`：消费 ThrongTrace 流，维护文件锁地图、
  预算账本、每 agent 能力画像；暴露 `suggestRoute(task)` 与 `checkWrite(agent, file)`。
- LLM dispatcher 通过新工具 `fleet_route_suggest` 咨询它（保留 LLM 的灵活性）。
- 硬护栏（预算、文件锁）直接在网关 `handle()` 里执行，不依赖 LLM 守规矩。

---

## 5. Layer 3 — 游戏化（真信号驱动）

Roadmap 早就想要"creature mood 反映真实表现 ... 成为 reward loop 的一部分"
（README:358-359）。过去做不到是因为没有真信号——网关把信号补齐了。
PixelThronglet 已有 working/waiting/sleeping/dead 的情绪动画，现在喂真实状态即可。

### 5.1 情绪 = 真实状态（不再纯装饰）

| Mood | 触发信号（来自遥测） |
|------|---------------------|
| 🧠 thinking | 模型延迟高、还没发出 tool_call |
| ⚙️ working | tool_call 高频，正在读写跑 |
| 😖 stuck | 连续 tool_result 报错 / 反复改同一文件无进展 |
| 🎉 triumphant | 刚检测到 `npm test` 通过 / 任务完成 |
| 😴 exhausted | 单任务 token 烧穿阈值 |
| 💀 dead | 会话永久失败 |

### 5.2 成长系统

- **XP**：来自真实事件——测试通过(+大)、文件交付、低于预算完成、修复 bug。
  全部由网关观测到的 tool_result 推导（如 bash 退出码 0）。
- **属性**：每 throng 累积 Speed(延迟) / Efficiency(token/任务) /
  Reliability(错误率) / Specialization(最常碰的工具与目录)。
- **奖励回路（human-in-loop）**：Roadmap 的"pet your throng"——用户在 Telegram /
  dashboard 对结果 👍/👎，记入该 throng 的信任分，可反哺路由（用户信任的 throng 优先派活）。

### 5.3 头牌体验：RTS 代码库地图

把代码库渲染成游戏世界（文件/目录 = 地块）。throng 的动作肉眼可见：

- 读文件 → creature 走到该文件去"查看"
- 改文件 → 在该文件上"施工"
- 跑测试 → 一个可见的"动作"，带成功/失败结果反馈
- 两个 throng 想碰同一文件 → 视觉上的"争用"提示（呼应 4.1 文件锁）

这就是"清晰可见、有趣、流畅"的兑现点——vibe coding 从"发消息后干等"变成
"看着我的单位在代码库地图上移动、施工、跑测试、升级"，**可观战 + 可指挥**。

### 5.4 任务管理器 = Quest 系统

把 task manager 框架成 quest：一个任务 = 一张 quest 卡（目标、指派的 throng、
实时进度=工具活动+测试状态推导、完成判据）。现有 `taskLedger`
（`manager.ts:120`）已是雏形，升级为带实时进度的 quest 即可。

---

## 6. 分阶段路线图

每个阶段都可独立交付 + 有一个可演示的"爽点"。

| 阶段 | 交付物 | Demo 爽点 |
|------|--------|----------|
| **P0 ✅ 已完成** | 网关 PoC，双协议 tool_call 拦截 | `test/gateway-openai.ts` 跑通 |
| **P1 采集脊柱** | SSE 流式透传 · marker 不污染 · tool_result 配对 · ThrongTrace 持久化 · usage 事件 | 一条完整机器可读的活动流 |
| **P2 活动时间线** ⭐ | Dashboard 实时逐 throng 动作流（📖✏️▶️🔍 + 结果）+ token/成本仪表 | **第一次"看见" agent 在想什么、做什么——散雾** |
| **P3 Dispatch 引擎** | 文件锁防撞车 · 成本预算硬护栏 · 负载/健康路由 | 多 agent 协作不再撞文件；超预算自动拦 |
| **P4 游戏化内核** | XP/属性/真实情绪 · 奖励反应 | 你会真的为一只 throng 升级而开心，为它 stuck 而心疼 |
| **P5 RTS 地图** ⭐ | 代码库即世界的实时观战视图 · quest 卡 | 头牌体验，截图/视频即传播素材 |
| **P6 北极星** ✅ | 自研 agent loop（`runtime: native`，不依赖厂商 SDK，进程内直接跑 tool 循环） | 更彻底的控制：会话中途换模型、协议级注入工具、最多调度策略 |

P1 + P2 是"一鸣惊人"的最短路径——先把雾散掉。

### Phase F 落地说明（自研 loop）

`runtime: native` 选中 `src/runtimes/native/`。与网关路线的关键区别：

- **进程内自跑循环**：`AgentLoop.run()` 直接 `调用模型 → 解析 tool_call → 本地执行 → 回灌结果 → 再循环`，
  直到模型给出最终文本。不再经过 codex-sdk / claude-agent-sdk。
- **遥测直连总线**：因为 loop 在我们手里，`tool_call/tool_result/usage/model_switch` 事件**直接 publish** 到
  `FleetEventBus`——无需 marker、无需 SSE 重组。Dispatch + 游戏化照常订阅，native throng 直接在 Dashboard 点亮。
- **真·任务中途换模型**：模型在**每一步**前读 `directiveStore.consumeTier()`，可在两次 tool 调用之间 small→large。
- **双 provider**：`agent-loop.ts` 用 adapter 抽象 OpenAI（chat completions）与 Anthropic（messages），
  按 model id 自动判定（`claude*` → anthropic）。
- **工具集**：`read_file / write_file / edit_file / list_dir / grep / run_bash`，在 workspace 内本地执行。

闭环测试：`test/native-tools.test.ts`（执行器）+ `test/native-loop.test.ts`（脚本化 transport 跑通整圈循环、
模型切换、双 provider 适配）+ `test/native-runtime.ts`（真实 OpenAI 流量端到端）。

---

## 7. 关键风险与对策

| 风险 | 说明 | 对策 |
|------|------|------|
| **SSE 流式（最大）** | PoC 只支持非流式；真实 agent 都流式 | P1 第一优先级，先做流式透传 + delta 拼接 |
| **网关持有密钥** | 网关代理所有模型流量，是高价值目标 | 只绑 `127.0.0.1`（现状如此）；密钥仅驻内存；trace 落盘脱敏 |
| **per-agent 关联** | Codex SDK 全进程共享 `OPENAI_BASE_URL` | marker 方案够用（P1 改为转发前剥离）；北极星阶段自研 loop 可改用独立路由 |
| **成本失控** | 多 agent + 强模型烧钱快 | P3 预算硬护栏；默认 gpt-4o-mini / haiku |
| **厂商 SDK 易碎** | Codex/CC SDK 升级可能变协议 | 网关只依赖 wire protocol，比 SDK 集成更稳；北极星阶段彻底摆脱 SDK |

---

## 附录 A — 当前代码接入点

- `src/gateway/proxy.ts` — 网关本体（已有 Anthropic + OpenAI 双解析器）
- `src/runtimes/codex.ts` — 已设 `OPENAI_BASE_URL` 指向 `/gateway/openai`
- `src/runtimes/claude-code.ts` — 已设 `ANTHROPIC_BASE_URL` 指向 `/gateway`
- `src/server/index.ts` — 已挂载两个网关路由
- `src/fleet/manager.ts` — `FleetEventBus.publish` / `taskLedger` / `getStatus`
- `src/server/ws.ts` — 事件已自动广播给前端
- `packages/dashboard/src/components/PixelThronglet.tsx` — 情绪动画载体
- `THRONGLETS_GATEWAY_ENABLED=false` — 一键关闭网关的逃生阀
