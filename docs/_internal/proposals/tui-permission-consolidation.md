# 设计提案:TUI 权限收归单一模式轴

> 状态:草案,已经过一轮 map-driven review(2026-06-25),findings 已折入下文。本提案只改 TUI 的用户可见面与请求边界派生,**不改 core 策略结构**;headless 入口(CLI run / cron / ACP)零影响。

## 修订记录

- **2026-06-25(review 回应)**:
  - 分期重排——**真正的 P0 是"引入 TUI 单一模式 + 边界派生 `{permissionMode, shouldWrite, allowWorkspaceWriteApproval:false}`"**,热键放其后。原 P0(只切 `permissionMode`)不成立:`shouldWrite` 仍来自启动参数、`allowWorkspaceWriteApproval=!shouldWrite`,只切 mode 会保留 mode 语义失真的 bug。
  - **新模式用 TUI-local 字段**(如 `ui.permissionMode`),不重载 core 的 `permissionMode`(后者是只允许五值、保守合并的安全边界)。
  - **`--yes*` 之外还要处理 config-sourced approvals**(`config.approvals.{all,edits,shellSafe}`),否则删了 CLI 参数仍留隐藏第二轴。
  - **`allowWorkspaceWriteApproval` 仍是 Unreleased**(CHANGELOG `## Unreleased`,`PROTOCOL_VERSION` 未 bump),因此可在本次 WIP 直接删除,**不构成 breaking change**、无需 deprecate 迁移。
  - 写护栏绕过从"疑似"升级为**已确认**的 policy 层事实。
  - 收窄 `read-only` 文案(plan 对非只读动作是"需审批"而非硬拒)。
- **2026-06-25(review 第二轮)**:
  - **不能整体"移除自动应答",否则破坏 `bypass`/`accept-edits`**:core run loop 对 `risk: risky` 仍发 approval,这些 mode 的"不打扰"靠 `createApprovalPolicy` 从 `permissionMode` 派生(已核 `approval-policy.ts`)。改为"停 `approve*`/`config.approvals` 来源、保留 mode 派生 approval policy"。
  - **旧授权轴停用并入 P0**(否则 P0 的"单一轴"不成立)。
  - **TUI-local 配置 flat key 必须是 `tuiPermissionMode`**,不能是 `ui.permissionMode`→扁平成顶层 `permissionMode`(会撞 core 安全边界;已核 `ui` 组扁平表)。
  - `ask = shouldWrite:true` 的验证面补 **configured/in-process delegate、promoted shell、untracked 边界**(`shouldWrite` 还开 delegate 读写访问)。
  - 删除 `allowWorkspaceWriteApproval` 的 project map 同步范围补全为 **6 页**(grep 命中:host/core/tui/protocol 模块页 + approvals/workspace-writes 安全图)。
- **2026-06-25(review 第三轮)**:
  - project map 同步范围再上修 **6 → 8 页**:补 `maps/runtime/tool-orchestration.md`(reviewer 指出)与 `modules/coding-tools.md`(本次核出)——这两页写的是 **escalation / managedWorkspaceWrite 概念**而非字段名,删除时需按概念搜、不能只 grep `allowWorkspaceWriteApproval`。
  - 映射表措辞收顺:`toCoreRunFields` 派生 `{permissionMode, shouldWrite}`;`allowWorkspaceWriteApproval:false` 仅 **P2 前**显式带、**P2 后**字段消失,避免"先加再删"困惑。

## 背景

### 现状:权限散在两个轴 + 一堆启动开关

SparkWright 的权限实际由**两个正交的 core 轴**决定,合成规则 `createLayeredPolicy` = **deny > 需审批 > 放行**:

1. **`permissionMode`(提示策略)** — `packages/core/src/policy.ts` 的 `createPermissionModePolicy`,5 值:`default`(写→弹框)/ `plan`(只读外全审批)/ `accept_edits`(写自动放行)/ `dont_ask`(需审批→拒)/ `bypass_permissions`(全放行)。
2. **`shouldWrite`(写能力,来自 `--write`)** — `createWorkspaceMutationPolicy`:`false` 时写动作/写副作用工具**硬 deny**;`true` 时放行并受护栏约束。

