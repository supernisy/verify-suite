# verify-suite

![specgate 验收门禁](https://github.com/supernisy/verify-suite/actions/workflows/specgate-gate.yml/badge.svg)

> **判定层为主 + 驱动层为辅的 UI 校验工具集**：既能对前端页面做「视觉 / 交互 / 行为」还原度判定，也能把任意 UI（浏览器 / 原生 App）的「理解 → 操作 → 验证」固化成可复现的测试流程。

## 这个仓库做了什么

verify-suite 目前承载**两条能力**：

### 能力一 · 前端还原度校验（原有）
把「页面 1 vs 页面 2」或「页面 vs 设计稿」变成一份**退出码为 0/2** 的差异清单——谁偏大、谁偏小、哪侧独有。判定层（容差 / 对齐 / 断言语义）是资产，CDP 只是当前采集适配器，可替换。
路线：A 探针精确卡尺 · B 语义指纹 · C 文本骨架 · E 行为契约。详见 [`SKILL.md`](./SKILL.md)。

### 能力二 · 通用 UI 测试（本次新增，重点）
把「**可视化 → 序列化 → UI 交互**」链路提炼成**通用、可迁移**的能力，让任意 AI 套任意 UI（浏览器优先、原生 App 其次）都能复现稳定的「理解 + 操作 + 验证」结果，且输出可被第三方（含另一个 AI）复核。

本次交付物：
- **方法论 + 4 套模板**：[`docs/ui-testing/methodology.md`](./docs/ui-testing/methodology.md)、[`docs/ui-testing/templates/`](./docs/ui-testing/templates/)（OpenSpec spec / specgate 契约 / 序列化 schema / 交互计划）
- **适配器**：浏览器主适配器 `adapters/web-cdp/`——通用 UI 测试走 Playwright 采集器 `scripts/ax-collect-pw.mjs`（直接调用 Playwright 官方库，非自研驱动），前端还原度走 CDP 采集器 `scripts/ax-collect.mjs`；原生 App 扩展适配器 `adapters/ax-native/`
- **虚构端到端示例**：[`examples/general-ui/`](./examples/general-ui)（AcmeHR Web 端到端，以 AX 树为主，不绑定真实产品）
- **需求与契约**：[`openspec/specs/general-ui-testing/spec.md`](./openspec/specs/general-ui-testing/spec.md)、[`acceptance/ui-testing/contract.yaml`](./acceptance/ui-testing/contract.yaml)（已 `specgate lint` 过关）
- **封装好的 Skill**：[`skills/ui-testing-workflow/SKILL.md`](./skills/ui-testing-workflow/SKILL.md)（见下）

> **执行层架构立场**：浏览器驱动**直接复用 Playwright 官方库**（commodity），不自研驱动封装；本项目的护城河在「契约 + 证据等级 + 完整性断言 + 安全边界」这一验证层（详见 `openspec/specs/playwright-web-driver/spec.md` 的 No In-House Driver 约束，经 `adopt-industry-drivers` 变更定稿）。

设计灵魂两条不可妥协：**① 需求驱动**（只做需求要的、只在盲区降级）；**② 确定性 + 可溯源**（AX 树为主、LLM 只解释、每个字段带证据等级 `source` + `confidence`）。

## 有哪些 Skill

| Skill | 路径 | 作用 | 触发场景 |
|---|---|---|---|
| **`ui-testing-workflow`**（本次新增） | [`skills/ui-testing-workflow/SKILL.md`](./skills/ui-testing-workflow/SKILL.md) | 把「OpenSpec 建需求 → SpecGate 定契约 → 常规实现与测试 → 调用 verify-suite 执行」整条链路固化成 5 步；**也支持轻量模式**——用户直接给测试用例、无需 OpenSpec/SpecGate，AI 直接调 verify-suite 执行引擎 | "给某个 UI（浏览器 / 原生 App）建一套测试 / 抽取 / 驱动流程"；或提到 OpenSpec / SpecGate / 验收契约 / UI 自动化测试；或"我直接给你测试用例你帮我跑" |
| 前端还原度（原有） | [`SKILL.md`](./SKILL.md) | 路线 A/B/C/E 的命令索引、场景选择与踩坑提示 | "页面 vs 设计稿 差异比对""交互 / 行为还原度" |

> `ui-testing-workflow` 的元信息（YAML 头部）：`name: ui-testing-workflow` · `version: 0.1.1` · `type: tool` · `description` 写明"什么诉求下触发（含轻量模式）"。

## Skill 怎么配置

`ui-testing-workflow` 是一个标准 WorkBuddy skill，**整个目录复制即用**，无需额外依赖。

### 1. 安装位置（二选一）
- **用户级**（跨项目生效）：`~/.workbuddy/skills/ui-testing-workflow/`
- **项目级**（随仓库走）：`<你的项目>/.workbuddy/skills/ui-testing-workflow/`

把本仓库的 `skills/ui-testing-workflow/` 整个目录拷过去，**核心文件只是 `SKILL.md`**；复制后重启 WorkBuddy（或刷新 skill 列表）即生效。

### 2. 触发方式
- **显式调用**：在对话里说"用 ui-testing-workflow skill，给 AcmeHR 的候选人沟通页建一套测试……"
- **自动匹配**：Agent 会按 `SKILL.md` 头部的 `description` 判断是否触发——`description` 写得越具体，自动触发越准。

### 3. 配置项（都在 `SKILL.md` 里改）
- **front-matter**：`name` / `description`（自动匹配的唯一依据）/ `version` / `type: tool`。要改触发条件，主要改 `description`。
- **两条不可妥协的硬规则（不要删）**：
  - `Step 0 前置确认`：不假设 OpenSpec / SpecGate 已安装，缺失先引导获取（见 [`WORKFLOW.md` §0.5](./docs/ui-testing/WORKFLOW.md)）。
  - `Step 4 目标缺失必须问人`：执行时若用户没给目标（URL / 窗口 / 进程），必须停下澄清，绝不用占位 / 猜测目标继续。
- **路径常量**（按需调整）：适配器 `adapters/web-cdp/`、`adapters/ax-native/`；契约目录 `acceptance/<能力名>/contract.yaml`；模板 `docs/ui-testing/templates/`。
- **想适配一个新的 UI**：复制 [`templates/openspec-spec.md`](./docs/ui-testing/templates/openspec-spec.md) 写 `spec.md` → `specgate bridge` 出契约草稿 → `lint` 修缺口 → 定稿 `contract.yaml` → 写适配器 / 交互计划 → 跑通示例。

## 怎么用

### 给人类（三步）
1. **想清楚要测哪个 UI、验证什么**（抽取哪些信息、做哪些可逆操作）。
2. **给 AI 一个可被自动化访问的目标**（URL / 窗口 / 进程）。⚠️ 目标没给，AI 会停下问你，不会自己瞎猜。
3. **说一句话**，例如：
   > "用 ui-testing-workflow skill，给 AcmeHR 的候选人沟通页建一套测试：抽出发件人 / 时间 / 正文，并给'已发面试邀请'的会话打标签。"

AI 会**自动走完**：OpenSpec 锁需求 → SpecGate 定契约（含 lint）→ 常规实现与测试 → 调用 verify-suite 执行 → 出**带证据等级**的验证报告。

> 不想用 Skill 也行：照 [`WORKFLOW.md`](./docs/ui-testing/WORKFLOW.md) 手动走同样链路。

### 没装 OpenSpec / SpecGate？直接把测试用例丢给 AI（轻量模式）

完整链路（OpenSpec→SpecGate）是"正规范式"，**不是必须的**。如果你本机没装这两个工具、也不想学 `contract.yaml` 格式，走**轻量模式**即可：

- 你只需给两样：**① 一个可被访问的目标**（URL / 窗口 / 进程，这条不能省，没给 AI 会停下问你）；**② 测试用例本身**（自然语言列表 / 表格 / 截图描述都行）。
- AI 会自己读用例 → 归一化成执行计划 → **直接调 verify-suite 执行引擎跑**（序列化→observe/drive→出带证据等级的报告），全程**不依赖 OpenSpec / SpecGate、不需要你写任何契约**。
- 两种模式在执行层完全一致（同样的 AX 树为主、超集采集门、完整性断言、安全边界）；区别只在"用例从哪来"。想升级成可 CI 卡门禁的正式契约时，再把这轮用例反过来生成 `contract.yaml` 即可。

详见给人文档 [`docs/ui-testing/QUICKSTART.md` §4](./docs/ui-testing/QUICKSTART.md)、给 AI 文档 [`docs/ui-testing/AGENT-HANDOFF.md` §13](./docs/ui-testing/AGENT-HANDOFF.md)。

### 给 AI / 开发者（触发后照 5 步）
1. **OpenSpec 建需求** → 2. **SpecGate 定契约 + `lint` 过关** → 3. **常规实现与测试** → 4. **调用 verify-suite 执行**（读契约 → 选适配器 → 确认目标 → 序列化 → `observe` / `drive` / `multi-step` → 出报告）→ 5. **输出带证据等级的报告**。
详细接口契约、契约规范、陷阱清单见 [`AGENT-HANDOFF.md`](./docs/ui-testing/AGENT-HANDOFF.md)。

## 引导到对应页面（按角色对号入座）

| 你是… | 看这个 | 内容 |
|---|---|---|
| 想快速看懂做了什么 | [`docs/ui-testing/QUICKSTART.md`](./docs/ui-testing/QUICKSTART.md) | 给人看的极简上手：做了什么 / 影响哪些地方 / 极简 Demo / 怎么用 Skill |
| 开发 AI，要接手继续做 | [`docs/ui-testing/AGENT-HANDOFF.md`](./docs/ui-testing/AGENT-HANDOFF.md) | 给 AI 的极详细交接：链路 / 文件职责 / 接口契约 / 契约规范 / 已验证事实 / Skill 安装使用 |
| 人 + AI 走完整流程 | [`docs/ui-testing/WORKFLOW.md`](./docs/ui-testing/WORKFLOW.md) | 从需求到测试执行的端到端链路，每阶段标清「人 / AI / 产出」 |
| 想看方法论总纲 | [`docs/ui-testing/methodology.md`](./docs/ui-testing/methodology.md) | 五步方法论 + 选型矩阵 + 安全边界 + 陷阱清单 |
| 要写新 UI 测试 | [`docs/ui-testing/templates/`](./docs/ui-testing/templates/) | OpenSpec spec / specgate 契约 / 序列化 schema / 交互计划 四套可复制模板 |
| 看真实示例 | [`examples/general-ui/`](./examples/general-ui) | 虚构 AcmeHR Web 端到端（含 multi-step 编排） |

---

## 能力一 · 前端还原度校验（原有，路线 A/B/C/E）

> 判定层为主、CDP 只是当前唯一的采集适配器。给前端页面对设计稿 demo 做**视觉还原** + 对 PRD 做**交互还原**，输出可判定的差异报告。

**能做什么**：在 DOM 上采集运行时几何 / 字号 / 字重 / 色值；对齐异构 DOM（语义指纹 = `role|文案`）；指出谁偏大 / 偏小（容差按量纲分档）；零 npm 依赖，Node 22 + 任意 Chromium。

**路线选择**：跑 `probe-anchors` 体检 → 角色 / testid 较全走 B；角色缺失走 C；目标组件明确要精确字段走 A；视觉都对上了还要确认行为走 E。

**退出码（CI 可消费）**：`0` 无差异 / `1` 执行错误（含采集为空、无进展）/ `2` 检出差异。★ 空结果不是无差异，是执行错误。

**证据等级**：每个 item 带 `evidence` + `confidence`（`computed-style` / `ax-tree` / `text-skeleton` / `network` / `console` / `pixel`），一次比对的可信度 = 所有 item 里最低档；降级必须留痕，严禁静默降级。

完整命令索引、参数与坑位清单见 [`SKILL.md`](./SKILL.md)。

### 与 specgate 联动
验收标准落在 [`acceptance/contract.yaml`](./acceptance/contract.yaml)，由 [specgate](https://github.com/supernisy/specgate) 做确定性门禁（零模型、可复现）。契约每条 `accept` 的 `verify` 字段直接对应本工具的路线：`geo`→geo-compare · `ax`→ax-diff · `unit-visual`→unit-collect · `trace`→trace-diff。specgate 管「该验什么」，verify-suite 管「怎么验」。

**PR 自动门禁**：改动 `acceptance/` 下契约的 PR 会先过 specgate `lint`；门禁工作流 [`.github/workflows/specgate-gate.yml`](./.github/workflows/specgate-gate.yml) 自动发现 `acceptance/*.yaml` 与 `acceptance/**/*.yaml` 并逐一 lint（跳过 `*-bad.yaml` 与 `*.draft.yaml`）。

## 文档导航

- [`skills/ui-testing-workflow/SKILL.md`](./skills/ui-testing-workflow/SKILL.md) · 本次新增的可复用 Skill（OpenSpec→SpecGate→verify-suite 一键链路）
- [`SKILL.md`](./SKILL.md) · 前端还原度路线 A/B/C/E 命令用法 + 场景选择 + 踩坑提示
- [`AGENTS.md`](./AGENTS.md) · 给后续 AI 的工程化决策与设计权衡
- [`docs/ui-testing/`](./docs/ui-testing) · 通用 UI 测试全套文档（QUICKSTART / WORKFLOW / AGENT-HANDOFF / methodology / templates）
- [`acceptance/contract.yaml`](./acceptance/contract.yaml) · specgate 验收契约（前端还原度）
- [`examples/demo/`](./examples/demo) · 前端还原度最小 demo（一键复现）

## License

MIT
