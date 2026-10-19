# Proposal: 通用 UI 测试能力（OpenSpec 规范补录）

## Why

`general-ui-testing` 是 verify-suite 的核心能力，将"大模型可视化 → 序列化 → UI 交互"链路提炼成可迁移的 skill，让任意 AI 套任意 UI（浏览器 / 原生 App / 移动端）都能复现稳定的"理解 + 操作 + 验证"结果。其实现早已落地：

- 适配器 `adapters/web-cdp/`、`adapters/ax-native/`
- 示例 `examples/general-ui/`（浏览器场景）
- Skill `skills/ui-testing-workflow/`（入口 A 完整链路 + 入口 B 轻量用例）
- 验收契约 `acceptance/ui-testing/contract.yaml`（SpecGate 产物）

但此前该能力的定义是**手写**塞进 `openspec/specs/general-ui-testing/spec.md` 的，从未经过 OpenSpec 的 `change → archive` 流程——没有变更记录、不在版本化的演进链里，也不符合 spec-driven 的 delta 约定。现补录为正式 capability 基线，使其纳入 OpenSpec 管理。

## What Changes

- 新增 capability `general-ui-testing` 基线 spec（4 个 Requirement：序列化 / 抽取 / 驱动 / 多步编排，含对应场景）。
- 6 条不可妥协的设计原则并入 spec 的 `## Purpose`。
- 验收契约仍指向既有的 `acceptance/ui-testing/contract.yaml`（SpecGate 产物，不在本 change 范围）。

## Capabilities

- `general-ui-testing` (ADDED)

## Impact

- 仅新增 / 规范化 spec 定义；**不改动任何实现代码**（适配器、示例、Skill、契约均已存在）。
- 复用 `.github/workflows/specgate-gate.yml` 门禁（已覆盖 `acceptance/**/*.yaml`）。
- 与 `playwright-web-driver` change（待 archive）互补：本 change 定义能力，后者定义其执行引擎升级。
