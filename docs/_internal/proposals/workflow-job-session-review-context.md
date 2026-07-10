# Workflow as Job Session — 调用/会话面 review 上下文

状态:三轮 review 完成(2026-07-07),第 7 节问题全部拍板,裁决已回写本稿;
inputs schema 已按 D27 候选写入 workflow-runtime-v1.md(待批);
teacher-force replay 核实为 runtime-v1 设计节已有,无遗留写入动作。
来源:2026-07-06 对齐讨论(产品抽象 → 奇思妙想盘点 → 调用面方案);
2026-07-07 二轮 review(stop 能力边界修正、resume 预填坑、MVP A→D 重排、
detach 措辞裁决)+ 三轮 Runbook Mode 轮(3.6、D27、stop 矩阵硬化)。
范围:只覆盖 workflow 的**调用/会话面**(TUI 如何触发、观察、介入 workflow);
不重开 D11/D26(无模型侧 `workflow_start`),不改运行时语义。

---

## 1. 产品抽象共识

**Workflow as Job Session**:用户看到的是"任务会话"(attach/detach/resume、
当前节点、验证证据),DSL 和状态机藏在后面。心智类比:

| 用户心智                     | 底层实体                                       |
| ---------------------------- | ---------------------------------------------- |
| terminal shell               | TUI 主对话(普通 run)                           |
| tmux session / job           | workflow run(durable 实例)                     |
| `tmux ls` / `tmux attach`    | `workflow.list` / attach 视图                  |
| tmux status bar              | 状态行:当前 node / gate verdict / waiting 原因 |
| `tmux new -d 'make release'` | 背景 workflow job(用户不在里面,看句柄)         |
| tmuxinator 模板              | 内置/项目级 workflow 资产(用户只选不写)        |
| 把手工操作录成模板           | `workflow distill`(P7a)+ `shadow`(P8a)         |

类比的三个关键推论(都与已批决策一致):

1. **shell 不会变成 tmux** → 主 agent 只建议、客户端触发,聊天 run 不被状态机接管
   (= D26 spawn 模式,父 run outcome 解耦)。
2. **tmux 不就地改造你的 shell** → 禁止把活跃聊天 run 就地升级成 workflow
   (D16 实例化时刻授权结清)。
3. **tmux 继承 cwd+env 不继承 scrollback** → spawn 的 workflow 继承 goal +
   精选事实(将来 FactLedger/S2 投影),不继承聊天 transcript。

类比失效处(有产品含义):tmux 是纯复用器,workflow 是受治理环境
(clamp/verifier/D19/D23)。因此 attach 视图必须把治理状态做成一等公民
——这正是"调试心智复杂"难点的解:tmux status bar 级别的"我在哪、卡在哪"。

产品分层(用户提出,无异议):

- 第一层:模板化,内置 release-check / bugfix / migration / review,只选不写;
- 第二层:agent 建议、客户端触发(确认后由 TUI 发 `run.start { workflow }`);
- 第三层:distill/shadow 自动生成草稿 + 覆盖率校验,不从空白 YAML 开始。

## 2. 已验证事实(2026-07-06 对照代码核实)

**协议面已经齐了——MVP 四个动词全部存在**,见 `packages/protocol/src/index.ts`:

- `run.start` payload 已有 `workflow?: string` 字段(≈322 行),CLI `--workflow` 走的就是它;
- `workflow.list` / `workflow.resume` 是协议方法(不是 CLI-only),
  list 返回 `WorkflowRunSnapshot[]` 带 status 过滤,resume 返回 `workflowRunId`;
- `run.cancel` 已存在,底层 D24 语义(同步、无钩子、踢 RunEnd(cancelled)),
  ⚠ 但二轮核实:host `cancelRun` 只匹配**当前连接**的 active runId
  (`packages/host/src/runtime.ts` cancelRun,连接外一律 `run_not_found`),
  且 waiting 态没有 active episode——stop 只能覆盖 TUI-owned live job,
  见第 4 节 MVP-D;
