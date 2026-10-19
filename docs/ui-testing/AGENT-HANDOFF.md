# 通用 UI 测试能力 · 开发 AI 交接报告（极度详细）

> 本文档是给**负责开发/维护本模块的 AI agent** 的权威交接物。它假设你有代码执行能力，
> 目标是在不依赖人类口述经验的前提下，把整条链路、每个文件的职责、接口契约、契约规范、
> 陷阱、已验证事实与下一步行动清单完整交付，让 AI 能直接接手继续做。

---

## 0. 一句话背景与目标

把 "大模型可视化 → 序列化 → UI 交互" 提炼成 **通用、可迁移** 的 UI 测试能力，
让任意 AI 套任意 UI（浏览器优先、原生 App 其次、移动端待扩展）都能复现稳定的
"理解 + 操作 + 验证" 结果，且输出可被第三方（含另一个 AI）复核。

本模块是 verify-suite 的**第二能力**：既有的「前端还原度判定」（Web/CDP）保持不变，
本模块在其分层架构上挂载新的驱动层适配器与判定层契约。

---

## 1. 链路总览（需求侧到执行侧）

```
[OpenSPG 纠错说明] 用户口述的 "OpenSPG / SPG Gateway" 是语音输入转文字的误识别，
                   实际指 "OpenSpec / SpecGate"。不存在额外的 OpenSPG 系统。
                   正确链路如下：

OpenSpec spec.md  ──(specgate bridge)──▶  contract.yaml（spec gate 验收契约）
        │                                        │
        │ 定义"测什么"(Requirement/Scenario)      │ 定义"什么算对"(given/when/then + 证据等级)
        ▼                                        ▼
  AI 生成测试用例  ──────────────────────▶  执行测试用例（序列化 → 交互 → 验证）
                                             对照 contract.yaml 出证据报告
```

- **OpenSpec**（`openspec/specs/general-ui-testing/spec.md`）= 需求侧，写清要测什么、场景、Given/When/Then。
- **spec gate**（`acceptance/ui-testing/contract.yaml`）= 判定侧，把"对"定义成可判定断言，可被 `specgate lint` 机械校验。
- **AI 生成测试用例 → 执行**：下游 agent 吃的是 `contract.yaml` 这份结构化契约（不是模糊 prompt），它是人和多个 AI 的**交接物（handoff artifact）**。
- 其余阶段（盘点/选型/序列化/交互）用本模块的适配器与模板执行。

---

## 2. 仓库结构与文件职责（file-by-file）

```
verify-suite/
├── docs/ui-testing/
│   ├── methodology.md          # 方法论总纲：5 步链路 + 选型矩阵 + 安全边界 + 陷阱清单
│   ├── QUICKSTART.md           # 给人看的极简上手（做了什么/影响/极简 Demo）
│   ├── AGENT-HANDOFF.md        # 本文件：给开发 AI 的极详细交接
│   └── templates/
│       ├── openspec-spec.md        # OpenSpec 需求模板（capability + Requirement + Scenario/GWT）
│       ├── specgate-contract.md    # spec gate 验收契约模板（given/when/then + 证据等级 + 完整性断言）
│       ├── serialization-schema.md # 序列化 schema 模板（AX 树 + 截图锚点 + 降级日志字段）
│       └── interaction-plan.md     # UI 交互计划模板（observe / drive / multi-step）
├── adapters/
│   ├── web-cdp/ax-collect.py   # 【主适配器】Web/CDP 采集骨架（生产实现见 scripts/ax-collect.mjs）
│   └── ax-native/ax-collect.py # 【扩展适配器】原生桌面 App 采集骨架（Win UIA/macOS AX）
├── examples/general-ui/        # 虚构 Web 应用「AcmeHR」端到端示例（不绑微信）
│   ├── README.md               # 五步链路演示
│   ├── acme-hr-serialized.json # 序列化产物样例（adapter=web-cdp）
│   ├── acme-hr-extracted.md    # 抽取 + 标记 provenance 报告
│   └── acme-hr-multistep.md    # 多步工作流端到端（抽取→驱动→再校验 + 安全边界 + fail-loudly）
├── openspec/specs/general-ui-testing/
│   └── spec.md                 # OpenSpec capability spec（4 个 Requirement + Scenario）
├── acceptance/ui-testing/
│   ├── contract.yaml           # spec gate 验收契约（已 lint 过关，exit 0）
│   └── requirement.md          # 需求侧说明（与 spec.md 互补）
├── scripts/ax-collect.mjs      # 既有生产级 Web/CDP 适配器（本模块主适配器的生产实现）
├── .github/workflows/specgate-gate.yml  # 门禁（glob 已扩到 acceptance/**/*.yaml）
├── skills/ui-testing-workflow/SKILL.md  # 本模块封装成的可复用 skill（OpenSpec→SpecGate→verify-suite 一键链路）
├── SKILL.md / README.md        # 各加一节「通用 UI 测试能力」+ README 链接到 skill
└── (既有) acceptance/contract.yaml, scripts/lib/cdp.mjs 等保持不变
```

