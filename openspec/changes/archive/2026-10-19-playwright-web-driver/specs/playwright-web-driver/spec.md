## Purpose

为 `web-cdp` 适配器提供基于 Playwright 的浏览器执行引擎，以 auto-wait、strict mode、web-first 可重试断言与 Trace 证据替代裸 CDP 的脆弱等待与断言，使 UI 测试执行更稳定、更可溯源，同时保持 AX 树为感知主源。

## ADDED Requirements

### Requirement: 浏览器执行引擎（Engine）
系统 SHALL 以具备 auto-wait 能力的浏览器自动化引擎驱动 `web-cdp` 适配器，替代裸 CDP 直接调用。

#### Scenario: auto-wait 消除手忙脚乱的等待
- **WHEN** 对一个异步渲染（如回车后 300ms 才出现）的元素执行 observe / drive
- **THEN** 引擎自动等待该元素达到可操作态（可见、启用、稳定）后再交互，不依赖手写 sleep，执行结果稳定可复现

#### Scenario: strict mode 不盲选
- **WHEN** 一个语义定位匹配到多个元素
- **THEN** 引擎立即报错并明确告知命中数量，不静默选择第一个

#### Scenario: 语义定位基于可访问性树
- **WHEN** 需按角色或名称定位控件
- **THEN** 使用基于 AX 树的语义定位（等价 `getByRole`/`getByLabel`），保持「AX 为 ground truth」

#### Scenario: web-first 可重试断言
- **WHEN** 对一个期望（如列表恰好 N 行）执行断言
- **THEN** 使用可重试断言，失败信息包含定位器、实际值与期望值；断言结果带来源与置信度，可被第三方复核

#### Scenario: Trace 可回放证据
- **WHEN** 一次执行结束
- **THEN** 产出可回放的执行轨迹（逐帧交互与 AX 快照），作为 fail-loudly 后的取证载体

### Requirement: 感知仍以 AX 为主（Perceive）
系统 SHALL 继续以 AX 树序列化可见状态，引擎仅承担驱动、等待与断言。

#### Scenario: 枚举遍仍读 AX 树
- **WHEN** 需要枚举页面可见消息
- **THEN** 仍从 AX 树取数，截图仅用于 AX 盲区（标注 `confidence=medium` 并写入 `degradation` 账本），不静默丢行

### Requirement: 双入口同一引擎（Entry Coverage）
系统 SHALL 让入口 A（契约驱动）与入口 B（轻量用例）共用同一套执行引擎。

#### Scenario: 入口 A 走契约
- **WHEN** 给定一个 `contract.yaml` 且执行启动
- **THEN** 引擎按契约条目驱动，每条 given/when/then 产出带证据等级的验证结果

#### Scenario: 入口 B 走轻量用例
- **WHEN** 给定用户直接提供的测试用例（无 contract.yaml）且执行启动
- **THEN** 归一化后用同一引擎驱动，执行纪律与入口 A 完全一致

### Requirement: 原生适配器不受影响（Native Isolation）
系统 SHALL 保持 `ax-native` 适配器本次行为不变。

#### Scenario: ax-native 行为不变
- **WHEN** 本次变更合并
- **THEN** 对原生 App 场景执行时，`ax-native` 适配器行为无任何变化