- 事件流已有完整 workflow 词汇:`workflow.started / node.started / node.completed /
waiting / interrupted / completed / failed / cancelled`——attach 状态行数据源全在;
- `WorkflowResumeRequestPayload` 要求重新提交全套授权字段
  (sessionId/targetPath/confidentialPaths/shouldWrite)→ **连 resume 都按次重新结算授权**,
  这是"禁止就地改造活跃 run"的协议层佐证;
  ⚠ 但二轮核实:这些字段**全 optional**,且 `WorkflowRunRecord` 不持久化
  任何原始授权(resume 策略里只有 `verifyOnResume`)——TUI 裸 resume 会
  **静默降级到默认授权**(如写范围回落 README.md),比 stop 的坑更隐蔽
  (无显式报错,后续写节点才莫名失败),见第 4 节 MVP-C;
- TUI 对 workflow 几乎零消费(仅 capabilities 面板/format-event 提及)
  → MVP 主体是 TUI 呈现层工作,但二轮修正:**不是零 host 增量**——
  stop 是连接局部能力(见上),resume 预填需要授权快照(MVP-C);
  教训:勿被"协议字段存在"骗,字段存在 ≠ 能力存在;
- workflow 资产已是 skill 式文件夹(`workflow.md` per folder,
  见 `packages/host/test/fixtures/workflows/release-check-focused/`),S4 parser 同一管线;
- P9a 已把运行状态提升到 workspace 级 `workflow-runs` store → 跨进程可发现。

## 3. 本轮新达成的设计裁决(待 review 确认)

### 3.1 FG/BG 单一实例化路径,只差视图焦点 ★核心修正

原方案的 Foreground Handoff("确认后当前聊天切到 workflow run",exec 式)
**不能按字面实现**——就地改造撞 D16(授权无中途重结算语义)。
修正:Foreground 和 Background 都走 `run.start { workflow }` 起**新 run**,
差别只在 TUI 视图策略:FG = 焦点立刻切到新 job pane(聊天 run 收尾/挂起);
BG = 焦点留在聊天,job 进侧栏。
收益:两种 UX 从"两个功能"塌缩成"一个功能 + 一个焦点开关";
一种启动机制、一种授权语义、一种 trace 归属。

### 3.2 背景模式路线:每 job 一条 host 连接,TUI 多路复用

现状约束:host 一连接一 active run。两条路线:

- **路线 1(选定 v1)**:每个 job 新起一条 host 连接,TUI 做复用器。
  tmux 忠实翻译;lease/trace/session/权限天然按连接隔离,不碰递归/权限继承/取消/trace 归属。
- 路线 2:等 background-task-lifecycle 统一出生契约,workflow 作为 task-shaped
  handle 生在聊天 run 里(D26 spawn 完全体)。
  关键定位:路线 2 是**"workflow 句柄出现在聊天里"**的前置,
  不是**"TUI 有 job 列表"**的前置。两者不互斥,路线 2 落地时收编路线 1 的连接复用。

### 3.3 attach 两种成色

- **store attach(v1)**:读 workspace 级 store 的 `WorkflowRunSnapshot` + 定期刷新。
  P9a 红利:跨进程可 attach——CLI 起的 workflow,TUI 也能 list/attach。
- **live attach(v1.5)**:TUI 自有连接的 job 直接消费事件流,实时滚动 node/gate 事件。

### 3.4 建议机制分寸

- v1:主 agent 散文建议("适合 release-check,可 `/workflow start release-check`"),
  用户手敲。零新机制,D11/D26 原封不动。
- v1.5:结构化建议 chip(agent 输出 envelope → TUI 渲染确认按钮 → 客户端代发
  run.start)。仍非模型侧工具,不触碰 D26 reopen 条件
  (统一任务生命周期出生契约 / 递归深度控制 / 授权 clamp 三者齐备才可开模型侧工具)。
- 2026-07-07 裁决:chip 提前到 **MVP 后第一件事**——散文建议对普通用户
  约等于没有(会照着敲的用户本来就会自己敲),第二层产品承诺的真正落点是 chip,
  阻力只在工程量。

### 3.5 detach 语义(2026-07-07 已裁决)

tmux 心智说 detach 不杀 session,但当前 host run 依附连接。裁决:
**v1 = 状态可捡,非进程存活**——TUI 退出 job 也停,resume 捡起来
(durable record + resume 本来就为此设计),避免 v1 引入守护进程。
配套约束:**UI 语言不用 detach 这个词**——tmux 类比教用户的第一课就是
"detach 后 session 还活着",在最关键承诺上背叛心智模型信任崩得最快;
用 hide / pause / "稍后 resume" 等诚实措辞,退出 TUI 时明确提示
"N 个 job 将停止,可 resume"。独立进程方案挂到路线 2
(background-task-lifecycle 统一出生契约)作为其收编项,不在 v1。

