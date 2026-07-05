# Workflow Runtime — P2 收尾与 P3 执行方案

> Status: **v2, review applied**（2026-07-05）。v1 的六条 review 发现全部
> 采纳：D18 循环依赖已解（entry = P2 merged；D18 改为 Step 1 exit gate /
> Step 4a entry gate）；P3 范围回退到主提案既有 phase discipline
> （script → P4、parallel/join → P5、compaction 不进 P3 acceptance）；
> Step 2 增加非 model 节点 runner 语义先行设计；Step 3 改为先定 waiting
> durability 契约再写 emitter；原 Step 4 拆为 4a（反转+删除）/4b（功能
> 跟进）；每步补 focused gates。
> 本文从属于 `workflow-runtime-v1.md` —— 那边的 Accepted Slice 表仍是
> 唯一执行契约；Stage 1 的产出是把 P3 写进那张表（第七轮 pass）。
> 前提事实：P0/S2/S3/P1/P1.5/S1 已合入 main；P2 在 `feat/workflow-p2`
> 上实现完成且 post-review 修复已落，未提交。

## Stage 0 — P2 收尾（feat/workflow-p2）

三个 review 残留的处置（已达成一致，不拦 P2）：

| 残留 | 处置 | 去向 |
| --- | --- | --- |
| 纯内存 workflow notification（actor inbox 无持久化） | 不改。durable truth 在 `WorkflowRunRecord` / store events；inbox 是 living-process 通知面 | P3 Step 3 的**契约输入**：waiting durability 契约先行时一并消化 |
| prepare 后段 lease TTL 泄漏（30 分钟有界） | 不改。健壮性优化，非契约破口 | 署名 backlog，任意后续小提交可修，不挂相位 |
| `resolveRunAccessFields` 双重强转 | 不改。core/API 类型整洁债，与 workflow 无关 | core debt backlog，不进本提案范围 |

执行项：

1. 跑一次全量 `npm run release:check`（wrap-up 全量门，迭代期不重复跑）。
2. 通过后提交 `feat/workflow-p2`；PR 由用户触发（Model A：
   main → PR → `--merge` → 删分支 → pull）。

## Stage 1 — 第七轮 pass（只修主提案契约，不重划相位边界）

四条修订，P2 合入后、P3 开工前完成（小分支即可）。P3 行**服从**既有
Phase discipline（P3 = `command/task/delegate/human`；P4 = `script` +
node API；P5 = `parallel/join`），不定义"大 P3"：

1. **Accepted Slice 表增加 P3 行**：
   - *Entry condition*：**P2 合入 main。仅此一条。** D18 不是 P3 入场
     条件（那是循环依赖——D18 正是 P3 Step 1 要完成的事）；D18 的主提案
     语义是"actor episode spawning 之前必须满足"，映射为 Step 1 的
     exit gate 与 Step 4a 的 entry gate。
   - *In slice*：非 model 节点 runner 语义设计决策；`command` / `task`
     / `delegate` / `human` 节点；`waiting` durability 契约 + 首个
     emitter（D21 reliable 成员）；actor-owned episode driver 反转 +
     退役 `startSupervisedRunChain`；per-episode catalog 收窄；
     escalation ladder / cruise mode（D6 预算规则）；`workflow_start`
     决策（D11）；`diff_scope` verifier + node-entry epoch marker；
     `task_terminal` 排序决策。
   - *Explicitly out*：`script` 节点与 stdio JSON-RPC node API（P4，
     既有 discipline）；`parallel`/`join`（P5）；node-boundary
     compaction **实现与接线**（保持 D10 的 deferred 状态，由第一个
     需要它的相位认领，不进 P3 acceptance）；workspace-root 状态提升
     （D5）；两阶段 PreToolUse（D20）；`workflow distill` 及 parking
     lot。
   - *Deletion bound*：Step 4a 落地 episode driver 时退役
     `startSupervisedRunChain` —— 三个 run-chain owner（core
     continuation / `startSupervisedRunChain` / workflow episodes）
     归一为一个驱动器。