外加散件:

- **`--yes` / `--yes-edits` / `--yes-shell-safe`**:自动**应答**审批框(`packages/tui/src/state/run-controller.ts` 的 `approveAll/approveEdits/approveShellSafe`)——本质是"替人点批准",为**非交互**场景设计。
- **写护栏**(`maxFiles/maxDiffLines/allowDeletions` + `--target`)——只在 `shouldWrite=true` 路径生效。
- **confidentialPaths**(禁读)、**shell sandbox**。

### 最近新增的 `allowWorkspaceWriteApproval` 及其问题

为消除"只读 run 里写被硬拒、必须重启带 `--write`"的摩擦,新增了第三个轴 `allowWorkspaceWriteApproval`(= `!shouldWrite`),把 mutation 层的 deny 转成审批。但它带来三个代价:

1. **mode 语义失真**:因为分层中"需审批"盖过"放行",`accept_edits`/`bypass_permissions` 在这条新路径下**仍会弹框**,`dont_ask` 则**阻断**——三个 mode 全不符合直觉。
2. **绕过写护栏(已确认)**:审批分支在 `allowWorkspaceWrites:false` 路径直接 `requireApproval`(`packages/core/src/policy.ts` `createWorkspaceMutationPolicy` 的 workspace.write 分支),走不到同函数里的 `target / maxFiles / maxDiffLines` 检查——而正经 `--write` 反而受限。属 policy 层事实。
3. 多了协议字段 + schema + 文档 + metadata 透传的维护面。

### 痛点根因

"默认 TUI 需授权"只对**已可写**的 run 成立;只读 run 缺的不是"怎么问",而是"连问的机会都没有(被 deny)"。`--yes*` 在**有真人**的 TUI 里基本冗余——人可以直接答框。权限概念对用户暴露成了 `permissionMode` + `--write` + `--yes*` + `allowWorkspaceWriteApproval` 四样,过于碎。

---

## 设计目标

- **TUI 对用户只暴露一个权限旋钮**,可运行时切换,无需重启。
- 去掉 TUI 的 `--yes*`(降级为 headless/CLI 专用)。
- **core 的两轴结构不动**,headless 入口(CLI run / cron / ACP)零影响。
- 把 `allowWorkspaceWriteApproval` 从用户可见面拿掉。

## 方案

### 1. TUI 单一模式轴

TUI 只暴露 4 档(丢弃对交互无意义的 `dont_ask`):

| TUI 模式 | 含义 |
|---|---|
| `read-only` | 写动作 / 写副作用工具被**硬拒**;其余非只读动作仍**逐次审批**(见下注) |
| `ask`(默认) | 写 / shell **逐次弹框**确认 |
| `accept-edits` | 文件编辑自动放行;shell 仍确认 |
| `bypass` | 全自动,不打扰 |

> **`read-only` 文案注**:`read-only → plan + shouldWrite:false`。`shouldWrite:false` 让写副作用工具在 mutation 层**硬拒**(deny 胜);但 `plan` 对**非只读的 `tool.execute`**(无写副作用者)是"需审批"而非硬拒(`packages/core/src/policy.ts` plan 分支)。所以"什么都不发生"现有两轴**无法完整表达**——`read-only` 实为"不写,其余有风险动作照常问"。若需要"连有副作用 shell 也一律不跑",得 core 增设能力,超出本提案范围。

### 2. 模式 → core 旋钮的派生(在请求边界做投影)

TUI 不改 core 策略,只在发 `run.start`/`run.resume` 时把单一模式映射成 core 字段:

| TUI 模式 | `permissionMode`(core) | `shouldWrite` | 审批旁路 |
|---|---|---|---|
| `read-only` | `plan` | false | 无 |
| `ask` | `default` | **true** | 无(default 对 write 天然弹框) |
| `accept-edits` | `accept_edits` | true | 无 |
| `bypass` | `bypass_permissions` | true | 无 |

