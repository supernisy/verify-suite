---
name: ui-testing-workflow
description: 把"可视化 → 序列化 → UI 交互"链路封装成可复用 skill：从 OpenSpec 定义需求 → SpecGate 定验收契约 → 常规实现与测试 → 调用 verify-suite 执行测试用例。当用户的诉求是"为某个 UI（浏览器 / 原生 App）建立一套可复现的测试 / 抽取 / 驱动流程"，或"按 OpenSpec + SpecGate 的契约去跑 UI 测试"时使用。涵盖需求澄清、契约 lint、AX 树为主截图补位的序列化、observe / drive / multi-step 交互，以及带证据等级的验证报告。
version: 0.1.0
type: tool
---

# UI 测试工作流 skill（verify-suite 通用 UI 测试能力）

## 这个 skill 解决什么

把一次"从零给某个 UI 建测试"的完整链路固化成可迁移的能力，让**任意 AI 接手任意 UI（浏览器 / 原生 App / 移动端）都能复现稳定的"理解 + 操作 + 验证"结果**：

> **OpenSpec（写清要测什么）→ SpecGate（定契约：什么算对）→ 常规实现与测试 → 调用 verify-suite 执行测试用例**

它把 `spec.md`（需求）与 `contract.yaml`（验收契约）当作**人和多个 AI 之间的交接协议文件**——下游"生成测试用例的 AI"和"执行测试的 AI"吃的是这份契约，而不是一段模糊的 prompt。

## 何时使用

- 用户要"给某个 UI 建一套测试 / 抽取 / 驱动流程"
- 用户提到 OpenSpec / SpecGate / 验收契约 / UI 自动化测试
- 用户要"抽取界面信息""自动驱动界面""验证界面状态是否达成"
- 用户把本仓库当作"测试执行引擎"来调用

## 链路总览

```
OpenSpec 建需求 ──► SpecGate 定契约 ──► 常规实现与测试 ──► verify-suite 执行测试用例
   spec.md            contract.yaml            开发侧             序列化 → 交互 → 验证报告
```

## 执行步骤（人 / AI 分工）

### 第 0 步：前置确认（关键，别假设工具已装）

**不要假设用户本机已经装好 OpenSpec / SpecGate。** 先确认：