2. **`diff_scope` 重新归位**：原文"later in P1 or P1.5"已成悬空承诺
   （两阶段均未交付），改为明确挂 P3 Step 2（随节点扩展补 node-entry
   epoch marker）。
3. **`task_terminal` 排序决策升格为 P3 Step 2 入口决策**：Stop hooks
   先于 `waitForAwaitedTasksBeforeTerminal`，Stop 处 verifier 读
   pre-await 状态、每次唤醒多付一轮 forced turn；Step 2 开工时二选一
   （接受成本 / 把 await 挪到 gate 前），不再以事实注脚形式存在。
4. **Phase Status 记录 Stage 0 三残留的归属**，使 P2 release-gate 声明
   对"推迟了什么"诚实（保事实、调信号）。

## Stage 2 — P3 执行序列（严格顺序）

主线：**先消灭 run-chain 多头，再扩节点，再反转 actor。** 每步沿用
既有节奏：迭代期跑子集，步末跑该步 focused gates，Stage 末尾一次
`release:check`；每步兑现自己的删除/退役承诺（rule zero）。

### Step 1 — todo-chain 表达为退化 workflow（exit gate = D18）

- 把 host supervisor 的 todo-continuation chain 用现有 P1/P2 workflow
  基元表达为一个退化（单节点/线性）workflow。
- **Exit gate = D18 满足**：行为等价 + `startSupervisedRunChain` 的
  归一方案定稿（本步可并存，Step 4a 完成删除）。
- 等价性验收标准（开放决策 #3）在本步开工前定：哪组既有 supervisor /
  run-chain 测试构成"等价"，全绿为准。
- Focused gates：host runtime supervisor/run-chain 测试 +
  workflow projection 测试；任一红即停。

执行记录（2026-07-05）：

- 最小落地选择：先完成退役路径证明，而不是提前反转 actor。新增
  `agent-runtime/src/workflows/run-chain.ts`，由 workflow 包拥有通用
  `runWorkflowRunChain()`；`runTodoSupervised()` 改为通过该 driver 表达
  todo-continuation chain，保持原有 todo audit / continuation count /
  stalled-progress 语义。
- `startSupervisedRunChain()` 暂不删除，边界收窄为 host
  active-run/session/lease/event glue；Step 4a 删除路径明确为：actor-owned
  episode driver 取代这个 host wrapper，并复用 workflow-owned run-chain
  driver，避免留下第三个 run-chain owner。
- Focused verification：agent-runtime workflow driver/todo supervisor tests、
  host workflow fresh/resume/supervisor tests、host protocol run.resume todo
  path、workflow projection resume tests、agent-runtime/host typecheck 均通过。

### Step 2 — 非 model 节点（先定 runner 语义，再写节点）

- **入口交付 ①：runner 语义设计决策（先于任何节点代码）。** 现状事实：
  类型层已列 `model|command|delegate|task` 但 projection 硬拒非 model
  节点（`validateP1WorkflowDefinition`），parser 拒绝 `human`。必须
  回答"非 model 节点由谁执行"：
  - 推荐方向：**host 在节点边界自动执行**，经受治理基元——`command`
    节点走 verifier 命令既有通道（D16 instantiation-time 授权 +
    argv-token 绑定）；`task`/`delegate` 节点由 host 启动对应基元、
    用 `waiting_tasks` + awaited predicate 等待（D9 host-owned
    episode lifecycle 的先例）。
  - 红线：非 model 节点**不得**退化为"model node with tool hints"
    （那不是 deterministic plane，模型仍可跑偏）。
  - 决策记入主提案（第七轮 pass 之后的增量决策条目）。
- **入口交付 ②：`task_terminal` 排序二选一**（Stage 1 第 3 条）。
- 然后落地 `command` / `task` / `delegate` 节点（supervised projection
  内，复用现有 run loop）+ `diff_scope` verifier + node-entry epoch
  marker。
