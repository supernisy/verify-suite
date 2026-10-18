# 通用 UI 测试 · 整体开发流程（从需求到测试执行）

> 本文档描述一条**端到端的开发链路**：  
> **用户用 OpenSpec 建立需求 → 用 SpecGate 定契约 → 常规实现与测试 → 调用 verify-suite 执行测试用例**。  
> 它同时写给**开发人员**和**他们各自的 AI agent**——每个阶段都标清「人做什么 / AI 做什么 / 产出什么」，让链路上的每一环都能被独立接手、可被复核。
>
> 配套文档：给人看的 `QUICKSTART.md`、给开发 AI 的 `AGENT-HANDOFF.md`、方法论总纲 `methodology.md`、四套模板 `templates/`。

---

## 0. 这份文档解决什么问题

你（或你的 AI）最终要回答的是：

> 「我做了一个 UI 功能（网页 / App / 小程序），**怎么稳定地验证它「对不对」**，并且让**另一个 AI 也能照着同一份标准去测**？」

答案不是"写个脚本点点点"，而是一条**需求先行、契约锁死、执行可复核**的链路。verify-suite 在这条链路里的定位是**第④步——测试执行引擎**：它吃上游定好的契约，把 UI 序列化成结构化数据，按契约抽取 / 驱动 / 验证，并产出带证据等级的报告。

> ⚠️ 关键认知：**OpenSpec / SpecGate 是上游需求与判定工具**（使用前需先获取，见 §0.5 前置准备），verify-suite 是下游执行层。三者是串联关系，不是替代关系。

---

## 0.5 前置准备：OpenSpec / SpecGate 不一定已安装

本文档 ①② 阶段依赖两个外部工具。**它们不一定已经在你的环境里**——文档**不假设你已装好**。开始前请先确认：

| 工具 | 作用 | 如何确认已安装 | 若未安装，如何获取 |
|---|---|---|---|
| **OpenSpec** | ① 阶段写需求 `spec.md` | 终端跑 `openspec --version` 或 `npx openspec --version` 看是否有输出 | 社区 CLI：用 `npm i -g openspec` 安装，或直接 `npx openspec` 临时使用；部分 Agent 环境也提供 OpenSpec skill，可启用后调用 |
| **SpecGate** | ② 阶段定契约 `contract.yaml` 并 `lint` | 终端跑 `specgate --version`，或检查本地是否存在其 CLI 根目录（常见位置如 `~/.workbuddy/specgate/`） | 以本地 CLI 形式分发：从 SpecGate 仓库获取源码后 `node <specgate根目录>/src/cli.js lint <契约.yaml>` 运行；或在 Agent 环境启用 specgate skill |

> ⚠️ 文档里的命令示例用 `<specgate>` 表示「SpecGate CLI 的根目录」，请替换成你机器上的实际路径（或你 Agent 环境里对应的调用方式）。**不要假设路径就是某个固定值。**
>
> 若暂时无法安装这两个工具，①② 阶段仍可**手动**完成：按 `templates/openspec-spec.md` 手写 `spec.md`、按 `templates/specgate-contract.md` 手写 `contract.yaml`（只需满足契约字段规范，不一定必须跑 lint）。但跑一遍 `lint` 能机械校验契约质量，强烈建议装。

---

## 1. 链路全景

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        整体开发流程（人与 AI 协作）                          │
└──────────────────────────────────────────────────────────────────────────┘

 ① 建立需求              ② 定契约(验收)            ③ 实现与测试              ④ 执行测试
 OpenSpec                SpecGate                 （你的常规开发）           verify-suite
─────────────          ─────────────            ─────────────            ─────────────
 人：决定测什么         人：确认"什么算对"        人：实现 UI 功能          人：给目标+契约+适配器
 AI：写 spec.md         AI：bridge→lint 修缺      AI：写实现+单测           AI：吃契约→生成用例
        │                        │                         │                      │
        ▼                        ▼                         │                      ▼
 spec.md ──(bridge)──▶     contract.yaml ──(交接物)──▶  (实现已就绪) ──▶  serialized.json
 (需求侧)                (判定侧,lint过关)                                   extracted 报告
                                                                           evidence 报告
        │                        │                                                │
        └────────────────────────┴──────── 同一份 contract.yaml 是人与多 AI 的交接物 ─┘
