# Proposal: 执行层改用业界现成轮子（adopt-industry-drivers）

## Why
基于护城河战略分析，我们得到三个一手结论：
1. **执行层高度拥挤且正被商品化**。Playwright MCP、Stagehand、Browser Use、Midscene、Skyvern 等已成熟覆盖「auto-wait / strict mode / 语义定位 / web-first 断言 / Trace」全部能力。我们自研的 `playwright-driver.mjs` 与它们是同质竞争，属重复造轮子。
2. **agent 操作不可靠，验证才是刚需**。Slack 200+ 次实测（2026-06）：agent 测试成本 $15–30/次、耗时 3–11 分钟、复杂流程失败率 ~48%；业界立下铁律「green result must come from a check you can explain」。我们 specgate 的「契约即 oracle + 证据等级 + 完整性断言 + 安全边界」正是这一被公认缺失、且不可省的层。
3. **时间维度上，操作层价值随模型增强而贬值，验证层反而增值（anti-fragile）**。继续往执行引擎投资源，等于在沙子上盖楼。

## What Changes
- **剔除（重造部分）**：移除自研 `adapters/web-cdp/playwright-driver.mjs`（locate/drive/assert/trace 自研实现）与 `scripts/ax-collect-pw.mjs` 中的自研驱动逻辑；`package.json` 中 playwright 由「自研依赖」降级为「接入依赖」。
- **改接（现成轮子）**：执行引擎底层改用 **Playwright MCP**（微软官方、本地、无供应商锁定、accessibility-tree-first）作为 commodity 驱动；如需「自然语言→确定性 action + 缓存 + 自愈」，叠加 **Stagehand**。
- **保留（护城河）**：specgate 契约层、证据等级、完整性断言、安全边界、AX 树感知主源、双入口（A 契约 / B 轻量）全部不变。
- **产出（本需求交付物）**：一份《不可替代性分析报告》+ 时序图，明确区分「可替（用现成轮子）/ 不可替（护城河层）」。

## Impact
- **收益**：执行层维护成本趋零；团队资源集中到不可被商品化吞没的验证 / 契约层。
- **风险**：引入外部执行引擎依赖，需评估版本 / 可用性；缓解＝保留 AX 采集与证据层在我们自己手里，外部轮子仅作「手脚」，不做「大脑」。
- **兼容性**：`ax-native` 原生适配器不受影响；入口 A / B 行为保持。
