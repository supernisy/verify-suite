---
name: ui-testing-workflow
description: 把"可视化 → 序列化 → UI 交互"链路封装成可复用 skill：从 OpenSpec 定义需求 → SpecGate 定验收契约 → 常规实现与测试 → 调用 verify-suite 执行测试用例；也支持轻量模式——用户直接提供测试用例、无需安装 OpenSpec/SpecGate，AI 直接调用 verify-suite 执行引擎出带证据等级的报告。当用户的诉求是"为某个 UI（浏览器 / 原生 App）建立一套可复现的测试 / 抽取 / 驱动流程"，或"按 OpenSpec + SpecGate 的契约去跑 UI 测试"，或"我直接给你测试用例你帮我跑"时使用。涵盖需求澄清、契约 lint、自带用例归一化、AX 树为主截图补位的序列化、observe / drive / multi-step 交互，以及带证据等级的验证报告。
version: 0.1.1
type: tool
---

# UI 测试工作流 skill（verify-suite 通用 UI 测试能力）

## 这个 skill 解决什么

把一次"从零给某个 UI 建测试"的完整链路固化成可迁移的能力，让**任意 AI 接手任意 UI（浏览器 / 原生 App / 移动端）都能复现稳定的"理解 + 操作 + 验证"结果**：

> **OpenSpec（写清要测什么）→ SpecGate（定契约：什么算对）→ 常规实现与测试 → 调用 verify-suite 执行测试用例**

同时，它也支持**轻量模式**：用户**不需要**装 OpenSpec / SpecGate，直接把测试用例丢给 AI，AI 用同一套执行引擎（序列化 → 交互 → 验证报告）直接跑，并同样产出带证据等级的结果。

它把 `spec.md` / `contract.yaml`（完整链路）或用户自带用例（轻量模式）当作**交接协议**——下游"执行测试的 AI"吃的是同一套纪律（AX 树为主、证据等级、完整性断言、安全边界），只是**来源不同**。

## 何时使用

- 用户要"给某个 UI 建一套测试 / 抽取 / 驱动流程"
- 用户提到 OpenSpec / SpecGate / 验收契约 / UI 自动化测试
- 用户把本仓库当作"测试执行引擎"来调用
- **用户直接把测试用例丢给你**（自然语言列表 / 表格 / 截图描述），并说"帮我跑一下""按这个测"——此时走轻量模式，**不要求用户安装任何工具**

## 两条入口（先用 Step 0 确认走哪条）

```
入口 A · 完整链路（用户有 / 想要正式契约）
  OpenSpec 建需求 ──► SpecGate 定契约 ──► 常规实现与测试 ──► verify-suite 执行
     spec.md            contract.yaml            开发侧         序列化→交互→验证报告

入口 B · 轻量·自带用例（用户没有 / 不想装 OpenSpec/SpecGate）
  用户直接给用例 ──► AI 归一化为执行计划 ──► verify-suite 执行 ──► 带证据等级的报告
  （任意形式）        （可选落一份 cases.md）    （同一套执行引擎）
```

**入口 B 不要求用户安装任何工具，也不需要学 `contract.yaml` 格式**；AI 直接吃自然语言用例并跑。若用户后续想要"可机器校验的契约"，再升级到入口 A 即可（`specgate bridge` 还能把入口 B 整理的用例反过来生成契约草稿）。

## 执行步骤（人 / AI 分工）

### 第 0 步：前置确认（关键，别假设工具已装、先确认走哪条入口）

**不要假设用户本机已经装好 OpenSpec / SpecGate，也不要假设用户一定要走完整链路。** 先确认两件事：