---

## 3. 设计灵魂（两条不可妥协，所有代码须遵守）

1. **需求驱动（Demand-driven）**：只序列化需求字段。AX `Name` 已含文字就只抽它，**零截图**；需求说"只取文字"就绝不截图。
2. **确定性 + 可溯源（Deterministic + Provenance）**：AX 树是 ground truth，LLM 只做解释/富化；每个输出字段带 `source` + `confidence`（`ax-tree=high` / `screenshot=medium`），可被复核。

由此派生的方法论五相（详见 `methodology.md`）：
- Phase 0 盘点与选型（先盘点、再选型；工具-目标-任务三维矩阵；最便宜够用优先）
- Phase 1 需求锁定（OpenSpec 写"做什么+不做什么"；spec gate 定可验证断言+完整性校验；范围外停下问）
- Phase 2 序列化（只序列化需求字段；**枚举/富化两遍分离**；settle 同步纪律收窄到富化遍；**超集采集门**；完整性断言）
- Phase 3 交互（observe / drive / multi-step 编排）
- Phase 4 验证（每个字段带来源+置信度；输出 provenance 报告）
- Phase 5 可迁移性（热路径确定性；skill 自带 决策矩阵+模板+陷阱清单；时间预算硬约束）

---

## 4. 适配器接口契约（已实现的两份骨架）

两份骨架（`adapters/web-cdp/ax-collect.py`、`adapters/ax-native/ax-collect.py`）同构，
核心接口约定如下，开发真实适配器时必须实现/满足：

### 4.1 采集门（超集，禁止白名单静默丢行）
```python
def collection_gate(role: str, name: str) -> bool:
    # 语义 role 命中 OR 名称含日期时间，二者满足其一即收录
    return (role in SEMANTIC_ROLES) or bool(DT_RE.search(name or ""))
```
- Web/浏览器用语义 `role`（W3C accname 已由浏览器算好，对页面零侵入）。
- 原生 App 用控件类名 + `Name` 含日期时间。
- **被过滤节点必须进账本（`filteredRoles` 计数），绝不静默丢弃。**

### 4.2 枚举遍 `read_ax` / `sweep_enum`
- 只读 AX，不截图，快且全。
- Web 多为整页树，一次 `Accessibility.getFullAXTree` 取全；若是**无限滚动/虚拟列表**（聊天流、长表），则：滚到底 → read_ax → 去重 → 再滚 → 直到首/末节点签名稳定（settle 思想）。
- **同步纪律**：滚动后等 AX 树重新稳定再读，**枚举遍不截图**。

### 4.3 富化遍 `enrich_blind_fields`
- 仅对 AX 拿不到的字段（头像图、纯视觉状态）截图补位，`confidence=medium`，写 `degradation` 账本。
- **同步纪律**：`settle(等 AX 稳定)` → 取该节点 DOM 几何 → 截帧（**方向前缀避免覆盖**）。
- 候选优先用 AX 几何（Set-of-Marks 思想），不要靠固定像素框猜（易错判）。