- Focused gates：core run-loop 测试（尤其 await/Stop 排序若改动）+
  host workflow projection/parser 测试 + agent-runtime workflows
  测试 + 协议 schema fixtures；探针阶梯对每个新节点类型走 ①→④。

**2026-07-05 execution note:** Step 2 entry decision accepted
Stop-before-await for `task_terminal`; the cost is one extra workflow/revival
forced turn after an awaited task wake. Supervised projection now drains
`command` / `delegate` / `task` nodes at node boundaries through host governed
primitives (`command` hook action, `delegate_agent`, `task_create`) until the
next model node. `diff_scope` uses a projection-owned node-entry write epoch
marker over FactLedger write facts. Actor-owned terminal handling for arbitrary
non-model graphs remains Step 4; human/waiting durability has not started.

### Step 3 — waiting durability 契约先行，`human` 节点随后

- **入口交付：waiting/outbox durability 契约。** D21 要求 `waiting`
  是 qos reliable——丢一条"等待输入"= 静默悬挂的 workflow；而现状
  `FileTaskNotificationOutbox` 只支持 terminal task actor
  notifications，不覆盖 workflow waiting。契约必须先回答：reliable
  在跨进程/崩溃场景如何兑现（扩展 file outbox 家族 / workflow 专属
  outbox / 复用 store events 重放），Stage 0 残留 #1（纯内存队列）
  在此一并消化。**契约定稿前不写 emitter。**
- 然后 `human` 节点作为首个 emitter，payload 携带 `wait.kind`；
  人工干预（interrupt / re-scope / skip node）定义为提交给 actor 的
  事件、节点边界消费——本步以事件记录落地，Step 4a 迁给 actor。
- Focused gates：actor inbox / file-notifications 测试 + store
  resume 测试 + 协议 fixtures（waiting 成员首次上线）。

**2026-07-05 execution note:** waiting durability chose a workflow-native
file-backed actor outbox plus workflow-store truth, not an extension of the
legacy task notification JSON format. `FileWorkflowNotificationOutbox` persists
actor-native workflow notifications; `WorkflowRunRecord.status:"waiting"` and
store `waiting`/`input` events remain the durable state of record. `human`
nodes now parse and park supervised projections by emitting `workflow.waiting`
and a waiting snapshot. `workflow.resume` is the supervised input event
consumer for this slice: it records an `input` event, clears `wait`, advances
the human node with a passed verdict, then starts the next ordinary host run.
Step 4a moves this input consumption to the actor-owned episode boundary.

### Step 4a — episode driver 反转 + 删除兑现（entry gate = D18）

- **只做两件事**：workflow actor 常驻、拥有节点位置 / attempts /
  evidence / transitions / resume，episode 为临时 worker（host
  `createRun`，delegate child-run 先例，agent-runtime 零 model/config
  依赖）；**同一步内退役 `startSupervisedRunChain`**。
- 注意现状：`startSupervisedRunChain` 是 run resume 与 workflow
  resume 的实际驱动路径——删除即迁移，不留第三个并行机制窗口期
  （开放决策 #4 倾向一步切换，本步定稿）。
- 功能堆叠（catalog/budget/workflow_start）一律不进本步，防止
  rule-zero 删除被挡。
- Focused gates：workflow resume / run-chain 等价性测试（Step 1 定的
  那组）+ host runtime 全量 + CLI resume 冒烟。

Implementation note (2026-07-05): `startSupervisedRunChain()` is retired from
host source/tests. Fresh run, `run.resume`, and `workflow.resume` now enter
`startWorkflowActorEpisodeChain()`, which keeps the workflow/todo actor resident
over the chain while host `createRun()` creates transient worker episodes.
Workflow records mark `metadata.episodeDriver:"workflow_actor"` and
`episodeKind`; `workflow.resume` consumes human input waits at the actor
boundary before the next worker run starts. Step 4b items remain separate and
must not be folded into this deletion landing.

