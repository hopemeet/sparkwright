# SparkWright 战略交接(Handoff)

> 一轮深度讨论的收束,供新上下文窗口接续。讨论从"借鉴 Hermes 的 skill 自进化"
> 出发,最终收敛到这个项目真正的问题:定位与采用。
> 配套工件:`docs/_internal/SKILL_SELF_EVOLUTION_DESIGN.md`(Hermes 分析 + skill
> 自进化的完整设计,**目前冻结,见下文**)。

---

## 0. 一句话结论

**SparkWright 的问题从来不在代码,在于工程成熟度远远跑在了"为谁、解决什么痛"的证据前面。**
这一轮把那个空白填上了:**wedge = 让 agent 可靠上生产**。其余一切(可组合 kernel、
skill 自进化)降级为支撑它的能力,不是独立卖点。

---

## 1. 项目定位(已锁定)

项目性质:**要被别人用的产品/框架**(用户明确确认,不是个人学习练习场)。
因此唯一北极星 = **被采用**;架构优雅度、skill 自进化、kernel 化全部是它的下游。

### 用户给的三条价值主张,经诊断后的层级:

| 用户原话 | 诊断 | 定位 |
|---|---|---|
| ① core/host/cli 分离、企业可自建 harness 复用 | vitamin,卖架构,day180 价值,无当下疼痛证据 | **支撑特性,非卖点** |
| ② 可进化的 skill / workflow | 供给侧("我能做"),非需求侧 | **支撑能力,非卖点** |
| ③ agent 上线不稳定/成本失控 → workflow 化,必要环节用代码,关键环节接模型 | **真 painkiller,行业验证的普遍痛** | **★ 这是 wedge ★** |

### 收敛主线(记住这一句):

> **SparkWright = 让 agent 可靠上生产的那一层:确定性 workflow 骨架 + 关键节点
> 模型接入,且全程可审计、可恢复、可审批。**

为什么第③条是主线而非三选一:它**恰好需要 SparkWright 已经建好的全部资产**——
- 可审计 trace(tiered JSONL、span correlation)→ 上线后能查"为什么这么干"
- 可恢复(`core/run.ts: resumeRunFromCheckpoint`、`workspace-checkpoint`)→ 崩了能续,不从头烧钱
- approval-gated / scope → 关键环节卡住,不让 agent 乱动
- 确定性默认模型(ADR-0005)、step-cap 反思(ADR-0009)→ 可预测、可控成本

第①条(可组合)是它的实现方式,第②条(skill/workflow 进化)是让它"越跑越稳"的机制。

---

## 2. 三个还没回答的生死问题(下一步的核心)

1. **凭什么是你,不是 LangGraph / Temporal?** "agent+workflow 混合"赛道有强竞品。
   必须答出一个 LangGraph **给不了、你能给**的词。猜测:可审计/可恢复/可审批更原生
   更深——**但这是待验证假设,不是结论。** 答不出 = 又一个 LangGraph wrapper。
2. **那个"不敢上线"的团队,具体是什么场景的 agent?**(code / 客服 / 数据处理 /
   研究…)场景定了,"凭什么是你"才答得出。**用户尚未回答此问题——这是接续讨论的第一个入口。**
3. **第③条要从"解法措辞"翻成"用户措辞":** 用户画像 = 做了 agent 原型让老板眼前一亮、
   但一进客户环境就崩/烧钱/不可控、不敢签 SLA 的团队。叙述/demo/文案全部对准他。

---

## 3. 架构诊断结论(只读,结论是"先别动")

读过代码,结论:**架构是这个项目最不用担心的部分。** 30+ 包、六边形、债很轻。

- **已经是协议形状的接缝(资产):** ① host↔client 协议(`@sparkwright/protocol`,
  版本化 1.2,纯 wire 类型,第三方可消费——最硬资产);② provider 接缝(`core/model.ts`
  + provider-registry/ai-sdk);③ tool 接缝(`core/tools.ts` + coding-tools/shell/mcp);
  ④ 治理契约(`approval.ts`/`hooks.ts`/`capability.ts`/`extensions.ts`,小而干净)。
- **耦合浓缩点(债,但现在别动):** ① `core/run.ts` 4048 行引擎焊在契约叶子里
  (`SparkwrightRun implements RunHandle`);② `host/runtime.ts` 2863 行上帝对象;
  ③ `core` 把契约与实现从同一 barrel 导出(第三方只想要协议却被迫吞 23k 行实现)。
- **曾提出的三步重构**(劈契约包 / 挪引擎宣告刚性 / 拆 host 上帝对象):**经 ROI 审判,
  现在都不值得做。** 劈契约包会过早上版本兼容镣铐(负回报);挪引擎是纯洁痧;拆 host
  只有"你改 host 改到怕了"时才值得。**让真实改动痛点触发拆分,别让架构洁癖触发。**

---

## 4. Hermes skill 自进化分析(精华,细节见 SKILL_SELF_EVOLUTION_DESIGN.md)

- 两套机制别混:**Bundled Sync**(3-hash 合并,用户主权,非进化)与 **Self-Improvement**
  (后台 review fork + Curator,才是进化)。
- 后台 review:每 **10 user turn** / **10 tool iteration** fork 守护线程,继承父
  prompt cache,工具白名单仅 memory/skill,**乐观直写 active、零 eval gate**。
- Curator:7天间隔 / 2小时 idle 触发,phase-1 纯函数(30天 stale / 90天 archive)
  + phase-2 LLM 合并 umbrella;tar.gz 全库快照 + 回滚;只动 agent-created。
- 关键安全属性:**一个 ContextVar(write_origin)决定"curator 只能动 agent 自己写的"** ——
  最该照抄的不变量。
- 我们的设计改进(已写进 DESIGN 文档):插入 `candidate→validated→active`、强制 evidence
  gate、强制 scope、anti-pattern 可过期、后台默认关、两个斜杠命令(手动 learn / 录制式
  evolve)、per-skill 版本回滚。

**当前状态:整套 skill 自进化设计冻结。** 在"workflow 化能让 agent 可靠上线"被真实用户
验证愿意用之前,不投入实现——它是让骨架"越跑越稳"的 v 后期机制,不是 wedge。

---

## 5. 贯穿全程的纪律(这个项目的"病"与"药")

- **病:加法成瘾。** 找不到采用时,本能是"再加一个强功能就有人用了"(skill 进化!kernel!),
  但每加一层都离"一个具体用户的具体痛"更远。架构越漂亮,逃避越舒适。
- **药:减法 + 验证优先于建设。** 验证痛 > 建能力。冻结 ①②,聚焦 ③,先证明有人愿用,再建引擎。

---

## 6. 新窗口的第一步

不要写代码。从这里接:

1. 回答 §2.2:**那个"不敢上线"的团队,具体是什么场景的 agent?**
2. 据此回答 §2.1:**一个 LangGraph 给不了、你能给的词是什么?**
3. 写出那段"如果你是谁、正被什么疼着、SparkWright 凭什么让你换"的话,拿去给一个真实的人看,
   看他眼睛亮不亮。**写得出且有人要 → 才开始谈 workflow engine 怎么建。**