1. **走哪条入口**：问清用户是「要我用 OpenSpec + SpecGate 建正式契约」（入口 A），还是「我直接给你用例你帮我跑」（入口 B）。用户没说清楚就问一句，别擅自替他选。
2. **工具是否可用**（仅入口 A 需要）：
   - OpenSpec：检查 `openspec` 命令 / Agent skill 是否可用；没有就引导 `npm i -g openspec` 或用 Agent skill。
   - SpecGate：检查 `specgate` CLI 是否可用（`node <specgate>/src/cli.js lint <契约>`）；没有就引导 clone [supernisy/specgate](https://github.com/supernisy/specgate) 或走 Agent skill。
   - 拿不到工具时，入口 A 仍可**手动按模板**写 `spec.md` / `contract.yaml`（见 `docs/ui-testing/templates/`）。

3. **执行环境是否就绪**（入口 A / 入口 B **都需要**）：verify-suite 的浏览器执行引擎基于 **Playwright**，目标机器必须装有 `playwright` 及其浏览器二进制（约 150MB）。执行层**直接调用 Playwright 官方库（commodity），不自研驱动封装**；我们的差异化在「契约 / 证据 / 断言」验证层，不在驱动。
   - 先确认是否可用：检查 `npx playwright --version` 或 `node -e "require('playwright')"` 是否通过；浏览器二进制是否就绪（`npx playwright install --dry-run` 或等价探测）。
   - **若未安装，先引导用户安装，不要硬跑**：
     - 仓库内：`cd adapters/web-cdp && npm i`（含 `playwright` 依赖）→ `npx playwright install`（下载浏览器二进制）。
     - 用户本地无 Node：给出最简指令，或让用户在自己环境按上面装好后再把目标交给我们。
   - 离线 / 无外网环境：需提前缓存浏览器二进制，否则执行会失败——这种场景先和用户确认能否提供可访问的镜像或已装环境。
   - 原生 App 场景走 `adapters/ax-native/`，不走 Playwright，无需上述步骤。

> 详细确认与获取方式见 [`docs/ui-testing/WORKFLOW.md` §0.5](../../docs/ui-testing/WORKFLOW.md)。

### 第 1–2 步：入口 A · 完整链路（OpenSpec + SpecGate）

**仅当用户走入口 A 时执行这两步；入口 B 跳到第 3 步。**

**第 1 步：OpenSpec 建需求**
写清"想从某 UI 拿到什么 / 验证什么"。用 capability + Requirement + Scenario（Given/When/Then）结构。
- 模板：[`docs/ui-testing/templates/openspec-spec.md`](../../docs/ui-testing/templates/openspec-spec.md)
- 示例：[`openspec/specs/general-ui-testing/spec.md`](../../openspec/specs/general-ui-testing/spec.md)

**第 2 步：SpecGate 定契约 + lint**
把需求翻译成可验证的 given/when/then，定义"什么算对"，并带证据等级（ax-tree=high / screenshot=medium）+ 完整性断言。
- 每条 `accept` 需 `id / given / when / then / verify`；`verify` 取自 9 种之一。
- `out_of_scope[]` 必须非空；`invariants` 必须是变动侧描述。
- 写完务必 `lint` 过关（退出码 0）再继续。
- 模板：[`docs/ui-testing/templates/specgate-contract.md`](../../docs/ui-testing/templates/specgate-contract.md)
- 示例（已 lint 过关）：[`acceptance/ui-testing/contract.yaml`](../../acceptance/ui-testing/contract.yaml)
- 桥接：`specgate bridge <spec.md> <契约.yaml>` 可把 spec 确定性生成契约草稿，再 `lint` 补 invariants。

### 第 3 步：入口 B · 轻量模式（用户直接给用例，无 OpenSpec/SpecGate）

**当用户走入口 B 时，从第 1–2 步直接跳到这里。** 这条路径**不要求用户安装任何工具，也不需要 `contract.yaml`**。

**3.1 收用例（任意形式都行）**
用户可以用任何形式给：自然语言列表、Markdown 表格、甚至"截图里画的测试点"。常见给法举例：
> "帮我测一下 AcmeHR 的候选人沟通页：① 打开页面，看标题是不是'候选人沟通'；② 点开第一条会话，抽取发件人/时间/正文；③ 给'已发面试邀请'的会话打标签，然后验证标签在不在。"

AI 要从中读出三样东西：**被测目标**（URL/窗口/进程）、**每条用例的操作（given/when）**、**每条用例的期望（then）**。

**3.2 归一化（内部步骤，用户无需参与）**
AI 把用例整理成一份内部**执行计划**（每条用例一个 `given / when / then`）。为了可追溯，建议顺手落一份 `cases.md` 到工作区——但**不是必须**，也不需要 contract.yaml 格式、不需要 lint。
- 用例里已自带"目标 + 期望" → 直接进执行；
- 只有模糊意图（如"测一下登录"）→ AI 必须**先按第 4 步硬规则跟用户确认目标与期望**，不要把模糊意图当用例硬跑。

**3.3 直接调 verify-suite 执行引擎**
拿到 `执行计划 + 目标 + 适配器选择` 后，走和第 4 步**完全相同**的执行纪律（盘点→选型→序列化→交互→报告）。**入口 B 与入口 A 在执行层完全一致，只是"用例来源"不同。**

### 第 4 步：调用 verify-suite 执行测试（本 skill 的主场，入口 A/B 共用）

当执行 AI 拿到 **契约 / 执行计划** + **目标** + **适配器选择** 后：

1. **读输入**：入口 A 读 `contract.yaml` 的 `accept[]`；入口 B 读归一化的 `执行计划` 每条 `given/when/then`。
2. **选型**：浏览器 → `adapters/web-cdp/`；原生 App → `adapters/ax-native/`。
3. **确认目标（硬规则）**：目标必须是"可被自动化访问"的 URL / 窗口 / 进程。**若目标未提供，执行 AI 必须停下向用户澄清，绝不用占位 / 猜测目标继续。**（入口 B 里用户常忘记给目标，尤其要主动问。）
4. **盘点**：先查是否已有现成导出物 / 更便宜路径（如剪贴板），避免重做。
5. **序列化**：AX 树为主（只序列化需求字段），截图只在 AX 盲区补位并标 `medium` 置信；枚举快、富化只做盲区；采集门为超集，禁止静默丢行；做完整性断言。
6. **交互**：`observe`（抽取+断言）/ `drive`（点击输入导航→重序列化→断言）/ `multi-step`。人审边界内的动作（登录/支付/删除/外发）一律停下交人。
7. **出报告**：每条结论带 `source` + `confidence`，对照**输入（契约或执行计划）**逐条给 pass/fail + 证据。

> 执行细节见 [`docs/ui-testing/AGENT-HANDOFF.md`](../../docs/ui-testing/AGENT-HANDOFF.md)（给开发 AI 的极详细交接）。

### 第 5 步：输出带证据等级的报告

汇总：每条用例 / accept 的达成情况、证据档位、置信度、未达成项的定位与建议。空结果 = 执行错误（非"无差异"）。
- 入口 A：对照 `contract.yaml` 逐条给结论。
- 入口 B：对照归一化的 `执行计划` / `cases.md` 逐条给结论；若用户想要正式契约，可用 `specgate bridge` 把 `cases.md` 反过来生成 `contract.yaml` 草稿，升级到入口 A。

## 关键规则（不可妥协）

- **不假设工具已装 / 不假设走哪条入口**：先 Step 0 确认入口 A 还是 B、OpenSpec/SpecGate 是否可用；入口 B 完全不需要它们。
- **目标缺失必须问人**：被测目标（URL/窗口）未提供 → 停下澄清，禁止占位/猜测。入口 B 用户常只给"用例"忘记给"目标"，更要主动问。
- **AX 树为主 + 截图补位**：AX 拿不到的字段才截图，标 `medium`。（入口 A/B 同）
- **枚举 / 富化分离**：先滚完枚举（只读 AX、不截图），富化遍只做盲区。（入口 A/B 同）
- **超集采集门**：类名匹配 OR 名称含日期时间，绝不静默丢行；被过滤节点进账本。（入口 A/B 同）
- **完整性断言**：去重计数、首尾时间戳、与已知总数比对；空/缺 = 执行错误。（入口 A/B 同）
- **安全边界（业界标准）**：人审边界（登录/认证/财务/外发/删除）一律停下交人；只自动化可逆且可观测的中间段；改前备份；显式验证才算完成（fail-loudly）。（入口 A/B 同）

## 文档地图（深入看这些）

| 文件 | 作用 | 给谁 |
|---|---|---|
| [`docs/ui-testing/WORKFLOW.md`](../../docs/ui-testing/WORKFLOW.md) | 整体开发流程：OpenSpec→SpecGate→实现→执行（含 §0.5 工具获取） | 人 + AI |
| [`docs/ui-testing/QUICKSTART.md`](../../docs/ui-testing/QUICKSTART.md) | 极简上手（做了什么 / 影响 / 极简 Demo / 没装工具怎么用） | 人 |
| [`docs/ui-testing/methodology.md`](../../docs/ui-testing/methodology.md) | 方法论总纲（五步链路 + 陷阱清单） | 人 + AI |
| [`docs/ui-testing/AGENT-HANDOFF.md`](../../docs/ui-testing/AGENT-HANDOFF.md) | 给开发 AI 的极详细交接（接口契约 / 契约规范 / 轻量模式 / 已验证事实） | AI |
| [`docs/ui-testing/templates/`](../../docs/ui-testing/templates/) | OpenSpec spec / specgate 契约 / 序列化 schema / 交互计划 四套模板 | 人 + AI |
| [`adapters/web-cdp/`](../../adapters/web-cdp/)、[`adapters/ax-native/`](../../adapters/ax-native/) | 适配器骨架（浏览器主 / 原生 App 扩展） | AI |
| [`examples/general-ui/`](../../examples/general-ui/) | 虚构 AcmeHR Web 端到端示例（含 multi-step） | 人 + AI |
| [`openspec/specs/general-ui-testing/spec.md`](../../openspec/specs/general-ui-testing/spec.md) | 示例 spec | 人 + AI |
| [`acceptance/ui-testing/contract.yaml`](../../acceptance/ui-testing/contract.yaml) | 示例契约（已 lint 过关） | 人 + AI |

## 一句话定位

本 skill 是 verify-suite 的**第二能力**：第一能力是前端还原度判定（看 `../SKILL.md`），本能力是把"理解 UI + 操作 UI + 验证 UI"做成通用、可迁移、可溯源的测试执行引擎——**既接正式契约（入口 A），也接你随手丢来的用例（入口 B）。**