### Step 4b — 反转后的紧随小步（各自独立提交）

1. per-episode catalog 真收窄（替代 P1 PreToolUse 软钳制的硬化路径）；
2. escalation ladder / cruise mode（D6：per-attempt 独立预算 +
   workflow 总额；attempt 级 model ref + usage 快照入
   `WorkflowRunRecord`）；
3. `workflow_start` model-facing 工具决策（D11 推迟至此，做或明确
   不做都要记录）。若做，以下为硬约束（2026-07-05 对话定向）：
   - **递归默认关死**：episode 目录默认不含 `workflow_start`；递归
     实例化需节点 manifest 显式声明 + 深度上限（复用 delegate 深度 /
     `DelegationLedgerKey` 先例；窄默认沿 P1.5 #4）；
   - **授权钳制**：实例化授权 ≤ 触发 run 的 access mode，D16 全有
     或全无，无交互式兜底；
   - **两种归属语义分开定**：附着式（投影当前 run，终态按 D3 染 run
     outcome）vs 派生式（独立实例 + 任务句柄，父 outcome 默认不
     耦合，窄默认）；
   - **派生式实例出生即挂统一任务谱系**（background-task-lifecycle
     的 fg→promote→bg + revival 白拿），**禁止**为 workflow 单做
     后台机制——否则是第四个并行后台机制（rule zero）；

Implementation note (2026-07-05, item 1): worker episodes now receive a
catalog filtered to the active model node's `tools` list at `createRun()` time,
and workflow records stamp `episodeAllowedTools`. Because the current worker can
still advance across model nodes inside one core run, the P1 PreToolUse clamp
remains as a fallback for mid-run transitions; when a tool is absent from the
worker catalog, the clamp stands down so core reports `TOOL_NOT_FOUND`.
P3 review follow-up: if that filtered worker catalog includes deferred tools,
host appends a scoped `tool_search` whose descriptor source is the filtered
catalog, not the parent catalog, and PreToolUse allows that available
infrastructure tool. This keeps deferred schema loading usable while preserving
hard catalog narrowing. The same follow-up keeps the clamp's allowlist
comparison canonicalized, so legacy workflow declarations such as
`tools: [read_file]` continue to allow the canonical worker tool `read`. Treat
"landed" in the Phase Status log as implementation status, not a PR-ready
correctness claim; this follow-up is part of P3 acceptance hardening before
merge.

Implementation note (2026-07-05, item 2): the D6 worker-entry substrate is
landed without claiming full retry escalation. Model nodes now parse `model`
and `runBudget`; host resolves the active node's model ref, creates the worker
episode with that adapter and per-attempt budget, and persists
`workflowEpisode`, `workflowEpisodeUsage`, and aggregate `workflowUsage` facts
on `WorkflowRunRecord.metadata`. Actual retry-time model escalation still waits
for the model-node boundary split that turns each attempt into a fresh worker
episode; cruise-mode policy and node-boundary compaction remain out of this
item.

Implementation note (2026-07-05, item 3): D11 is resolved as **do not ship
`workflow_start` in P3**. The current host runtime's `startRun()` path is
single-active-run connection glue, so a model tool that re-enters it would mix
active-run ownership with spawned workflow task lifecycle, recursive catalog
exposure, access clamping, and trace/record ownership before those contracts
exist. P3 therefore keeps workflow instantiation on CLI/config/protocol request
surfaces; episode catalogs continue to omit `workflow_start` by default. A
future slice may re-open the spawn-shaped form only with explicit recursion
depth, authorization clamp, unified task lifecycle birth, and trace doctrine
tests.
   - **trace 教义**：父 run trace 只记点火事实 + workflowId + 通知；
     episode 各有各的 trace；跨 run 真相 = record + store events，
     永不合并大 trace（trace not a bus）。
- Focused gates：各自对应包测试 + 探针阶梯 ⑤（升级阶梯）。

