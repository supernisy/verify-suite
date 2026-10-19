## Context

`web-cdp` 当前生产实现 `scripts/ax-collect.mjs` 用裸 CDP（`Accessibility.getFullAXTree` + `DOM.resolveNode`）做采集，交互与等待自行实现。本次只换「驱动 / 等待 / 断言 / 证据」这一层，采集仍走 AX 树（可经 Playwright 的 `page.accessibility.snapshot()` 或保留的 CDP 取树）。

## Goals / Non-Goals

**Goals:**
- 用 Playwright 替换裸 CDP 的驱动层，获得 auto-wait / strict / web-first / Trace。
- 入口 A、入口 B 共用同一引擎。
- 保持 AX 树为感知主源、契约 `contract.yaml` 为交接物。

**Non-Goals:**
- 不做 MCP server 封装（形态 B）。
- 不做 action 缓存 / 失败自愈（形态 C）。
- 不改 OpenSpec/SpecGate、不改 Skill 流程、不动 `ax-native`。

## Decisions

- **驱动层位置**：在 `adapters/web-cdp/` 引入 `playwright` 依赖，新增 `playwright-driver.mjs` 封装 `locate`（语义定位 + strict）、`drive`（auto-wait 交互）、`assert`（web-first 可重试）、`trace`（产出轨迹）；`scripts/ax-collect.mjs` 改为调用该驱动而非裸 CDP。采集（AX 取树）逻辑保留，仅把「等待 / 点击 / 输入 / 断言」迁移到 Playwright。
- **AX 取数来源**：优先 `page.accessibility.snapshot()`（同源 W3C accname）；若需像素级度量再回退 CDP `DOM.resolveNode`，避免重复实现。
- **前置依赖**：Playwright 需下载浏览器二进制（约 150MB）。在 `adapters/web-cdp/` 增加 `package.json` 与安装说明；Skill Step 0 前置确认补「若目标环境未安装 Playwright + 浏览器，先引导用户安装」。

## Risks / Trade-offs

- 引入浏览器二进制依赖，目标环境需可下载或已预装；离线环境需缓存二进制。
- 从裸 CDP 迁移需保证 AX 取数口径与现有指纹主键（`role|norm(name)`）一致，避免序列化产出变化破坏既有契约断言。
- 按最小原则，不实现 driver 接口抽象（原生扩展留待后续形态）。