- OpenSpec：检查 `openspec` 命令 / Agent skill 是否可用；没有就引导用户 `npm i -g openspec` 或用 Agent skill。
- SpecGate：检查 `specgate` CLI 是否可用（`node <specgate>/src/cli.js lint <契约>`）；没有就引导 clone [supernisy/specgate](https://github.com/supernisy/specgate) 或走 Agent skill。
- 拿不到工具时，仍可**手动按模板**写 `spec.md` / `contract.yaml`（见 `docs/ui-testing/templates/`）。

> 详细确认与获取方式见 [`docs/ui-testing/WORKFLOW.md` §0.5](../../docs/ui-testing/WORKFLOW.md)。

### 第 1 步：OpenSpec 建需求

写清"想从某 UI 拿到什么 / 验证什么"。用 capability + Requirement + Scenario（Given/When/Then）结构。

- 模板：[`docs/ui-testing/templates/openspec-spec.md`](../../docs/ui-testing/templates/openspec-spec.md)
- 示例：[`openspec/specs/general-ui-testing/spec.md`](../../openspec/specs/general-ui-testing/spec.md)

### 第 2 步：SpecGate 定契约 + lint

把需求翻译成可验证的 given/when/then，**定义"什么算对"**，并带证据等级（ax-tree=high / screenshot=medium）+ 完整性断言。

- 每条 `accept` 需 `id / given / when / then / verify`；`verify` 取自 9 种之一（`type / unit / contract-test / geo / ax / unit-visual / trace / state-matrix / manual`）。
- `out_of_scope[]` 必须非空。
- `invariants` 必须是**变动侧**描述（用变动词 + 关系词），避免被判恒真废话。
- 写完务必 `lint` 过关（退出码 0）再继续。
- 模板：[`docs/ui-testing/templates/specgate-contract.md`](../../docs/ui-testing/templates/specgate-contract.md)
- 示例（已 lint 过关）：[`acceptance/ui-testing/contract.yaml`](../../acceptance/ui-testing/contract.yaml)
- 桥接：`specgate bridge <spec.md> <契约.yaml>` 可把 spec 确定性生成契约草稿，再 `lint` 补 invariants。

### 第 3 步：常规实现与测试（用户 / 开发侧）

契约里属于"实现侧"的条目，由开发按 `contract.yaml` 的 `accept` 去写代码、跑单测。这一步不在本 skill 范围内，但**契约就是这步与第 4 步的共同判据**。

### 第 4 步：调用 verify-suite 执行测试（本 skill 的主场）

当执行 AI 拿到 `contract.yaml` + **目标** + **适配器选择**后：

1. **读契约**：提取 `accept[]` 的 id/given/when/then/verify 与 `out_of_scope[]`。
2. **选型**：浏览器 → `adapters/web-cdp/`；原生 App → `adapters/ax-native/`。
3. **确认目标（硬规则）**：目标必须是"可被自动化访问"的 URL / 窗口 / 进程。**若目标未提供，执行 AI 必须停下向用户澄清，绝不用占位 / 猜测目标继续。**
4. **盘点**：先查是否已有现成导出物 / 更便宜路径（如剪贴板），避免重做。
5. **序列化**：AX 树为主（只序列化需求字段），截图只在 AX 盲区补位并标 `medium` 置信；枚举快、富化只做盲区；采集门为超集，禁止静默丢行；做完整性断言。
6. **交互**：`observe`（抽取+断言）/ `drive`（点击输入导航→重序列化→断言）/ `multi-step`（抽取→驱动→再校验编排）。人审边界内的动作（登录/支付/删除/外发）一律停下交人。
7. **出报告**：每条结论带 `source` + `confidence`，对照契约逐条给 pass/fail + 证据。

> 执行细节见 [`docs/ui-testing/AGENT-HANDOFF.md`](../../docs/ui-testing/AGENT-HANDOFF.md)（给开发 AI 的极详细交接）。

### 第 5 步：输出带证据等级的报告

汇总：每条 `accept` 的达成情况、证据档位、置信度、未达成项的定位与建议。空结果 = 执行错误（非"无差异"）。

## 关键规则（不可妥协）

- **不假设工具已装**：OpenSpec / SpecGate 可能没装，先确认再引导获取。
- **目标缺失必须问人**：被测目标（URL/窗口）未提供 → 停下澄清，禁止占位/猜测。
- **AX 树为主 + 截图补位**：AX 拿不到的字段才截图，标 `medium`。
- **枚举 / 富化分离**：先滚完枚举（只读 AX、不截图），富化遍只做盲区。
- **超集采集门**：类名匹配 **OR** 名称含日期时间，绝不静默丢行；被过滤节点进账本。
- **完整性断言**：去重计数、首尾时间戳、与已知总数比对；空/缺 = 执行错误。
- **安全边界（业界标准）**：人审边界（登录/认证/财务/外发/删除）一律停下交人；只自动化可逆且可观测的中间段；改前备份；显式验证才算完成（fail-loudly）。

## 文档地图（深入看这些）

| 文件 | 作用 | 给谁 |
|---|---|---|
| [`docs/ui-testing/WORKFLOW.md`](../../docs/ui-testing/WORKFLOW.md) | 整体开发流程：OpenSpec→SpecGate→实现→执行 | 人 + AI |
| [`docs/ui-testing/QUICKSTART.md`](../../docs/ui-testing/QUICKSTART.md) | 极简上手（做了什么 / 影响 / 极简 Demo） | 人 |
| [`docs/ui-testing/methodology.md`](../../docs/ui-testing/methodology.md) | 方法论总纲（五步链路 + 陷阱清单） | 人 + AI |
| [`docs/ui-testing/AGENT-HANDOFF.md`](../../docs/ui-testing/AGENT-HANDOFF.md) | 给开发 AI 的极详细交接（接口契约 / 契约规范 / 已验证事实） | AI |
| [`docs/ui-testing/templates/`](../../docs/ui-testing/templates/) | OpenSpec spec / specgate 契约 / 序列化 schema / 交互计划 四套模板 | 人 + AI |
| [`adapters/web-cdp/`](../../adapters/web-cdp/)、[`adapters/ax-native/`](../../adapters/ax-native/) | 适配器骨架（浏览器主 / 原生 App 扩展） | AI |
| [`examples/general-ui/`](../../examples/general-ui/) | 虚构 AcmeHR Web 端到端示例（含 multi-step） | 人 + AI |
| [`openspec/specs/general-ui-testing/spec.md`](../../openspec/specs/general-ui-testing/spec.md) | 示例 spec | 人 + AI |
| [`acceptance/ui-testing/contract.yaml`](../../acceptance/ui-testing/contract.yaml) | 示例契约（已 lint 过关） | 人 + AI |

## 一句话定位

本 skill 是 verify-suite 的**第二能力**：第一能力是前端还原度判定（看 `../SKILL.md`），本能力是把"理解 UI + 操作 UI + 验证 UI"做成通用、可迁移、可溯源的测试执行引擎。