### 探针阶梯（每步一个变量，沿用 D7）

新增节点类型逐个过 CLI QA 探针：① 单节点 + 单 verifier + nano/haiku →
② 两节点线性转移 → ③ onFail retry → ④ clamp 服从 → ⑤ 升级阶梯。
①失败即停梯。阶梯覆盖行为面；协议/持久化/恢复面由各步 focused
gates 覆盖，两者不互相替代。

## Stage 3 — P3 之后（服从既有 discipline，不预定新契约)

P3 close-out note (2026-07-05): after Step 4b.3, Step 5/6 are **not entered**.
`workflow-runtime-v1.md` still keeps `script` nodes + stdio JSON-RPC node API
in P4, `parallel`/`join` in P5, and node-boundary compaction implementation /
wiring deferred until a later phase explicitly accepts it. Do not widen P3 by
continuing into those items from this execution plan.

- **P4 = `script` 节点 + stdio JSON-RPC node API**（主提案既有相位：
  TracedProcessRunner / `stdio-v1` 家族成员，shell-sandbox 分级，
  红线：脚本永不写 trace）。node-boundary compaction 接线若被 P4
  认领（episode 边界是自然触发点），在 P4 行里写明。
- **P5 = 有界 `parallel` / `join`**（复用 `delegate_parallel` /
  background tasks，不造第二个调度器）。
- 其余从池子按"退役一个旧并行机制 + 有真实客户"选片：self-hosting
  （plan mode / todo doctrine 重建为 workflow 集合，D18 已是先例）>
  `workflow distill`（经济学论题兑现点）> shadow mode + 节点级遥测 >
  workspace-root 提升（D5）、两阶段 PreToolUse（D20）、unattended
  模式、benchmark harness、TUI 节点进度行。

2026-07-05 对话新增三条 Stage 3 记录：

- **D5 workspace-root 提升登记首个真实客户**："主 agent 点火 →
  workflow 脱离 session、独立进程凭 lease adopt 续跑"的
  detached/service 情景（tmux 类比：可异地重挂、宿主死了也能从文档
  复活）。session-root 在 P3 形态（session 内点火 + 句柄等待 + 后台
  提升）下完全够用；D5 与 unattended 切片绑定、一次付清，明确不拉进
  P3。
- **跨提案排序约束（session-agent-host-coordinator.md）**：coordinator
  v3 的 SessionTurn/run-chain 建模围绕保留 `startSupervisedRunChain`
  （"create child/delegate/continuation runs as host semantics
  require"），与 Step 4a 的删除承诺冲突。约束：coordinator P1 拆两半
  —— port 半（`SessionTurnFactory` 接口、scheduler、queue、幂等、
  workspace lock/pool、core `canAcceptCommand()`）可先行；**host
  工厂的 chain 语义半必须等 Step 4a 之后包装归一 driver**，否则制造
  第四个 run-chain owner。待办：给 coordinator 提案写 v4 note——
  ① host 工厂目标改为 post-D18 归一 driver；② workflow `waiting`
  触发 turn 让出 worker slot（复用 workspace-lock 的 park/wake
  机制）；③ episode/cron/续轮统一走 host-minted `system` source。
- **资产供给先行（价值上限 = workflow 形态任务的供给量）**：P3 期间
  即选 2–3 条真实内部管线（QA 回归、release 门子集）作为首批
  dogfood 资产；探针阶梯高阶（③⑤）改用真实管线代替合成 fixture，
  Step 4b 升级阶梯由此获得真实客户。这是 Stage 3
  self-hosting / distill 的前置侦察，不改变其排序。

## Stage 4 — P4 执行方案（script 节点 + stdio JSON-RPC node API）

入口事实（2026-07-05）：PR #47 已合入 main（merge commit
`8593b4a8`），本地从 main 拉出 `feat/workflow-p4`。P4 继续服从
`workflow-runtime-v1.md` Accepted Slice；P3 的 D11 结果不重开：
本阶段不实现 `workflow_start`，任何 spawn 形态未来仍必须满足 D26。