```

**交接物（handoff artifact）概念**：`contract.yaml` 是这条链路里最关键的"协议文件"。人写一次、AI 反复吃——下游"生成测试用例的 AI"和"执行测试的 AI"不需要重新理解业务，直接读契约即可。这就是为什么需求要先落成结构化契约，而不是一段模糊的 prompt。

---

## 2. 分阶段详解

每个阶段都用「**人 / AI / 产出**」三栏说明。

### Phase ① — OpenSpec 建立需求

| | 内容 |
|---|---|
| **人做什么** | 想清楚：要测哪个 UI？覆盖哪些场景？每种场景的预期结果是啥？哪些**不测**（非目标）？ |
| **AI 做什么** | 协助把口述/草稿需求，按 OpenSpec 规范写成 `spec.md`：`Capability` + `### Requirement:` + `#### Scenario:` + `- **Given/When/Then**`。可套 `templates/openspec-spec.md`。 |
| **产出物** | `openspec/specs/<你的能力名>/spec.md` |
| **过关标准** | 每个 Requirement 都有可判定的 Scenario（Given/When/Then 写清"在 X 条件下，做 Y，应得到 Z"）。 |

> 示例片段（浏览器消息列表抽取）：
> ```markdown
> ### Requirement: 序列化（Serialize）
> 系统 SHALL 把目标 UI 的可见状态序列化为结构化数据。
> #### Scenario: 枚举全部可见消息
> - **Given** 一个 Web 页面含 N 条候选消息（AX 树可达）
> - **When** 执行 web-cdp 适配器枚举遍
> - **Then** 输出恰好 N 条去重消息，每条含 body/time/source/confidence
> ```

---

### Phase ② — SpecGate 定契约（"什么算对"）

| | 内容 |
|---|---|
| **人做什么** | 确认每一条验收的"对"到底长什么样，特别是**证据等级**（ax-tree=high / screenshot=medium）和**完整性断言**（总数、去重、时间跨度）。 |
| **AI 做什么** | ① `specgate bridge spec.md contract.yaml` 把 spec 确定性转成契约草稿；② `specgate lint contract.yaml` 跑 11 项检查；③ 按 lint 标的缺口补 `invariants`、改 `then` 措辞，直到过关（exit 0）。可套 `templates/specgate-contract.md`。 |
| **产出物** | `acceptance/<你的能力名>/contract.yaml`（**lint 必须 EXIT=0**） |
| **过关标准** | `contract` / `intent` 有值；`accept[]` 每条有 `id,given,when,then,verify`；`out_of_scope[]` 非空；含"计数"语义的 `then` 必须补 `invariants` 且不能恒真；`verify` 取值在 9 种之内（`type/unit/contract-test/geo/ax/unit-visual/trace/state-matrix/manual`）。 |

> 命令（先确认 SpecGate 已安装，见 §0.5；`<specgate>` 替换成你的 CLI 根目录）：
> ```bash
> # 把 spec.md 转成契约草稿
> node <specgate>/src/cli.js bridge openspec/specs/<cap>/spec.md acceptance/<cap>/contract.yaml
> # 校验并修缺口，直到 EXIT=0
> node <specgate>/src/cli.js lint acceptance/<cap>/contract.yaml
> ```
> 标准循环：**写 spec → bridge 出草稿 → lint 标缺口 → 补 invariants → 重跑过关**。

---

### Phase ③ — 常规实现与测试（verify-suite 尚未介入）

| | 内容 |
|---|---|
| **人做什么** | 按需求实现 UI 功能；准备一个**可被自动化访问的目标**（本地服务 / 测试账号 / 预览环境）。 |
| **AI 做什么** | 写实现代码、写常规单元测试、搭好可访问的测试页面或 App。 |
| **产出物** | 可运行的功能 + 一个明确的"被测对象"（URL / 窗口 / 进程）。 |
| **与 verify-suite 的关系** | 此阶段 verify-suite 不强制介入。但**建议**：把 Phase ② 的 `contract.yaml` 同步给开发 AI，让它知道"正确"的标准，避免实现与验收两张皮。 |

> 此时如果契约里某些字段 AX 树拿不到（如头像、图表），实现侧要保证这些字段在 UI 上有可定位的语义节点（role/名称），这样 Phase ④ 才能用 AX 为主策略，少截图。

