# Tasks: adopt-industry-drivers

## 1. 产出《不可替代性分析报告》+ 时序图
- [x] 基于战略分析，成文区分「可替（现成轮子）/ 不可替（护城河层）」
- [x] 用时序图表示当前链路中哪些环节可替换为现成轮子、哪些必须自留
- [x] 交付物随本 change 评审

## 2. 选定执行引擎接入方案
- [x] 评估 Playwright MCP（优先）与 Stagehand，确认接入方式
- [x] 记录选型结论于 design.md

## 3. 重构 web-cdp 移除自研 driver
- [x] 删除 `adapters/web-cdp/playwright-driver.mjs` 自研实现
- [x] 接入 Playwright MCP / Stagehand 提供驱动能力
- [x] 保留 AX 采集与证据等级逻辑

## 4. 更新脚本
- [x] 改造 `scripts/ax-collect-pw.mjs`：复用现成引擎 AX 采集，移除自研驱动

## 5. 回归校验
- [x] 用 specgate 契约 P1–P9 跑入口 A / B
- [x] 确认能力不变：auto-wait / strict / AX 主源 / web-first 断言 / Trace

## 6. 文档同步
- [x] 更新 SKILL.md 与 QUICKSTART / AGENT-HANDOFF：执行层已换现成轮子，护城河层不变
