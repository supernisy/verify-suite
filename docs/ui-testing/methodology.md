# 通用 UI 测试方法论（verify-suite 扩展模块）

> **目标**：把"大模型可视化 → 序列化 → UI 交互"链路提炼成**通用、可迁移**的方法论与轻量骨架，让任意 AI 套任意 UI（原生桌面 App / 浏览器 / 移动端）都能复现稳定的"理解 + 操作 + 验证"结果。
>
> 本模块是 verify-suite 的**第二能力**：既有的"前端还原度判定"（Web / CDP）保持不变，本模块在其分层架构上新增"通用 UI 测试"的驱动层适配器与判定层契约。判定权外置、语义指纹、降级/容差、specgate 门禁等既有资产全部复用。

---

## 0. 设计灵魂（两条不可妥协）

1. **需求驱动**：只做需求要的，只在 AX 盲区降级。需求没要的字段不序列化；需求说"只取文字"就不截图。
2. **确定性 + 可溯源**：无障碍树（AX）为 ground truth，LLM 只做解释 / 富化；每个输出字段都带**来源与置信度**（`ax-tree=high` / `screenshot=medium`），可被第三方（含另一个 AI）复核，而不是黑盒产出。

---

## 1. 链路总览（UI 无关骨架）

```
盘点 → 选型 → OpenSpec 锁需求 → spec gate 定契约
   → 序列化(枚举快 + 富化只盲区, 带降级)
   → observe / drive 交互
   → 对照契约出证据报告
```

只有"选型 / 序列化 / 交互"三段是**目标特定的 adapter**，其余全通用。这是可迁移性的关键。

---

## 2. 各阶段

### Phase 0 — 盘点与选型（治本，省掉重做和错配）

- **0.1 动手前先盘点**：查工作区现有导出物；查更便宜路径（如剪贴板 `Ctrl+C` ≈ 秒级、零滚动）。避免把已完成的事重做一遍。
- **0.2 工具-目标-任务 三维决策矩阵**：确定性选型，**禁止试错**。

  | 优先级 | 目标类型 | 首选工具 | 状态 |
  |---|---|---|---|
  | **① 主适配器** | **Web / 浏览器** | **CDP / Accessibility 语义树（AX）** | **verify-suite 立身之本（scripts/ax-collect.mjs + adapters/web-cdp/）** |
  | ② 扩展适配器 | 原生桌面 App（Win UIA / macOS AX） | 原生无障碍树（AX） | `adapters/ax-native/` |
  | ③ 同族扩展 | 移动端 | 对应无障碍桥（Accessibility Inspector / uiautomator） | 同属 AX 家族，待扩展 |
  | ④ 最后手段 | 纯视觉 / 画布 / 自定义控件 | 截图 + 模型 | 标 `uncertain`，仅 AX 盲区用 |
  | — | 全量结构化抽取 | **禁用** Compute Use / AST | 非确定性、慢、字段不可靠 |

- **0.3 最便宜够用优先**：剪贴板 > AX 枚举 > 截图 / Compute Use。Compute Use 只用于"看一眼判断"，绝不用于"全量结构化抽取"。

### Phase 1 — 需求锁定（OpenSpec + spec gate）

- **1.1 OpenSpec 写"做什么 + 不做什么"**：scope 显式，例如"只取文字、不截图"。
- **1.2 spec gate 把"对"定义成可验证断言 + 完整性校验**：条数、去重、首尾时间跨度、与已知总数比对。
- **1.3 范围外动作一律停下问**：直接治掉"需求说只取文字、却去加图像扫描"的蔓延。

### Phase 2 — 序列化（需求驱动 + 枚举/富化分离 + 无静默降级）

- **2.1 只序列化需求字段**：AX `Name` 已含文字就只抽它，**零截图**。截图永远是"降级补位"，不是默认动作。
- **2.2 两遍分离**（时间从"重滚 + 每步截图"砍下来的核心）：
  - **枚举遍**：滚完虚拟化列表、只读 AX、不截图、快且全；
  - **富化遍**：仅 AX 盲区字段（如头像）才截图，且带 `degradation` 日志。
  - 总耗时 ≈ 枚举遍；富化遍只与"盲区字段条数"成正比。
- **2.3 同步纪律收窄**：`settle`（等列表停稳）+ 像素对齐**只在富化遍需要锚定截图时**才做；枚举遍滚完即读 AX，不等不截。
- **2.4 采集门 = 超集**：类名匹配 **OR** 名称含日期时间，绝不用限制性白名单静默丢行；被丢弃节点进账本。
- **2.5 完整性断言**：去重计数、首尾时间戳、与已知总数比对；空 / 缺 = **执行错误**，不是"完成"。

### Phase 3 — UI 交互（observe / drive / multi-step）

- **3.1 observe**：按需求抽取 + 对照契约断言。
- **3.2 drive**：执行点击 / 输入 / 导航 → 重序列化 → 断言；每次动作由"下一次观测 / 状态 diff"验证，而非再截一张图让模型猜。
- **3.3 多步编排**：抽取 → 驱动 → 再校验，每步独立可验证；中间记每步状态与检查点。

### Phase 4 — 验证与可溯源（verify-suite 证据等级）

- **4.1 每个字段带来源与置信度**：`ax-tree=high` / `screenshot=medium`。
- **4.2 输出 provenance 报告**：让"理解需求交互"可被第三方复核。

