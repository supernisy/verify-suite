# Design: 通用 UI 测试能力（OpenSpec 规范补录）

## 背景

本 capability 的实现（适配器、示例、Skill、契约）早已落地，本 change 仅做"补录"——把已有的能力定义纳入 OpenSpec 基线，使其进入版本化、可演进的 spec-driven 管理。

## 决策

- 既有的手写 `openspec/specs/general-ui-testing/spec.md` 在 archive 前已移出基线目录，由本 change 的 `## ADDED Requirements` delta 重新生成，确保基线完全由 OpenSpec 流程产出（无手写残留、无重复）。
- 场景格式由 `Given/When/Then` 收敛为 OpenSpec delta 约定的 `WHEN/THEN`（Given 语境并入 When）。
- 6 条设计原则并入 `## Purpose`；验收契约引用保持指向 `acceptance/ui-testing/contract.yaml`（SpecGate 产物，不重复定义）。

## 风险

- 无实现风险：本 change 不改动任何代码，仅为文档 / 规范层面的重组。
- 兼容性：与 `playwright-web-driver` change 互补——本 change 定义能力，后者在其执行引擎层做升级，两者互不冲突。