关键:**`ask` 用现成的 `shouldWrite=true + default 提示`实现**,逐次弹框 + 写护栏全套自动生效——**不需要 `allowWorkspaceWriteApproval`**。

**审批的自动应答也由 mode 派生,不靠 `approve*`**:`packages/core/src/approval-policy.ts` 的 `createApprovalPolicy` 本来就读 `permissionMode`——`bypass_permissions`→`enforcement: bypass`(全自动批)、`dont_ask`→`deny`、`accept_edits`→`workspace_edits` scope;`approveAll/Edits/ShellSafe` 只是**额外叠加**的 scope。所以只要把上表派生出的 `permissionMode` 喂给 approval policy,`bypass`/`accept-edits` 的"不打扰"就成立——**这是为什么不能简单"移除自动应答"**(见 §3)。

### 3. 旧授权轴迁移(`--yes*` **和** config-sourced approvals)

TUI 的自动应答**有两个来源**,都要处理(只删 CLI 参数会留隐藏第二轴):

1. **CLI 参数** `--yes` / `--yes-edits` / `--yes-shell-safe`(`packages/tui/src/index.ts`)。
2. **config** `config.approvals.{all,edits,shellSafe}` —— `packages/tui/src/app.tsx` 的 `approveAll = cli.approveAll ?? loaded.config.approvals?.all ?? false`(edits / shellSafe 同),收到 approval 时由 `run-controller` 的 `resolveHostClientApprovalByPolicy` 自动应答。

迁移(**关键:停的是"来源",不是"自动应答机制本身"**):

- TUI **停用 `--yes*` 与 `config.approvals.*` 作为独立来源**;但**保留"由 TUI mode 派生的 approval policy"**——即把派生出的 `permissionMode` 喂给 `createApprovalPolicy`(`bypass`→auto all、`dont_ask`→deny、`accept-edits`→workspace_edits)。**不能整体"移除自动应答",否则 `bypass`/`accept-edits` 会退化成逐次弹框**(core run loop 对 `risk: risky`/`requiresApproval` 仍发 approval,见 `packages/core/src/run.ts` 的 risk 分支)。
- 净效果:删掉的只是 `approveAll/Edits/ShellSafe` 这几个**不绑定 mode** 的额外 scope(尤其独立的 `safe_shell`);mode 自身的语义照旧。
- 对应关系(供把旧值迁成初始模式):`all`/`--yes`→`bypass`,`edits`/`--yes-edits`→`accept-edits`,`shellSafe`/`--yes-shell-safe`→并入 `accept-edits` 的"自动放行安全 shell"或留作子选项。
- `--yes*` 与 `config.approvals` 仍由 **CLI / cron / ACP** 等非交互入口使用(那里没真人应答)——它们是 headless 概念,不在 TUI 暴露。
- **开放问题**:TUI 是"完全忽略 `config.approvals.*`",还是"读它一次作为初始模式、之后以 TUI 模式为准"?见下方开放问题。

### 4. `allowWorkspaceWriteApproval` 去留

**决定:直接删除。** 该字段仍是 Unreleased(`docs/reference/HOST_PROTOCOL_CHANGELOG.md` 的 `## Unreleased` 下,`PROTOCOL_VERSION` 仍为 `1.3` 未 bump,改动只在分支工作树),protocol 注释里"移除/重命名需 major bump"只约束**已发布**字段,对未发布字段不适用——因此同周期直接删,**不构成 breaking change、无需 deprecate 迁移**。

- 用 `ask` = `shouldWrite:true + default` 替代(写护栏自动回到正路)。
- 同步回退:protocol 类型、`schemas/host-message.schema.json`、`HOST_PROTOCOL.md`、CHANGELOG Unreleased 条目、project map protocol 页、policy.ts 的两条审批分支、runtime.ts 的透传、run-controller 的 `allowWorkspaceWriteApproval()`。
- **顺序约束**:删除必须在 P0(TUI 模式 + 派生)之后或同批落地。**单独先删会回到"非 --write run 硬拒写/shell"的原始摩擦**——即用户一开始撞到的那个 bug。