---

### Phase ④ — 调用 verify-suite 执行测试用例

| | 内容 |
|---|---|
| **人做什么** | 提供三样东西给执行 AI：**① 目标**（被测 URL / 窗口 / 进程，必须是**可被自动化访问**的）、**② 契约** `contract.yaml`、**③ 适配器选择**（浏览器=`web-cdp`，原生 App=`ax-native`）。<br>**⚠️ 若「目标」未提供，执行 AI 必须停下并向用户澄清，绝不能用占位/猜测的目标继续。** |
| **AI 做什么** | 读 `contract.yaml` → 生成具体测试用例（交互计划，套 `templates/interaction-plan.md`）→ 调对应适配器**序列化**（枚举遍只读 AX、富化遍只补 AX 盲区）→ 按契约做 `observe`（抽取/断言）或 `drive`（驱动操作）→ **对照契约出证据报告**（`source` + `confidence` 每条字段可溯源）。 |
| **产出物** | `serialized.json`（序列化产物）+ `extracted.md`（抽取/标记结果）+ `evidence` 报告（逐条对照契约 Given/When/Then 的通过/失败 + 证据等级）。 |
| **过关标准** | 报告逐条回扣契约 `accept[]`；完整性断言通过（去重计数=预期总数）；任何"看似成功"都必须有下一次观测/状态 diff 验证（fail-loudly，不静默当成功）。 |

> 执行 AI 的核心纪律（来自 `methodology.md`）：
> 1. **需求驱动**：契约没要的字段不序列化；契约说"只取文字"就绝不截图。
> 2. **确定性 + 可溯源**：AX 树为 ground truth，LLM 只解释/补位；每个字段带 `source`+`confidence`。
> 3. **超集采集门**：语义 role 命中 OR 名称含日期时间即收录，被过滤节点进账本，**绝不静默丢行**。
> 4. **安全边界**：登录/支付/删除/发消息等不可逆动作**一律停下问人**。

---

## 3. 端到端走查（以虚构 AcmeHR 为例，贯穿四阶段）

> 完整文件见 `examples/general-ui/`（`README.md` / `acme-hr-serialized.json` / `acme-hr-extracted.md` / `acme-hr-multistep.md`）。

| 阶段 | 动作 | 产出 |
|---|---|---|
| ① OpenSpec | 决定：从 AcmeHR「候选人沟通记录」页抽取说话人/时间/正文，并自动标记"已发面试邀请"的会话 | `spec.md`（4 个 Requirement：序列化/抽取/驱动/多步编排） |
| ② SpecGate | `bridge` 出草稿 → `lint` 修 3 处缺口（U3/U5 invariants 恒真、U4 缺 invariants）→ 过关 | `contract.yaml`（EXIT=0，9 条验收） |
| ③ 实现 | 开发出 AcmeHR 候选沟通页（消息带语义 role、时间可定位） | 可访问的测试页 |
| ④ 执行 | 执行 AI 选 `web-cdp` 适配器：CDP 取整页 AX → 枚举 3 条消息（零截图）→ observe 抽字段 → drive 给命中行打标签（可逆、未触人审边界）→ 重序列化 + 状态 diff 验证 → 出报告 | `serialized.json` + 抽取报告 + 证据（ax-tree=high） |

**走查结论**：链路从"人一句话需求"到"带证据等级的可复核报告"，全程没有模糊口头约定，每一步都有文件交接。

---

## 4. 交接物清单（人与 AI 之间的协议）

| 文件 | 谁产生 | 谁消费 | 作用 |
|---|---|---|---|
| `openspec/specs/<cap>/spec.md` | 人 + 需求 AI | SpecGate bridge | 定义"测什么"（场景 + Given/When/Then） |
| `acceptance/<cap>/contract.yaml` | SpecGate（bridge+lint） | **执行 AI（核心交接物）** | 定义"什么算对"（断言 + 证据等级 + 完整性） |
| `serialized.json` | 执行 AI（适配器） | 执行 AI / 人 | 序列化产物，结构化 UI 状态 |
| `extracted.md` / evidence 报告 | 执行 AI | 人 / 下游 AI | 抽取结果与逐条契约对照 |

> **最重要的协议文件是 `contract.yaml`**：它让"生成测试用例的 AI"和"执行测试的 AI"都不必重新理解业务，直接读契约即可。这也是本链路可迁移给"别的 AI 做别的 UI 测试"的根本原因。