P4 处置三个悬置项：

| 悬置项 | P4 处置 |
| --- | --- |
| node-boundary compaction 接线 | **明确不做。** D10 的表达能力保持为事实，但 P4 的风险面已包含进程/RPC/授权；compaction 接线留给第一个直接需要上下文治理的后续片。 |
| 4b.2 遗留 retry 时模型升级 + cruise-mode 策略 | **明确不做 retry escalation。** P4 只兑现 deterministic script cruise（零模型节点执行）；retry-time 模型升级仍等待 model-node boundary split，把每次 attempt 变成独立 worker episode。 |
| asset-supply-first | **本阶段做。** 新增 2–3 条真实内部 workflow 资产（release 子集、workflow runtime 子集等），高阶探针优先用这些资产，不再只靠玩具 fixture。 |

### Step 0 — 契约与失败即停线

- Accepted Slice 表补 P4 行，写清 entry / in slice / explicitly out /
  deletion bound。
- 本节作为执行记录入口；后续每步记录 focused gates 与结果。
- 失败即停：发现 P4 需要重开 `workflow_start`、引入表达式语言、或新造
  第二套进程管理，即停并回报。

### Step 1 — 类型 / parser / dogfood 资产

- `WorkflowNodeExecuteKind` 增加 `script`，资产 parser 支持
  `execute: script`、相对 `scripts/` 路径、参数/env/stdin/timeout/output
  限制、能力声明。
- 新增真实内部 workflow 资产，覆盖 release 子集和 workflow runtime
  子集；资产只声明能力，不直接持有能力。
- Focused gates：agent-runtime workflow type tests；host workflow parser /
  asset tests；`npm --workspace @sparkwright/agent-runtime run typecheck`；
  `npm --workspace @sparkwright/host run typecheck`。
- 失败即停：脚本路径可逃逸资产目录、资产能力变成运行时授权、或 dogfood
  资产只能靠合成 fixture 才能解释。

Implementation note (2026-07-05): `WorkflowNodeExecuteKind` now includes
`script`; host asset parsing accepts asset-local script paths, args/cwd/env/
stdin/timeout/output limits, capability declarations, and stores
`sourceDir/sourcePath` on the pinned definition snapshot for resume. Parser
tests cover script parsing and asset escape rejection. Two builtin dogfood
assets landed: `release-check-focused` and `workflow-runtime-p4-smoke`.

### Step 2 — stdio JSON-RPC node API

- 在 `TracedProcessRunner` / `stdio-v1` 家族内实现 node API 子进程协议：
  JSON-RPC 走 stdin/stdout，遥测继续走 stderr token；脚本不写 trace。
- Node API v1 方法：`initialize`、`progress`、`getEvidence(nodeId)`、
  `complete(result)`、`fail(reason)`，以及经 host 治理基元的窄
  primitive 调用入口。
- 沙箱复用 shell-sandbox 分级；host 将资产声明映射到 access clamp，
  D16 授权全有或全无。
- Focused gates：host traced-process/node-api tests；workflow script node
  tests；stderr telemetry parsing tests。
- 失败即停：stdout 被当作遥测、脚本可直接写 trace、或 RPC 能绕过 host
  policy/approval/access clamp。

Implementation note (2026-07-05): `TracedProcessRunner.runJsonRpc()` runs a
newline-delimited JSON-RPC child protocol over stdout/stdin while preserving
stderr `SPARKWRIGHT_EVENT` telemetry. `workflow-node-api.ts` exposes script
methods `initialize`, `progress`, `getEvidence`, `invoke`, `complete`, and
`fail`; `invoke(command)` routes through the existing configured workflow hook
command primitive, and declared `write` capability is rejected when the parent
run is read-only.

### Step 3 — stdio progress sampler 删除兑现