### 3.6 Runbook Mode(2026-07-07 三轮新增)

**定位:不是新层、不是新机制,是第一层(模板只选不写)的 CLI 脸面 +
产品语言**——"启动一个已审过、版本化、可恢复、受治理的操作流程"。
同一个 `run.start { workflow }`、同一个 D16 实例化授权、同一份 durable
record;只是入口换成 ops 动词。与 FG/BG 塌缩同一课:一种机制多张脸,
不为脸发明机制。D11/D26 不受触碰(客户端显式触发,CLI 先例)。

已核实现状(2026-07-07,约七成已落地):

- `sparkwright run "goal" --workflow <name>` 已存在(goal 必填位置参数);
- `sparkwright workflow list|inspect|resume|distill|shadow` 子命令家族
  已存在——缺的只是 start 别名(并入该家族)与 stop(见下矩阵);
- inputs/params 概念完全不存在 → 真增量,升格为 runtime-v1 **D27 候选**
  (pending user confirmation;runtime-v1 顶部 accepted slice 仍止于
  P10a,任何地方不得写成已 accepted)——数据 schema 非语言、whole-token
  绑定循 D16 先例、冻进实例化快照、inputs = job 身份 resume 不重问
  不许改,本稿不展开。

v1 边界(承诺刚好能兑现):

- **`--background` 排除**——3.5 裁决(v1 无守护进程)的直接推论;进程退
  job 停。挂路线 2 与独立进程一起收编。诚实版本反而更像运维:CI job
  就是前台阻塞的。
- **前台阻塞 + waiting 退出循环**:exit code 映射 workflow 结局
  (run-outcome 单一 failing 投影);碰到 human/approval waiting →
  打印原因 + `workflow resume <id>` 提示,以独立 exit code 退出;
  操作员审批后 resume 接续。runbook 在审批点暂停,全落在已有裁决内。
  约束:waiting 退出码同样从持久化 record 状态投影(P1.5 已把 CLI exit
  path 收敛到快照单源),不新增第二判定通道。
- **stop 矩阵(硬边界)**:
  - CLI 前台 run:Ctrl-C ✅,但注意现状是**裸杀非 cancel**——record 留在
    非终态、可 resume(= 事实上的暂停);显式 `run.cancel` 则是终态
    不可 resume。两者后果相反,勿并读;将来改 SIGINT→cancel() 须先过
    pause vs kill 裁决(见下方 ⚠);
  - TUI-owned live job:`/workflow stop` ✅(MVP-D);
  - 独立 `sparkwright workflow stop <id>`:**v1 不提供**——天然跨连接,
    正好整个落在 cancelRun 连接局部语义之外;动词保留给将来的
    `workflow.cancel`(存在但永远失败的命令比不存在更伤信任);
  - 真正跨进程 stop 等 `workflow.cancel` 或 task-lifecycle 收编。
- **stop = 终结,不是暂停**(2026-07-07 核实):`cancelled` 是终态,
  resume 明确拒绝(store 终态判定 completed|failed|cancelled;
  resumeWorkflowRunInner 对终态返回 invalid_payload)。可 resume 的只有
  `running` / `waiting`。
- **Ctrl-C 的实际语义**:CLI/host 均无 SIGINT 处理,Ctrl-C 裸杀进程 →
  record 留在非终态 → 可捡(依赖 lease TTL 过期;lease TTL leak 在
  backlog)。这恰好构成 v1 唯一的"暂停"形态。⚠ 将来若给 CLI 加优雅
  SIGINT→cancel,会把"可捡"悄悄变成"终结"——须先裁决 pause vs kill
  语义,不得顺手加。

## 4. MVP 工作清单(2026-07-07 二轮重排为 A→D 四层)

分层原则:只读先行、风险后置;每层交付后独立可用,每层比上一层多一个
明确的能力承诺。原"需核实 `WorkflowRunSnapshot` 是否带 runId"已核实:
`activeRunId` + `runIds[]` 都在,但 stop 的瓶颈不在字段而在 cancelRun
的连接局部语义(见 MVP-D)。