### 4.4 完整性断言 `assert_integrity`
```python
def assert_integrity(msgs, expected=None):
    sigs = [m["sig"] for m in msgs]
    dedup = len(sigs) == len(set(sigs))
    count_ok = (expected is None) or (len(msgs) == expected)
    if not (dedup and count_ok):
        raise AssertionError(...)   # 空/缺 = 执行错误，不是"完成"
```
- 去重计数、与已知总数比对、首尾时间戳、时间跨度。
- 直接治掉"首图没滚到底/数据截断"类事故（本项目早期真实踩过的坑）。

### 4.5 输出 schema `build_serialized`
```python
{
  "generatedAt": "...", "target": "...", "adapter": "web-cdp",
  "windows": { "W0": {"title":..., "rect":{}, "count":N, "messages":[...]} },
  "frames": [...],
  "degradation": {"blindFieldsInAX": bool, "reason": str, "filteredRoles": [...]}
}
```
每条 message 节点字段：`sig / role / name / body / time / rect / dtKey / contentType / source / confidence`。

### 4.6 执行前置澄清（目标缺失必须问人）

- 执行 AI 在「盘点」步骤（见 `WORKFLOW.md` §5 第 3 步）必须先确认**可自访问的目标**已由用户提供（URL / 窗口 / 进程）。
- **若目标未提供，立即停下向用户澄清，绝不用占位/猜测目标继续。** 这条与「安全边界」同级，属于不可妥协的前置纪律——没有目标，后续序列化/交互全部无从谈起。

---

## 5. spec gate 契约规范（已 lint 过关，务必照此写新契约）

SpecGate CLI 根目录：`<specgate>`（**路径不固定**，需按你的环境确认；常见如 `~/.workbuddy/specgate/`，或你的 Agent 环境内置的 specgate skill）。若尚未获取，见 `WORKFLOW.md` §0.5。
运行：`node <specgate>/src/cli.js lint <契约.yaml>`

### 5.1 字段与 11 项检查（阻塞项：②③⑤⑥⑦）
- `contract` / `intent` 必填
- `accept[]`：每条须有 `id, given, when, then, verify`；`out_of_scope[]` 非空
- `verify` 字段**必须是 9 种之一**：`type / unit / contract-test / geo / ax / unit-visual / trace / state-matrix / manual`（本项目用 `ax` 与 `unit`）
- ⑦ **invariants 有效性**：含"计数/数量"语义的 then 必须补 `invariants`；invariants 须描述"输入怎么变→输出怎么变"，**不得恒真**
- 写 invariants 的词表（`src/words.js`）：
  - 变动词 `CHANGE_WORDS`（如 增加/减少/翻倍/保持不变/同步）：用于描述输入侧变化
  - 关系词 `RELATION_WORDS`（如 比例/对应/命中）：用于描述输出侧
  - 恒真词 `TAUTOLOGY`（如 是/存在/正确）：**避开**，否则被判恒真废话
  - 示例正确写法：*"当目标总数 N 翻倍时，去重计数同步翻倍，且缺失数保持为 0"*

### 5.2 已知 lint 结果
- 初跑：`contract.yaml` 有 3 处阻塞（U3/U5 invariants 恒真；U4 计算类缺 invariants）→ 已按词表修好。
- **最终：11 项全过，退出码 0。**
- 约束源 = `builtin`（verify-suite 仓库根无 `constraints.yaml`，与既有契约同源，非阻塞）。若想约束源变 `project`，在仓库根加 `constraints.yaml` 即可。

### 5.3 OpenSpec → SpecGate 桥接（链路关键节点）
- `node <specgate>/src/cli.js bridge <spec.md> <out.yaml>` 可把 OpenSpec `spec.md` **确定性**转成 `contract.yaml`。
- 已验证：`bridge openspec/specs/general-ui-testing/spec.md` 生成 9 条契约；生成草稿有 1 处 ⑦ 缺口（含"计数"无 invariants），正是 lint 循环要人补的点（设计意图：bridge 出草稿 → lint 标缺口 → 补 invariants → 重跑过关）。
- **标准循环**：写 spec.md → `bridge` 出草稿 → `lint` 修缺口 → 过关定稿。