> 脚注:仅当该字段**已经进过 release** 才需走稳妥路径(TUI 停发 → host 容忍并 deprecated → major migration 真删)。本分支未发布,不适用。

### 5. core 保持不变(必须)

config 合并契约(`packages/host/src/config-zod-schema.ts` 顶部说明)把 `permissionMode`/`confidentialPaths`/`write` 当**三条独立安全边界**保守合并;headless 入口不能弹框,必须靠显式 `shouldWrite` + `dont_ask`。**所以"收归一处"只是 TUI 的 UX 投影,不是 core 合并。**

---

## 实现落点(文件级)

| 区域 | 文件 | 改动 |
|---|---|---|
| TUI 模式枚举 + 映射 | 新增 `packages/tui/src/lib/permission.ts` | 定义 4 档 `TuiPermissionMode` + `toCoreRunFields(mode)` 派生 `{permissionMode, shouldWrite}`;P2 后不再生成 `allowWorkspaceWriteApproval` |
| TUI-local 配置字段 | `packages/host/src/config-zod-schema.ts`(`ui` 组 + 扁平表)+ `packages/tui/src/lib/config.ts` | **新增 TUI-local 字段,flat key 必须是 `tuiPermissionMode`(不是 `permissionMode`)**。`ui` 组经 `normalizeGroupedConfig()` 扁平化(现 `ui.{theme,mouse,keybindings}`→同名顶层),而顶层已有 `permissionMode` flat key 绑定 core 安全边界——若新字段扁平成 `permissionMode` 就撞回 core 五值。故用 `ui.tuiPermissionMode`→`tuiPermissionMode`,4 档;旧 core 五值仅作兼容映射 |
| 请求边界 + approval 派生 | `packages/tui/src/state/run-controller.ts` | run 请求读取 `toCoreRunFields(mode)` 派生的 `{permissionMode, shouldWrite}`;`approvalPolicyInput()`(:32)**保留 `permissionMode`、移除 `approveAll/Edits/ShellSafe` 三个独立 scope 来源**——approval policy 仍由 mode 派生(见 §3) |
| 旧授权轴停用(并入 P0) | `packages/tui/src/app.tsx`(约 :157)+ `packages/tui/src/index.ts` | TUI 不再从 `cli.approve*` / `config.approvals.*` 注入 scope(见 §3);两者降级为 headless-only |
| 运行时切换 | `packages/tui/src/app.tsx` 的 `Hotkeys`(约 :1362)+ `packages/tui/src/lib/keybindings.ts` | 加 `cycle-permission-mode` 绑定(默认 `shift+tab`),循环 read-only→ask→accept-edits→bypass,改本地 TUI mode 并经请求边界派生 |
| 状态栏显示 | `packages/tui/src/components/status-bar.tsx`(约 :75) | 显示 TUI 档名(复用现渲染 permissionMode 的位置) |
| 删除新 flag(Unreleased,见 §4) | 代码:`policy.ts` / `runtime.ts` / `run-controller.ts` / `protocol/src/index.ts` / `schemas/host-message.schema.json` / `HOST_PROTOCOL*.md` + 测试 | 撤掉 `allowWorkspaceWriteApproval`(因未发布,直接删) |
| 删除新 flag — **project map 同步(8 页)** | 写字段名的 6 页:`modules/host.md` / `modules/core.md` / `modules/tui.md` / `modules/protocol.md` / `maps/safety/approvals.md` / `maps/safety/workspace-writes.md`;**外加写概念但没写字段名的 2 页**:`maps/runtime/tool-orchestration.md`(“interactive client enables write approval escalation for a `shouldWrite: false` run”)、`modules/coding-tools.md`(`managedWorkspaceWrite` → “read-only approval escalation reach the workspace.write diff approval”) | 删除/改写其契约描述,刷新各页 `Last Verified`。注意后两页按**概念**(escalation / managedWorkspaceWrite)搜,不能只 grep 字段名 |

> 注:`packages/tui/src/state/event-store.ts` 的 activePhase / retrying / compaction 与本提案无关,保持不动。