- **MVP-A(纯只读,零授权、零 cancel 语义)**:`/workflow list` + job 侧栏
  (`id / status / node` 一行一个)+ **waiting badge**——job 卡在 human wait
  用户必须看见,否则等于静默失败;snapshot 已有 `wait.kind/reason`,成本低。
  attach snapshot 视图 + 状态行:node / 最近 gate verdict / waiting 原因 /
  失败原因(遵守 scrollback-native / minimal chrome 偏好)。P9a 红利:
  CLI 起的 workflow 也能 list/attach。waiting 可见性优先于 live attach。
- **MVP-B**:`/workflow start <name> <goal>`;FG/BG 只是焦点策略(3.1);
  每 job 一条 host 连接(3.2 路线 1)。侧栏必须区分"连接断了"和
  "job 失败了",别让实现细节漏成用户困惑。
  CLI 侧同层补:`sparkwright workflow start <name>` 别名并入已有子命令
  家族(等价于 `run --workflow`,同一路径);waiting 退出循环见 3.6。
- **MVP-C**:`/workflow resume <id>`,`waiting` 状态做成一等入口。
  ⚠ 含一个 host 增量:`WorkflowRunRecord` 需持久化**实例化时刻的授权快照**
  (targetPath / confidentialPaths / shouldWrite / accessMode),作 resume
  表单预填,用户单次确认——不违反 D16,授权仍按次结清,只是把"上次的答案"
  作为表单初值。TUI 侧**禁止全不传裸 resume**:payload 字段全 optional,
  裸 resume 会静默降级到默认授权(见第 2 节 ⚠)。
- **MVP-D**:`/workflow stop` **只支持 TUI-owned live job**(经该 job 自己
  的连接调 `run.cancel`)。跨进程 / waiting 态的 workflow 明确提示
  "不在当前连接中,需 resume 或到 owner 处 stop"。真正的 `workflow.cancel`
  需要 lease 感知 + driver 侧信号通道(notification outbox 存在但 driver
  消费方向缺失),归后续 `workflow.cancel` 协议方法或 task-lifecycle 收编,
  不塞进 v1。独立 CLI `workflow stop <id>` v1 不提供;完整 stop 矩阵与
  "stop = 终结非暂停"语义见 3.6。UI 文案须区分"停止(不可恢复)"与
  "退出(可 resume)"。

MVP 后第一件事:建议 chip(3.4,从 v1.5 提前)。

## 5. 奇思妙想盘点结论(上一轮,一并 review)

### 已落地(想法与已 ship 架构重合,验证方向正确)

- workflow 文件夹像 skill → 已是(workflow.md + S4 parser + P4 script 节点
  stdio JSON-RPC:progress/completion/getEvidence/受治理原语,遥测走 stderr);
- 节点 hook 判转移/授权/异常 → verifier + transition + 投影钩子(D19/D23)+ D16;
- 零 token 巡航 → 非模型节点由 host 在节点边界自动执行(P3 Step 2:
  绝不"给模型提示让它跑");提案 781 行原文即 "cruise mode";
- 陪跑零 token → P8a shadow 离线确定性,不碰模型。

### 已有名字的 deferred(想法 = 给这些 slice 排优先级的理由)

- 异常唤醒模型 = D6 升级阶梯(P4 排除,reopen 条件 C4 2026-07-06 已记录;
  缺的是节点 fail 时按阶梯升级:重试 → 换 runner → 起模型 episode,预算走 S3);
- 按需杀 turn 上下文 = D10 节点边界压缩(可表达未接线;节点边界是唯一安全
  压缩点,因证据已外化进 WorkflowRunRecord,合"保事实、调信号");
- 持续迭代闭环 = distill(P7a)→ shadow(P8a)→ 人审 → 资产更新;
  缺第三环:草稿/覆盖差写回 `.sparkwright/workflows` 的 proposal 形态。

### 真正新增量(parking-lot 候选,未写入提案)

- **teacher-force replay**:调试 workflow 资产时投影引擎照常跑,节点执行器换成
  "从指定 session trace 按 nodeId 取录制结果"的 stub,模型节点也可 teacher-force
  成录制输出。零 token 零副作用。P8a 排除项里的 "replay execution" 即此坑位。