---

## 5. 给「执行测试的 AI」的可直接执行清单

当你（执行 AI）拿到 `contract.yaml` + 适配器后，按此顺序做。**若其中「目标」缺失，不要继续，先向用户澄清要测的是哪个 URL / 窗口 / 进程。**

```
1. 读 contract.yaml：提取 accept[] 的 id/given/when/then/verify，以及 out_of_scope[]。
2. 选型：浏览器 → web-cdp；原生 App → ax-native（见 adapters/）。
3. 盘点：**先确认「可自访问的目标」已由用户提供**（URL / 窗口 / 进程）。若未提供，必须停下向用户澄清，不要猜测或用占位目标继续。然后再查是否已有现成导出物/更便宜路径（如剪贴板），避免重做。
4. 序列化：
   - 枚举遍：只读 AX，滚完虚拟列表，去重，不截图。
   - 富化遍：仅 AX 盲区字段截图补位，标 screenshot=medium，写 degradation 账本。
   - 超集采集门：role 命中 OR 名称含日期即收录，被过滤节点进账本。
   - 完整性断言：去重计数 + 已知总数比对 + 首尾时间，空/缺=执行错误。
5. 交互：
   - observe：按契约抽字段 + 断言。
   - drive：可逆可观测动作才自动；人审边界（登录/支付/删除/发消息）停下问。
   - 验证用"重序列化 + 状态 diff"，不用"再截一张图让模型猜"。
6. 出报告：逐条回扣契约 Given/When/Then，每条字段带 source+confidence；N 次不满足即 fail-loudly。
7. 自检：lint 同款契约是否仍 EXIT=0（若有改动）；输出 provenance 报告供第三方复核。
```

---

## 6. 常见错误 / 不要做的事

- ❌ **把语音误识别当真需求**：用户口述的 "OpenSPG / SPG Gateway" 是语音转文字的误识别，实际就是 "OpenSpec / SpecGate"。不存在额外的"OpenSPG 语音转化系统"，不要据此去建任何上游系统。正确链路就是 OpenSpec → SpecGate → 生成用例 → 执行。
- ❌ **需求没锁死就动手**：scope 不写清，AI 会范围蔓延（例如你说"只取文字"它却去加图像扫描）。
- ❌ **静默丢行 / 静默当成功**：采集用白名单会漏行；"以为成功实际没成"是头号失败源（业界约 1/3 失败源于此）。必须超集门 + 完整性断言 + fail-loudly。
- ❌ **枚举与富化不分离**：把"截图锚定"挂到每一步滚动上，会让批量读取慢几十倍。枚举遍只读 AX，富化遍才截图。
- ❌ **错配工具**：浏览器用 CDP/AX、原生 App 用 UIA/AX、移动用对应桥；Compute Use / AST 对原生 UI 是错配。
- ❌ **重做已完成的东西**：动手前先盘点工作区，确认没有现成导出物或更便宜路径。

---

## 7. 相关文档索引

| 文档 | 给谁 | 内容 |
|---|---|---|
| `QUICKSTART.md` | 人 | 做了什么 / 影响哪些地方 / 极简 Demo |
| `AGENT-HANDOFF.md` | 开发 AI | 链路/接口契约/契约规范/陷阱/已验证事实/下一步 |
| `methodology.md` | 所有人 | 五步方法论 + 选型矩阵 + 安全边界 + 陷阱清单 |
| `templates/openspec-spec.md` | 需求 AI | OpenSpec 需求模板 |
| `templates/specgate-contract.md` | 契约 AI | spec gate 契约模板 |
| `templates/serialization-schema.md` | 执行 AI | 序列化 schema 模板 |
| `templates/interaction-plan.md` | 执行 AI | UI 交互计划模板（observe/drive/multi-step） |
| `examples/general-ui/` | 所有人 | 浏览器端到端示例（含多步工作流编排） |
| `adapters/web-cdp/` · `adapters/ax-native/` | 执行 AI | 主/扩展适配器骨架 |
| `openspec/specs/general-ui-testing/spec.md` | 参考 | 已落地的 OpenSpec 能力 spec |
| `acceptance/ui-testing/contract.yaml` | 参考 | 已 lint 过关的契约样例 |