---

## 6. 多步工作流编排（multi-step）

见 `examples/general-ui/acme-hr-multistep.md`，演示编排：
```
抽取(observe) → 驱动(drive: 打标签/发送) → 重序列化 → 状态 diff 验证
```
要点：
- 每步独立可验证，中间记状态与检查点。
- **驱动验证用状态 diff，不用"再截一张图让模型猜"**（动画即可骗过像素比对）。
- 含安全边界演示：可逆、可观测中间动作（打标签）允许自动；人审边界（登录/支付/删除/发消息）停下交人（S5）。
- 含 fail-loudly（S6）：N 次内不满足即响亮失败，不静默当成功。

---

## 7. 安全边界（业界标准，须固化进任何实现）

1. **人审边界**：登录/认证、法律、财务支付、对外发消息、删除 —— 一律暂停交人。
2. **只自动化可逆且可观测的中间段**：不可逆副作用须确认后才做。
3. **改前备份**：改变状态/配置前先备份。
4. **显式验证才算完成**：每次动作由下一次观测/状态 diff 验证；N 次内不满足就 fail-loudly（OSWorld 约 1/3 失败源于"以为成功实际没成"）。
5. **每任务预算 + 检查点**：时间/截图/动作次数设上限，到限前存盘交人。
6. **升级机制**：模糊或状态变更步骤升级到更强模型或人工。

---

## 8. 陷阱清单（来自真实实践 + 业界，须固化进 skill）

| 坑 | 根因 | 治本点 |
|---|---|---|
| 首图没滚到底 / 数据截断 | 无完整性校验 | 4.4 完整性断言 |
| 滚动未停稳 → rect/截图错位 | settle 时机错 | 4.3 同步纪律收窄到富化遍 |
| 上扫帧覆盖下扫帧 → 错配 | 帧命名无方向区分 | 稳定签名 + 方向前缀（D/U） |
| 白名单静默丢行 | 限制性采集门 | 4.1 超集门 + 账本 |
| 范围蔓延加多余动作 | scope 未锁死 | Phase 1.1/1.3 停下问 |
| 错配工具（CDP/AST 对原生 App） | 无选型矩阵 | Phase 0.2 矩阵 |
| 重做已完成导出 | 没先盘点 | Phase 0.1 盘点 |
| 以为成功实际未成 | 无 fail-loud | 安全边界 4 |

---

## 9. 已验证事实（落地时以此为基线，不要重复踩坑）

- ✅ `acceptance/ui-testing/contract.yaml` 本地 `specgate lint` → 11 项全过，退出码 0。
- ✅ `specgate bridge` 能把 `spec.md` 确定性生成契约，OpenSpec→SpecGate 链路通。
- ✅ `adapters/web-cdp/ax-collect.py --demo` 与 `adapters/ax-native/ax-collect.py --demo` 均可在无浏览器/无 UI 环境下跑通，验证 schema 结构正确。
- ✅ `examples/general-ui/acme-hr-serialized.json` 为合法 JSON，符合 serialization-schema。
- ⚠️ 两个骨架的 `CdpSession.connect/send`、真实滚动循环、截图补位逻辑仍是 `TODO`：生产实现请直接复用既有 `scripts/ax-collect.mjs` + `scripts/lib/cdp.mjs`（零依赖、Node≥22 原生 WebSocket）。

---

## 10. 给开发 AI 的下一步行动清单

按优先级：

