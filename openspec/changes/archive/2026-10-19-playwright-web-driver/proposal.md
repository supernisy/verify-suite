## Why

`web-cdp` 适配器（生产实现 `scripts/ax-collect.mjs`，裸 CDP）自行实现元素等待、定位与断言，容易偶发时序失败（flaky）且错误信息不友好，缺乏可回放的证据载体。Playwright 已内置 auto-wait、web-first 可重试断言、strict mode、语义定位与 Trace 回放，且与本仓库「AX 树为 ground truth、确定性 + 可溯源」的哲学同源。现在引入可显著降低执行层的不稳定与不可观测性。

## What Changes

- 新增 `playwright-web-driver` 能力：把 `web-cdp` 适配器的底层浏览器自动化引擎从裸 CDP 换成 Playwright。
- 执行层获得：auto-wait（自动等元素可操作）、web-first 可重试断言、strict mode（多命中即报错不盲选）、语义定位（`getByRole`/`getByLabel`）、Trace 可回放证据。
- 感知层不变：序列化仍以 AX 树为主，截图仅用于 AX 盲区补位（标注 `confidence=medium`）。
- 入口 A（契约驱动）与入口 B（轻量用例）共用同一套引擎。
- **不改动** OpenSpec 需求定义、SpecGate 契约 `contract.yaml`、Skill 的整体流程，也不实现 MCP server / 自愈。

## Capabilities

### New Capabilities
- `playwright-web-driver`: Web 浏览器执行引擎的 Playwright 化——auto-wait、strict mode、web-first 断言、语义定位与 Trace 证据，作为 `web-cdp` 适配器的底层驱动。

### Modified Capabilities
（无。本次仅替换执行引擎的实现，不改 `general-ui-testing` 的能力需求，行为契约不变。）

## Impact

- 代码：`scripts/ax-collect.mjs`（生产实现）底层 CDP → Playwright 驱动；`adapters/web-cdp/ax-collect.py`（骨架）同步增加 Playwright 变体；`adapters/web-cdp/README.md` 补引擎说明与前置依赖。
- 依赖：新增 `playwright` npm 依赖（含浏览器二进制，约 150MB）。
- 文档：`skills/ui-testing-workflow/SKILL.md` 的 Step 0「前置确认」补「目标环境需安装 Playwright + 浏览器二进制，若未安装先引导用户安装」的提示（不改 Skill 整体流程）。
- 不涉及：`ax-native` 适配器、OpenSpec/SpecGate、契约文件、Skill 的五步链路。