## 运行时切换体验

- **Shift+Tab** 循环档位,即时生效(下一个 run 用新档),无需重启、无需 `--write`。
- 状态栏右侧由 `· default` 改显 `· ask` / `· accept-edits` / `· bypass` / `· read-only`。
- 切到 `read-only` 时给一条 scrollback notice,和 `/model` 切换一致的轻反馈。

## 验证清单

- [ ] `ask` 模式下:写 / shell 弹审批;批准后落盘**受写护栏限制**(diff 预算 / target)。
- [ ] `read-only`:写 / 副作用 shell 被拒,只读工具与读放行。
- [ ] `accept-edits`:编辑不弹、shell 弹;`bypass`:**全不弹**(确认 approval policy 由 mode 派生,删了 `approve*` 仍 auto all)。
- [x] Shift+Tab 即时切换,状态栏同步,下个 run 生效。
- [ ] **`ask` = shouldWrite:true 的更宽边界**(`shouldWrite` 不止进 mutation policy,还开 configured delegate 的读写 workspace 访问,见 `packages/host/src/runtime.ts` 的 delegate 分支):验证 **configured delegate / in-process delegate** 在 `ask` 下的写访问与 trace 期望;**promoted shell** 与 `workspace.write.untracked_access_granted` 这类 untracked 边界标记行为符合预期。
- [ ] **headless 入口零回归**:CLI run / cron / ACP 的 `--yes*` + `shouldWrite` + `dont_ask` 行为不变(跑 `npm run release:check` 的回归套件 MCP/SESSION/DELEGATE/PROMOTE/NO_TASKMGR/SPAWN_FINAL/ACP/CONSIST)。
- [x] 删除 `allowWorkspaceWriteApproval` 后:协议 schema / HOST_PROTOCOL 文档 / 上述 **8 个** project map 页一致(含 tool-orchestration.md、coding-tools.md 两处概念页),`client-run` / policy 测试更新。

## 待作者确认的开放问题

1. **已决:不保留"能力 read-only + 单点提权"这一姿态。** `allowWorkspaceWriteApproval` 因 Unreleased 已按首选方案直接删除。
2. **`config.approvals.*` 在 TUI 的处理**:完全忽略,还是读一次作为初始 TUI mode、之后以 TUI mode 为准?(§3)
3. **`--yes-shell-safe` / `config.approvals.shellSafe` 的归宿**:并入 `accept-edits`,还是单列一档/子选项?
4. **`dont_ask` 是否对 TUI 完全隐藏**(倾向是,纯 headless 概念)。
5. **配置默认档**:TUI 默认 `ask`(可写但每次问)还是 `read-only`(更保守,需手动提权)?这关系到"开箱即用 vs 最小权限"的取向。
6. **`read-only` 的语义边界**:接受"不写、其余风险动作照常问"即可,还是需要 core 增设"零副作用"能力?(§方案 1 注)

## 分期(已按 review 重排)

- **P0(地基,含旧轴停用)**:引入 `TuiPermissionMode`(4 档)+ TUI-local 配置字段(flat key `tuiPermissionMode`)+ 请求边界派生 `{permissionMode, shouldWrite}`,approval policy 由派生的 `permissionMode` 生成。`ask` 走 `shouldWrite:true + default`,写护栏回正路。**同一步内停用 `--yes*` / `config.approvals.*` 作为 TUI scope 来源**——否则"单一轴"不成立(reviewer P1)。这才是真正修 bug 的最小集;只切 `permissionMode` 的旧 P0 不成立。
- **P1**:Shift+Tab 运行时切 TUI mode + 状态栏显档(纯交互层,P0 的派生已就位)。
- **P2**:删除 `allowWorkspaceWriteApproval`(Unreleased,直接删)+ 协议 / schema / 文档 / 上述 8 个 project map 页同步回退。

> 验证以 `npm run release:check` 的回归套件为收口标准,重点确认 headless 入口(CLI run / cron / ACP)的 `shouldWrite` + `--yes*` + `dont_ask` 行为零回归。