- 把 `external-command-agent` 的私有 progress head/tail 采样器迁到
  `TracedProcessRunner` 共享 helper；external command delegates 与 script
  node API 共享同一 stdio-v1 telemetry 采样形状。
- 保留 P3 hook-bound 非 model runner；actor-bound deterministic executor
  迁移风险较高，明确不折进 P4 script slice。
- Focused gates：host traced-process tests；external-command-agent progress
  tests；workflow script node tests。
- 失败即停：script node API 或 external command delegate 出现第二套 stderr
  telemetry parser / progress sampler，或 stdout 被重新用作遥测。

Implementation note (2026-07-05): `createProcessProgressSampleCollector()` now
lives in `traced-process-runner.ts`; `external-command-agent.ts` deleted its
private progress head/tail collector and consumes the shared helper. Script
node API and external command delegates therefore share the same stdio-v1
progress sampling family.

### Step 4 — P4 收尾

- 跑 P4 focused gates，再跑一次全量 `npm run release:check`。
- 通过后提交 P4（不加 Co-Authored-By），再进入 P5 契约先行。
- 相位简报包含：交付、删除兑现、全量门、契约/决策修订、P5 入口条件。

Implementation note (2026-07-05): focused gates passed for host workflow
parser/projection/script tests, traced-process JSON-RPC tests, external command
progress tests, agent-runtime workflow tests, and agent-runtime/host typecheck
and build. Full `npm run release:check` remains the P4 closing gate before the
P4 commit.

## Stage 5 — P5 执行方案（有界 parallel / join）

入口事实（2026-07-05）：P4 已提交在当前分支（`a83104fb
feat(workflows): add script node api`），P4 closing gate `npm run
release:check` 通过。P5 继续服从 `workflow-runtime-v1.md` Accepted
Slice；D11/D26 不重开，不实现 `workflow_start` 或 spawn-shaped workflow
instantiation。

P5 对 D21/D23/D24 的组合裁定：

| 既有决策 | P5 组合 |
| --- | --- |
| D21 workflow instance identity / notification contract | branch 状态只写入同一个 `WorkflowRunRecord.parallelBranches`；通知仍携带 workflow instance id，不新增 branch notification family。 |
| D23 fail-closed projection | `parallel` / `join` 仍由 projection hooks 执行；parser/constructor 对 unsupported branch kinds fail closed；runtime projection error 仍走 existing gate-specific fail-closed path。 |
| D24 interruption / cancellation | cancellation / budget / doom-loop 仍记录 workflow interruption；P5 不新增 branch cancellation bus。已完成 branch state 保留，未完成 branch 不再被调度。 |

### Step 0 — 契约与失败即停线

- Accepted Slice 表补 P5 行，写清 entry / in slice / explicitly out /
  deletion bound。
- 本节作为执行记录入口；P5 明确只做 bounded non-model branch fan-out +
  persisted branch-state join。
- 失败即停：需要多 model episode 并行、branch-local transition interpreter、
  implicit expression/dataflow、或 workflow-owned task/delegate scheduler，即停并回报。

### Step 1 — 类型 / parser / durable branch state

- `WorkflowNodeExecuteKind` 增加 `parallel` / `join`。
- `parallel` node parser 支持 `branches`、`maxConcurrency`；`join` node
  parser 支持 `waitFor`。
- `WorkflowRuntimeState` / `WorkflowRunRecord` 增加 portable
  `parallelBranches`，store parse/clone/update/resume 保留该状态。
- Focused gates：agent-runtime workflow/store tests；host workflow parser
  tests；agent-runtime/host typecheck。
- 失败即停：branch state 只存在 host metadata、resume 丢 branch verdict、或
  parser 接受嵌套 parallel/model/human branch 而没有 fail-closed 规则。