### Phase 5 — 可迁移性工程

- **5.1 热路径确定性**：AX 抽取不走 LLM 启发式；LLM 只用于解释 / 富化，AX 为 ground truth。
- **5.2 skill 自带三件套**：决策矩阵 + 模板 + 陷阱清单。新人 AI 照走不踩坑，不依赖个人经验。
- **5.3 时间预算硬约束**：把"滚完即读不截""富化只做盲区"写成禁止项，从流程上杜绝重演。

---

## 3. 安全边界（业界标准）

1. **人审边界**：登录 / 认证、法律、财务支付、对外发消息、删除 —— 一律暂停交人。
2. **只自动化可逆且可观测的中间段**：不可逆副作用须确认后才做。
3. **改前备份**：改变状态 / 配置前先备份（REA 的"改配置前自动备份"）。
4. **显式验证才算完成**：每个动作由下一次观测 / 状态 diff 验证；N 次内不满足就 **fail-loudly**，不静默当成功（OSWorld 约 1/3 失败源于此）。
5. **每任务预算 + 检查点**：时间 / 截图 / 动作次数设上限，到限前存盘交人，不烧光额度。
6. **升级机制**：模糊或状态变更步骤升级到更强模型或人工。

---

## 4. 陷阱清单（实践 + 业界，须固化进 skill）

| 坑 | 根因 | 治本点 |
|---|---|---|
| 首图没滚到底 / 数据截断 | 无完整性校验 | 2.5 |
| 滚动未停稳 → rect / 截图错位 | settle 时机错 | 2.3 |
| 上扫帧覆盖下扫帧 → 错配 | 帧命名无方向区分 | 稳定签名 + 方向前缀 |
| 白名单静默丢行 | 限制性采集门 | 2.4 |
| 范围蔓延加多余动作 | scope 未锁死 | 1.1 / 1.3 |
| 错配工具（CDP / AST 对原生 App） | 无选型矩阵 | 0.2 |
| 重做已完成导出 | 没先盘点 | 0.1 |
| 以为成功实际未成 | 无 fail-loud | 安全边界 4 |

---

## 5. 业界经验借鉴

- **REA（Reverse Engineer Anything）**：三层架构（入口层 / 工具层 / 证据层）+ Agent 只决策、REA 只执行 + 自动生成契约文档 → 印证"分层 + 证据层 + 契约"设计。
- **AX vs 截图共识**（madhavrao / signalovernoise / slimsnap / ego）：semantics first, hybrid when needed, coordinates last。
- **Set-of-Marks grounding**：候选优先取自 AX 几何，模型选编号 → 治 rect 错位，比"固定框 + 亮度阈值"稳。
- **升级阶梯 + 按部署配置**：AX 失败自动升级视觉。
- **状态 diff 验证**替代截图推断（动画即可骗过像素比对）。
- **双模型路由**：便宜模型跑确定性步骤，强模型 / 人工处理模糊或状态变更。
- **自带评测集**（WebArena / OSWorld / Mind2Web 思路）：ship 固定 eval 集，用成功率 / 步数 / 耗时 / 成本证明可迁移。

---

## 6. 与 verify-suite 分层的关系

- **判定层（契约 / 指纹 / 证据 / 完整性）**：本模块直接复用，新增通用 UI 场景契约到 `acceptance/ui-testing/`。
- **驱动层（适配器）**：`adapters/web-cdp/`（**主适配器**，浏览器 CDP/AX） + `adapters/ax-native/`（**扩展适配器**，原生 App AX），受 `check-layering.mjs` 守门。
- **门禁**：复用 `.github/workflows/specgate-gate.yml`，覆盖 `acceptance/ui-testing/` 变更。

---

## 7. 交付物索引

| 文件 | 作用 |
|---|---|
| `docs/ui-testing/methodology.md` | 本文件，方法论总纲 |
| `docs/ui-testing/QUICKSTART.md` | 给人看的极简上手（做了什么/影响/极简 Demo） |
| `docs/ui-testing/WORKFLOW.md` | **整体开发流程**（OpenSpec 建需求 → SpecGate 定契约 → 实现测试 → 调 verify-suite 执行，人/AI 协作编排） |
| `docs/ui-testing/AGENT-HANDOFF.md` | 给开发 AI 的极详细交接报告（文件职责/接口契约/契约规范/陷阱/已验证事实/下一步） |
| `docs/ui-testing/templates/openspec-spec.md` | OpenSpec 需求模板 |
| `docs/ui-testing/templates/specgate-contract.md` | spec gate 验收契约模板 |
| `docs/ui-testing/templates/serialization-schema.md` | 序列化 schema 模板（AX + 截图锚点 + 降级日志） |
| `docs/ui-testing/templates/interaction-plan.md` | UI 交互计划模板（observe / drive / multi-step） |
| `adapters/web-cdp/ax-collect.py` | 通用 Web/AX 采集轻量骨架（**主适配器**；生产实现见 `scripts/ax-collect.mjs`） |
| `adapters/ax-native/ax-collect.py` | 通用原生 App AX 采集轻量骨架（**扩展适配器**） |
| `examples/general-ui/` | 虚构 Web 应用通用示例（AcmeHR Web，走 CDP/AX，不绑定微信） |
| `openspec/specs/general-ui-testing/spec.md` | OpenSpec capability spec |
| `acceptance/ui-testing/contract.yaml` | spec gate 验收契约 |
