## Purpose

通用 UI 测试能力：把"大模型可视化 → 序列化 → UI 交互"链路提炼成可迁移的 skill，让任意 AI 套任意 UI（浏览器 / 原生 App / 移动端）都能复现稳定的"理解 + 操作 + 验证"结果。本 spec 是场景无关的能力定义；具体示例见 `examples/general-ui/`（浏览器场景）。

设计原则（不可妥协）：
1. 需求驱动：只做需求要的，只在 AX 盲区降级。需求没要的字段不序列化；需求说"只取文字"就不截图。
2. 确定性 + 可溯源：AX 树为 ground truth，LLM 只解释 / 富化；每个输出字段带来源与置信度（`ax-tree=high` / `screenshot=medium`），可被第三方复核。
3. 枚举/富化分离：枚举遍只读 AX（快且全）；富化遍仅 AX 盲区字段截图，且记 `degradation`。
4. 超集采集门：语义 role 命中 OR 名称含日期时间即收录；被过滤节点进账本，绝不静默丢行。
5. 完整性断言：去重 + 已知总数比对；空 / 缺 = 执行错误，不是"完成"。
6. 安全边界：人审边界（登录 / 支付 / 删除 / 发消息）一律停下问；只自动化可逆且可观测的中间段；fail-loudly。

验收契约见 `acceptance/ui-testing/contract.yaml`；门禁复用 `.github/workflows/specgate-gate.yml`。

## ADDED Requirements

### Requirement: 序列化（Serialize）
系统 SHALL 把目标 UI 的可见状态序列化为结构化数据，且 SHALL 优先采用 AX 树为主、截图补位的感知策略。

#### Scenario: 枚举全部可见消息（浏览器）
- **WHEN** 一个 Web 页面含 N 条候选消息（AX 树可达），执行 `web-cdp` 适配器枚举遍（Accessibility.getFullAXTree + 语义 role 过滤）
- **THEN** 输出恰好 N 条去重消息，每条含 `body/time/source/confidence`，来源为 `ax-tree`、置信 `high`

#### Scenario: AX 盲区字段降级补位
- **WHEN** 某字段（如头像）不在 AX 树暴露且需求要求该字段
- **THEN** 走富化遍截图补位，标注 `confidence=medium` 并写入 `degradation` 账本，不静默丢弃

#### Scenario: 采集门超集，不静默丢行
- **WHEN** AX 树中存在非目标类名 / 非日期命名的节点，序列化执行采集门
- **THEN** 凡语义 role 命中或名称含日期时间者一律收录；其余节点类名记入账本，绝不静默忽略

### Requirement: 抽取与标记（Observe）
系统 SHALL 按需求从序列化结果抽取结构化字段，并 SHALL 对照契约断言完整性。

#### Scenario: 抽取说话人/时间/正文
- **WHEN** 序列化产物含 N 条消息，按需求抽取 `说话人/时间/正文`
- **THEN** 输出 N 行结构化记录，字段来源可溯源

#### Scenario: 完整性断言
- **WHEN** 已知目标总数 = N，抽取完成
- **THEN** 去重计数 = N、无缺失、时间跨度符合预期；否则报执行错误（非空结果当完成）

### Requirement: 驱动操作（Drive）
系统 SHALL 能按需求执行可逆、可观测的 UI 操作（点击 / 输入 / 打标签），且 SHALL 在操作后重新序列化验证。

#### Scenario: 可逆中间动作自动执行
- **WHEN** 需求为"标记已发邀请的会话"，系统对命中行打标签
- **THEN** 该动作可逆、可观测，未触人审边界 → 允许自动执行

#### Scenario: 操作后状态验证
- **WHEN** 执行了一次 drive 动作，动作结束
- **THEN** 通过"重新序列化 + 状态 diff"验证结果，而非再截一张图让模型猜

#### Scenario: 人审边界停下问
- **WHEN** 需求要求"发送消息 / 删除 / 支付"，系统识别到该动作属于人审边界
- **THEN** 暂停并交人工确认，不自动执行

### Requirement: 多步编排（Multi-step）
系统 SHALL 支持把"抽取 → 驱动 → 再校验"编排为可验证的流水线。

#### Scenario: 流水线每步独立可验证
- **WHEN** 一个多步 UI 任务，执行编排
- **THEN** 每步产出中间状态与检查点，任一步失败即 fail-loudly 而非静默继续
