# 通用 UI 测试能力 · 上手指南（给人看的）

> 这份文档给你一个**快速、直观**的理解：我们到底做了什么、它动了 verify-suite 哪些地方、以及一个一眼能看懂的极简 Demo。  
> 要给开发 AI 的极详细交接报告，请看同目录的 `AGENT-HANDOFF.md`。
>
> 📦 **前置提醒**：这份能力链的 ①② 步依赖 OpenSpec / SpecGate 两个外部工具，它们**不一定**已装在你的环境里。使用前怎么获取，见 `WORKFLOW.md` §0.5。



---

## 1. 这个需求实现了什么？

把一条 **"大模型理解 UI → 序列化 → 操作/验证"** 的通用测试链路，沉淀成 verify-suite 的**第二能力**：

- verify-suite 原本只有「前端还原度像素比对」这一条线（路线 A，Web/CDP）。
- 现在新增「通用 UI 测试」线（路线 B）：**让任意 AI 套任意 UI（浏览器优先，原生 App 其次）都能稳定地"理解 + 操作 + 验证"**，且结果可被第三方（含另一个 AI）复核。

核心思想只有两条，不可妥协：

1. **需求驱动**：只做需求要的；AX 树能拿到的字段就不截图，需求说"只取文字"就绝不截图。
2. **确定性 + 可溯源**：无障碍树（AX）是唯一真相源，模型只做解释/补位；每个输出字段都带 `来源 + 置信度`（`ax-tree=high` / `screenshot=medium`）。

整条链路（UI 无关部分完全通用，只有"选型/序列化/交互"是目标特定的适配器）：

```
盘点 → 选型 → OpenSpec 锁需求 → spec gate 定契约
   → 序列化（枚举快 + 富化只做盲区）
   → observe / drive 交互
   → 对照契约出证据报告
```

---

## 2. 它会影响 verify-suite 的哪些地方？

**新增（不影响既有逻辑）：**

| 路径                                          | 作用                                                     |
| ------------------------------------------- | ------------------------------------------------------ |
| `docs/ui-testing/`                          | 方法论 + 4 类模板 + 本指南 + AI 交接报告                            |
| `adapters/web-cdp/`                         | **主适配器** Web/CDP 采集骨架（生产实现复用 `scripts/ax-collect.mjs`） |
| `adapters/ax-native/`                       | **扩展适配器** 原生桌面 App 采集骨架                                |
| `examples/general-ui/`                      | 虚构 Web 应用「AcmeHR」端到端示例（不绑微信）                           |
| `openspec/specs/general-ui-testing/spec.md` | OpenSpec 能力 spec                                       |
| `acceptance/ui-testing/contract.yaml`       | spec gate 验收契约（已 `specgate lint` 过关）                   |

**改动既有文件（仅增量，不动旧逻辑）：**

- `.github/workflows/specgate-gate.yml`：门禁 glob 由 `acceptance/*.yaml` 扩为 `acceptance/*.yaml` + `acceptance/**/*.yaml`，让子目录契约也被门禁覆盖。
- `SKILL.md` / `README.md`：各加一节「通用 UI 测试能力」指向上面模块，**既有前端还原度说明一字未改**。

> ✅ 既有"前端还原度判定"链路（Web/CDP、语义指纹、specgate 门禁、AGENTS.md 规范）全部复用，本模块只是在它的分层架构上挂载了新的驱动层适配器与判定层契约。

---

## 3. 极简 Demo（一眼看懂）

**任务**：从虚构招聘网站 AcmeHR 的「候选人沟通记录」页面，抽取消息并自动标记"已发面试邀请"的人。

```
① 序列化：用 CDP 取整页无障碍树(AX) → 过滤语义 role(row/heading/article)
         → 得到 3 条消息，每条自带 说话人 / 时间 / 正文
         （AX 已含文字，零截图）

② 抽取 + 标记：
   - observe：读出每条"说话人 + 时间 + 正文"
   - drive（可逆动作）：对"已发面试邀请"的会话打标签
       · 安全边界检查：打标签不碰【登录/支付/删除/发消息】→ 允许自动执行
   - 验证：重序列化 + 状态 diff，断言标签已写入

③ 出报告：每条字段标注来源 ax-tree=high；完整性断言通过（去重=3、总数=3）
```

本地跑骨架看 schema（无需浏览器）：

```bash
python adapters/web-cdp/ax-collect.py --demo
# 打印一条符合 schema 的示例节点：
# { "sig":"row|候选人A · 2026-10-18 21:39", "role":"row",
#   "body":"候选人A", "time":"2026-10-18 21:39",
#   "source":"ax-tree", "confidence":"high" }
```

完整示例见 `examples/general-ui/README.md`（含多步工作流编排版 `acme-hr-multistep.md`）。

---

## 4. 想深入，从哪进？

| 你的角色           | 看哪个                                                                    |
| -------------- | ---------------------------------------------------------------------- |
| 想懂方法论全貌        | `docs/ui-testing/methodology.md`                                       |
| 要写新 UI 测试，照模板填 | `docs/ui-testing/templates/`（OpenSpec / spec gate / 序列化 schema / 交互计划） |
| 要接真实浏览器        | `scripts/ax-collect.mjs`（生产实现）或 `adapters/web-cdp/ax-collect.py`（骨架）   |
| 要接原生桌面 App     | `adapters/ax-native/ax-collect.py`                                     |
| 给开发 AI 派活      | `docs/ui-testing/AGENT-HANDOFF.md`                                     |