Implementation note (2026-07-05): agent-runtime now carries portable
`parallel` / `join` node declarations plus durable
`WorkflowRunRecord.parallelBranches` / `WorkflowRuntimeState.parallelBranches`.
The state machine validates branch/wait targets and preserves branch state
across `goto` / `retry` / `complete` / `fail`; `FileWorkflowStore` parses,
clones, updates, and reloads branch verdict/evidence. Host workflow parsing
accepts `parallel.branches`, `parallel.maxConcurrency`, and `join.waitFor`,
rejects duplicate branch ids, and keeps branch kinds as structural declarations
for projection-time validation.

### Step 2 — projection 执行与 join barrier

- `parallel` 作为 non-model drain 节点执行 bounded branch fan-out：
  branch node 仅允许 `command` / `delegate` / `task` / `script`；all-delegate
  branch set 优先走既有 `delegate_parallel` tool；task branch 继续走
  `task_create` / task store，不新增 workflow scheduler。
- branch node 的 `onPass` / `onFail` 在 P5 不解释；跳转只由
  `parallel` / `join` 节点自己的 verdict 通过既有 `advanceWorkflowState`
  查表。
- `join` 只读取持久 `parallelBranches`，所有 `waitFor` branch passed 则
  passed；任一 failed/runtime_error 则 failed；缺失 branch state 为
  runtime_error。
- Focused gates：host projection tests for parallel→join pass/fail/resume
  branch-state persistence；delegate_parallel reuse probe；host typecheck。
- 失败即停：parallel 分支绕过 host primitive governance、join 重新执行分支、
  或出现第二套 delegate fan-out/background scheduler。

Implementation note (2026-07-05): host projection now drains `parallel` as a
non-model node, bounds branch execution (`maxConcurrency`, capped branch count),
and fail-closes unsupported branch kinds (`model`, `human`, nested
`parallel`/`join`). Mixed branch sets reuse the existing governed node runners
for `command`, `task`, `delegate`, and `script`; all-delegate branch sets call
the existing `delegate_parallel` tool with the parent runtime context rather
than creating another fan-out path. Branch-local transitions are deliberately
ignored in P5. `join` reads persisted branch states only and emits a normal
node verdict; missing branch state is `runtime_error`.

### Step 3 — P5 收尾

- 跑 P5 focused gates，再跑一次全量 `npm run release:check`。
- 通过后提交 P5（不加 Co-Authored-By）。
- 相位简报包含：交付、删除兑现、全量门、契约/决策修订、池子选片入口。

Implementation note (2026-07-05): focused gates passed:
`npm --workspace @sparkwright/agent-runtime test -- test/workflows.test.ts`,
`npm --workspace @sparkwright/agent-runtime run typecheck`,
`npm --workspace @sparkwright/host test -- test/workflows.test.ts
test/workflow-hooks.test.ts`, and `npm --workspace @sparkwright/host run
typecheck`. The project-map default drift check passed after routed pages were
reviewed. Full `npm run release:check` passed after correcting a Prettier miss
and marking durable branch provenance (`sourceNodeId`) as a reserved public
workflow field.

## 开放决策（各自绑定到步骤入口，不再是泛列表）

1. 非 model 节点 runner 语义 —— **Step 2 入口 ①**（推荐 host 节点
   边界自动执行，见上）。
2. `task_terminal` 排序 —— **Step 2 入口 ②**（二选一）。
3. Step 1 退化 workflow 等价性验收标准（哪组测试构成"等价"）——
   **Step 1 开工前**。
4. supervised → actor-owned 切换方式 —— **Step 4a 内定稿**；倾向
   一步切换不留并存过渡版本，避免第三个并行机制窗口期。
5. waiting durability 兑现机制（file outbox 扩展 / 专属 outbox /
   store events 重放）—— **Step 3 入口**。
6. D11 `workflow_start` 做/不做 + 附着式/派生式支持范围 ——
   **Step 4b 第 3 项**；若做，硬约束见该项（递归关死 / 授权钳制 /
   出生即挂统一任务谱系 / trace 教义）。
7. coordinator P1 host 工厂 chain 语义半的开工时点 —— **不早于
   Step 4a 合入**（见 Stage 3 跨提案排序约束）。
