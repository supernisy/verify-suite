# 通用 UI 测试示例 — 虚构 Web 应用「AcmeHR 招聘系统」

> **目的**：用一个**完全虚构**的 Web 应用演示本模块的五步链路，证明方法论可迁移到任意 UI，
> 不绑定任何真实产品（不引用微信或任何真实软件）。
> **本示例是当前优先场景：浏览器 / Web，走 CDP + Accessibility 语义树（AX）。**
>
> **任务**：从 AcmeHR Web 的"候选人沟通记录"页面抽取结构化消息，并自动标记"已发面试邀请"的候选人。
> **适配器**：`web-cdp`（浏览器 → CDP/AX），对应 `adapters/web-cdp/ax-collect.py`；生产实现用 `scripts/ax-collect.mjs`。

---

## 五步链路演示

### Phase 0 — 盘点与选型
- 盘点：确认无现成导出物；无更便宜路径（需读页面，剪贴板不适用）→ 走 AX。
- 选型矩阵：`目标类型=Web/浏览器` → `首选工具=CDP/AX`（结构化、确定性、零侵入）。
- 最便宜够用：本例需读页面，AX 枚举即可，不截图。

### Phase 1 — 需求锁定（OpenSpec + spec gate）
- OpenSpec 需求：见 `openspec/specs/general-ui-testing/spec.md`（Requirement: 枚举全部消息 + 标记已发邀请者）。
- spec gate 契约：见 `acceptance/ui-testing/contract.yaml`（含完整性断言：去重、已知总数 = 3、首尾时间跨度）。
- scope 显式：`✅ 抽取文字 + 标记`；`❌ 不截图、不发消息、不删数据`。

### Phase 2 — 序列化（枚举/富化分离）
- 枚举遍：整页 `Accessibility.getFullAXTree` → 过滤语义 role（`row`/`heading`/`article` 等）→ 得到 3 条消息节点。
- 富化遍：本例需求**不要求头像**，故跳过截图（演示"需求驱动，不做需求外的事"）。
- 采集门超集：语义 role 命中即收录；无被过滤节点。
- 产物：`acme-hr-serialized.json`（符合 `templates/serialization-schema.md`，`adapter=web-cdp`）。

### Phase 3 — UI 交互
- **observe**：抽取每条消息的 `说话人 / 时间 / 正文`，对照契约断言。
- **drive（轻量、可逆）**：对"已发面试邀请"的会话打标签。
  - 安全边界检查：打标签是可逆、可观测的中间动作，**不触及**人审边界（登录/支付/删除/发消息）→ 允许自动执行。
  - 验证：动作后重序列化 + 状态 diff 断言标签已写入。

### Phase 4 — 验证与可溯源
- 每个字段带来源（`ax-tree=high`）。
- 输出 provenance 报告：见 `acme-hr-extracted.md`。
- 完整性断言通过：去重 = 3、总数 = 3、时间跨度落在已知区间。

---

## 运行方式（示意）

```bash
# 1) 序列化（生产实现走 scripts/ax-collect.mjs；骨架走 adapters/web-cdp/ax-collect.py）
node scripts/ax-collect.mjs --url https://acme.example.com/hr/inbox --out examples/general-ui/acme-hr-serialized.json
# 或（非 Node 环境）python adapters/web-cdp/ax-collect.py --url <url> --expected 3 --out examples/general-ui/acme-hr-serialized.json

# 2) 抽取 + 标记（依据 templates/interaction-plan.md）
# observe -> drive(标记) -> observe 校验

# 3) 跑门禁（复用既有 specgate 工作流，已扩展 coverage 到 acceptance/**/*.yaml）
# .github/workflows/specgate-gate.yml 覆盖 acceptance/ui-testing/ 变更
```

## 文件清单
| 文件 | 作用 |
|---|---|
| `README.md` | 本文件，全流程演示 |
| `acme-hr-serialized.json` | 序列化产物（符合 schema，`adapter=web-cdp`） |
| `acme-hr-extracted.md` | 抽取 + 标记结果（provenance 报告） |
| `acme-hr-multistep.md` | **多步工作流端到端实例**：抽取→驱动→再校验编排 + 安全边界 + fail-loudly |