- **evidence 声明式注入**:前序节点证据选择性注入后续模型 episode
  (资产里 `context: [nodeA.evidence]` 之类)。`getEvidence(nodeId)` 与 catalog
  narrowing 已有,缺声明式写法。⚠ 警惕长成表达式语言(P4/P5 均明确排除)。
- **运行中人工介入 UX**:运行时机制齐(human/waiting 节点、interruption fact、
  D24 cancel、通知 outbox),TUI 呈现是空白;设计答案 = status bar + 注入通道
  (用户输入变成 workflow 收到的 fact,不直接改模型上下文)。

### 拦下来的

- **state/日志不进 workflow 文件夹**:倒退回 P9a 刚废掉的东西。资产
  (git、可版本化、可 review)与运行态(workspace store、按实例)分离是
  durable-vs-cache 规则的直接推论。"就地看状态"用 list/resume/attach 满足,
  不用目录布局满足。

### 定位(vs LangChain)

差异不是"更智能"而是**治理优先 vs 编排优先**:边是 verifier 裁决 + 授权 clamp
而非代码;资产 markdown + 脚本可 git review;单一事实源 WorkflowRunRecord;
加 teacher-force 后"调 workflow"比"调 LangChain 图"便宜一个量级。

## 6. 与已批决策对照(本方案触碰面)

| 决策                         | 关系                                                   |
| ---------------------------- | ------------------------------------------------------ |
| D11(无模型侧 workflow_start) | 保持关闭;客户端触发不在封锁范围(CLI `--workflow` 先例) |
| D26(spawn envelope)          | 建议 chip 不触碰 reopen 条件;路线 2 是其完全体         |
| D16(实例化时刻授权)          | 3.1 修正的依据;resume payload 佐证                     |
| D24(cancel 语义)             | `/workflow stop` 直接复用                              |
| D21/D23/D19                  | 只消费其事件/裁决产物,不改                             |
| P9a(workspace store)         | store attach 的地基                                    |
| D6/D10/P7a/P8a               | 第 5 节 deferred 映射,不在本方案范围内实现             |

## 7. Review 拍板结果(2026-07-07 二轮,全部裁决)

1. 3.1 FG/BG 单一路径修正 —— ✅ 接受,"exec 只是视图切换"。
2. 3.2 路线 1(每 job 一连接)—— ✅ 接受,v1 不等 background-task-lifecycle;
   路线 2 落地时收编连接复用。
3. 3.5 detach 语义 —— ✅ 状态可捡;UI 不用 detach 措辞;独立进程挂路线 2。
4. `/workflow` 命令面 —— ✅ 按第 4 节 A→D 立项。runId 映射已核实
   (`WorkflowRunSnapshot.activeRunId` 存在),但 host `cancelRun` 连接局部
   → stop 边界收窄为 TUI-owned live job(MVP-D)。
5. parking-lot —— teacher-force replay ✅ 核实后**无需写入动作**:
   workflow-runtime-v1.md 设计节已有完整 "Shadow mode (陪跑) and
   teacher-forced replay" 小节,比 parking-lot 格式更强,裁决即已满足;
   evidence 声明式注入 ❌ 继续压住,等真实模板逼出需求(表达式语言风险)。

二轮新增裁决:waiting 可见性进 MVP-A(优先于 live attach);MVP-C 附带
授权快照 host 增量;建议 chip 提前到 MVP 后第一件事。
方法论教训:易用 = 把承诺说得刚好能兑现;勿被"字段存在"骗
(stop 的 cancelRun 连接局部、resume 的 optional 字段静默降级,两例同款)。

三轮新增裁决(2026-07-07 Runbook 轮,用户确认):

- Runbook Mode 立为第一层的 CLI 脸面(3.6),同机制多张脸;
- `--background` v1 排除;前台阻塞 + waiting 退出循环为 v1 运维形态;
- stop 矩阵硬化:独立 CLI `workflow stop <id>` v1 不提供,动词保留给
  `workflow.cancel`;
- 核实补充:cancelled 为终态不可 resume(stop = 终结非暂停);Ctrl-C
  裸杀 = 非终态可捡,是 v1 唯一"暂停"形态,将来加 SIGINT 优雅处理前
  须先裁决 pause vs kill;
- inputs schema 升格为 runtime-v1 决策 27(已按候选写入,待批)。