1. **（可选）补 `constraints.yaml`**：若要把契约约束源从 `builtin` 升为 `project`，在仓库根加一份自定义约束。否则维持现状即可。
2. **真实适配器落地**：`adapters/web-cdp/` 的 `TODO` 接入 CDP WebSocket（直接复用 `scripts/lib/cdp.mjs`，不要重写）。原生 App 同理接 UIA。
3. **新增 UI 场景**：照 `templates/` 四件套填 —— 先写 OpenSpec `spec.md` → `bridge` 出草稿 → `lint` 修缺 → 定稿 `contract.yaml` → 写适配器/交互计划 → 跑通示例。
4. **自带评测集（建议）**：仿 WebArena/OSWorld，ship 固定 eval 集，用成功率/步数/耗时/成本证明可迁移性（methodology 第 5 节已列）。
5. **提交与推送**：
   - git remote：`git config remote.origin.url https://github.com/supernisy/verify-suite.git`（本机全局 `insteadOf` 会把 github.com 重写到 ghfast.top 镜像通道，实际推送走镜像但可通；config 语义已正确）。
   - 门禁已覆盖 `acceptance/**/*.yaml`，PR 时 CI 跑 specgate-gate。

---

## 11. 关键纠错备忘（避免 AI 再踩）

- ❌ 用户口述的 "OpenSPG / SPG Gateway" 是**语音输入转文字的误识别**，实际是 "OpenSpec / SpecGate"。**不要**据此去构建任何 "OpenSPG 语音转化上游系统"。
- ✅ 正确链路就是 OpenSpec（需求）→ SpecGate（契约）→ AI 生成用例 → 执行。
- 本项目早期有过"把同一份微信聊天记录重做多遍、最后因加图像扫描超时"的教训：永远先盘点、需求锁死就别范围蔓延、枚举与富化分离。

---

## 12. 本模块的 Skill：`ui-testing-workflow`（给 AI 的安装与使用）

整条链路已封装成可复用 Skill：[`skills/ui-testing-workflow/SKILL.md`](../../skills/ui-testing-workflow/SKILL.md)（YAML 头部 `name: ui-testing-workflow` / `version: 0.1.1` / `type: tool`）。它支持**两条入口**：入口 A「OpenSpec 建需求 → SpecGate 定契约 → 常规实现与测试 → 调用 verify-suite 执行」完整链路，以及**入口 B 轻量模式**（用户直接给测试用例、无需 OpenSpec/SpecGate）。两条入口在执行层共用同一套 verify-suite 执行引擎，并写死两条硬规则（来自人类纠正，不可妥协）：

1. **Step 0 前置确认**：不假设 OpenSpec / SpecGate 已安装；缺失则先引导安装（获取方式见 §0.5），不要直接当已装去跑命令。
2. **Step 4 目标缺失必须问人**：执行时若用户未提供目标（URL / 窗口 / 进程），必须停下向用户澄清，**绝不能用占位或猜测的目标继续**。

### 12.1 怎么装到你的环境

把 `skills/ui-testing-workflow/` 整个目录复制到你的 skill 目录，二选一：

- **用户级**（跨项目）：`~/.workbuddy/skills/ui-testing-workflow/`
- **项目级**（随仓库走）：`<你的项目>/.workbuddy/skills/ui-testing-workflow/`

复制后重启 WorkBuddy（或刷新 skill 列表），即可通过以下方式触发：
- 显式说："用 ui-testing-workflow skill 给某 UI 建一套测试"；
- 或让 Agent 按 `description` 自动匹配（描述写得越具体，触发越准）。

> 目录里只需 `SKILL.md` 一个文件即可生效；`description` 是自动匹配的唯一依据，务必写实。

### 12.2 怎么用

触发后，先走 **Step 0 前置确认** 判定走哪条入口，再执行：

- **入口 A · 完整链路**：**① OpenSpec 建需求 → ② SpecGate 定契约并 `lint` 过关 → ③ 常规实现与测试 → ④ 调用 verify-suite 执行（契约即交接物，吃 `spec.md` + `contract.yaml`）→ ⑤ 出带证据等级的验证报告**。
- **入口 B · 轻量模式**：用户直接给测试用例（自然语言 / 表格 / 截图描述），**不需要 OpenSpec / SpecGate、不需要 `contract.yaml`** → AI 归一化为执行计划 → 直接调同一套 verify-suite 执行引擎 → 出报告。详见 §13。

衔接点（两入口共用）：Phase ④ 执行引擎就是本仓库——读 `acceptance/<cap>/contract.yaml`（入口 A）或归一化 `执行计划`/`cases.md`（入口 B）→ 选适配器（`web-cdp` / `ax-native`）→ 序列化（枚举遍只读 AX、富化遍只补盲区）→ observe / drive → 对照输入出报告。

