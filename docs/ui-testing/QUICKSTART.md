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
- `skills/ui-testing-workflow/SKILL.md`：把整条链路封装成的可复用 skill（README 已链接到它）。
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

## 4. 没装 OpenSpec / SpecGate？没关系，直接把测试用例丢给我（轻量模式）

上面的链路（OpenSpec→SpecGate）是"正规范式"，**但不是必须的**。如果你本机没装这两个工具、也不想学 `contract.yaml` 那套格式，完全可以走**轻量模式**：

**你（人类）只需要做两件事：**
1. **给我一个目标**（要测的 URL / 窗口 / 进程）。⚠️ 这条不能省——目标没给，AI 会停下问你，不会自己瞎猜（Skill 的硬规则）。
2. **把测试用例用任何形式丢给我**：自然语言列表、表格、甚至截图里画的测试点都行。例如：
   > "帮我测一下 AcmeHR 的候选人沟通页（https://acmehr.example.com/messages）：① 打开页面，看标题是不是'候选人沟通'；② 点开第一条会话，抽出 发件人/时间/正文；③ 给'已发面试邀请'的会话打标签，再验证标签在不在。"

AI 会自己做三件事（你不用管）：**读用例 → 归一化成执行计划 → 直接调 verify-suite 执行引擎跑**（序列化→observe/drive→出带证据等级的报告）。全程**不依赖 OpenSpec / SpecGate**，也不用你写任何契约文件。

**两种模式怎么选：**
- 只是"帮我跑一下这一轮测试" → 轻量模式（入口 B），零门槛。
- 想让测试"可机器复跑、能被 CI 卡门禁、多人协作" → 走完整链路（入口 A），那时再装 OpenSpec/SpecGate，AI 还能把你这轮丢来的用例反过来生成正式契约草稿。

> 💡 即使走轻量模式，AI 执行的**纪律不变**：AX 树为主只补位截图、枚举/富化两遍分离、超集采集门不丢行、完整性断言、人审边界（登录/支付/删除/发消息）一律停下交人。

---

## 5. 想省事？用 Skill 让 AI 一键走完这条链路（给人类）

如果你不想自己照 `WORKFLOW.md` 一步步手动跑，我们已把整条链路**封装成一个 Skill**：[`skills/ui-testing-workflow/SKILL.md`](./skills/ui-testing-workflow/SKILL.md)。

**你（人类）只需要做两件事：**
1. 想清楚**要测哪个 UI**（浏览器页面 / 原生 App）、以及**大致想验证什么**（抽取什么信息、做哪些可逆操作）。
2. 把目标交给 AI：给它一个**可被自动化访问的目标**（URL / 窗口 / 进程）。**如果目标没给，AI 会停下问你，不会自己瞎猜**——这是 Skill 的硬规则。

**然后你只要说一句话**，例如：
> "用 ui-testing-workflow skill，给 AcmeHR 的候选人沟通页建一套测试：抽出发件人/时间/正文，并给'已发面试邀请'的会话打标签。"

AI 就会自动走完：**OpenSpec 锁需求 → SpecGate 定契约（含 lint）→ 常规实现与测试 → 调用 verify-suite 执行并出带证据等级的报告**，并且内置"工具可能没装先确认""目标缺失必问人"等防坑规则。

> 💡 这个 Skill 不是必须用的：你完全可以照 `WORKFLOW.md` 手动走。Skill 只是把那条链路固化下来，让任意 AI 接手都能复现同样的结果。

---

## 6. 想深入，从哪进？

| 你的角色           | 看哪个                                                                    |
| -------------- | ---------------------------------------------------------------------- |
| 想懂方法论全貌        | `docs/ui-testing/methodology.md`                                       |
| 要写新 UI 测试，照模板填 | `docs/ui-testing/templates/`（OpenSpec / spec gate / 序列化 schema / 交互计划） |
| 要接真实浏览器        | `scripts/ax-collect.mjs`（生产实现）或 `adapters/web-cdp/ax-collect.py`（骨架）   |
| 要接原生桌面 App     | `adapters/ax-native/ax-collect.py`                                     |
| 给开发 AI 派活      | `docs/ui-testing/AGENT-HANDOFF.md`                                     |