⚠️ **执行层架构立场（已通过 OpenSpec `adopt-industry-drivers` 变更定稿）**：`web-cdp` 适配器**直接调用 Playwright 官方库**（`scripts/ax-collect-pw.mjs`），**不自研驱动封装**，也不写等价 driver；现成轮子可插拔（如 `@playwright/mcp`、Stagehand）。**后续若需增强执行能力，优先接入现成引擎，不要在验证层之外自研驱动**——我们的护城河在 specgate 的「契约 + 证据等级 + 完整性断言 + 安全边界」，不在驱动。
示例契约 [`acceptance/ui-testing/contract.yaml`](../../acceptance/ui-testing/contract.yaml) 已 `specgate lint` 过关（退出码 0），可作为模板。

### 12.3 仓库维护者注意（已完成）

`.github/workflows/specgate-gate.yml` 的 glob 扩展（`acceptance/*.yaml` → 增加 `acceptance/**/*.yaml`，让子目录契约也被门禁覆盖）**已推送**（commit `7acedc0`，main）。CI 门禁现覆盖 `acceptance/*.yaml` 与 `acceptance/**/*.yaml`，PR 时自动 `specgate lint`，跳过 `*-bad.yaml` 与 `*.draft.yaml`。

---

## 13. 轻量模式：用户直接给测试用例（无 OpenSpec / SpecGate）

当用户**没有 / 不想装** OpenSpec、SpecGate，直接把测试用例丢过来时，走此模式。**这是 Skill 的入口 B，执行层与入口 A 完全一致，只是"用例来源"不同。**

### 13.1 怎么识别该走入口 B

触发信号：用户说"帮我跑一下这个测试""按下面这几点测""我没装那些工具，直接给你用例"。**Step 0 前置确认**里就要问清走 A 还是 B；用户没明说但给了现成用例、且没提 OpenSpec/SpecGate，默认按 B 走并跟用户确认一句。

### 13.2 收用例（任意形式都接受）

用户给的形式不限：自然语言列表、Markdown 表格、甚至"截图里画的测试点"。AI 必须从中解析出三要素：

1. **被测目标**（URL / 窗口 / 进程）—— ⚠️ 最常缺失，缺失必须停下问人（硬规则，与入口 A 同）。
2. **每条用例的操作（given / when）**。
3. **每条用例的期望（then）**。

示例用户话术：
> "帮我测 AcmeHR 候选人沟通页（https://acmehr.example.com/messages）：① 打开看标题是不是'候选人沟通'；② 点开第一条会话，抽 发件人/时间/正文；③ 给'已发面试邀请'的会话打标签，再验证标签在不在。"

### 13.3 归一化（AI 内部步骤，用户无需参与）

- 把用例整理成内部**执行计划**，每条一个 `given / when / then`。建议顺手落一份 `cases.md` 到工作区以便追溯——**非必须**，且**不需要 contract.yaml 格式、不需要 lint**。
- 若用例自带"目标 + 期望" → 直接进执行。
- 若只有模糊意图（如"测一下登录"）→ **先按硬规则跟用户确认目标与期望**，绝不让模糊意图硬跑。

### 13.4 执行（复用入口 A 的执行引擎）

拿到 `执行计划 + 目标 + 适配器选择` 后，走 §4 的全部接口契约与纪律：盘点 → 选型 → 序列化（枚举/富化两遍分离、超集采集门、完整性断言）→ observe / drive / multi-step → 出**带证据等级**的报告。

### 13.5 出报告 & 升级

- 对照归一化的 `执行计划` / `cases.md` 逐条给 pass/fail + 证据（每条带 `source` + `confidence`）。
- 若用户后续想要"可机器复跑 / CI 卡门禁"的正式契约：用 `specgate bridge <cases.md> <契约.yaml>` 把执行计划反过来生成 `contract.yaml` 草稿 → `lint` 补 invariants → 升级到入口 A（此时才需要装 SpecGate）。
