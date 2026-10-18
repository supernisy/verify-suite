# 浏览器专项 · 多步工作流端到端实例（AcmeHR Web）

> **场景**：虚构的 AcmeHR 招聘系统「候选人沟通记录」页。
> **适配器**：`web-cdp`（浏览器 → CDP + Accessibility 语义树）。
> **目标**：演示"抽取 → 驱动 → 再校验"的**多步编排**（multi-step），并显式处理安全边界与 fail-loudly。
> 本文件是 `examples/general-ui/README.md` 的**进阶版**——那里只跑通了 observe + 一次轻量 drive；这里把三步串成一条可验证的流水线。

---

## 0. 编排计划（照契约字段编排）

多步工作流不是"想到哪做到哪"，而是**先有契约、再按契约字段排步骤**。本例对照 `acceptance/ui-testing/contract.yaml` 编排：

| 步骤 | 模式 | 触发契约项 | 动作 | 检查点（Checkpoint） |
|---|---|---|---|---|
| S1 | observe | U1 / U3 | 枚举全部消息 + 抽取结构化字段 | 去重=N、总数=N、无静默丢行 |
| S2 | drive | U5 | 对"已发邀请"的会话打标签 `invited=true` | 动作可逆、未触人审边界 |
| S3 | drive | U5 / U6 | 点击"发送面试邀请"按钮（可逆中间动作） | 重序列化后该行出现"已发送"状态 |
| S4 | verify | U4 / U7 | 重序列化 + 状态 diff，断言 S2/S3 生效 | 各步独立可验证；失败 fail-loudly |
| S5 | 边界 | U6 | 检测到"外发消息"需求 → **停手交人** | 不自动执行、产出待人工确认清单 |

> 每一步都产出**中间状态 + 检查点**。任一步不满足，立即 `fail-loudly`（U7），不静默继续。

---

## S1 — observe：枚举 + 抽取

**动作**：整页 `Accessibility.getFullAXTree` → 按语义 role（`row`/`article`）过滤 → 抽取 `说话人/时间/正文`。

**序列化产物（节选，来源 `ax-tree=high`）**：

```json
{
  "adapter": "web-cdp",
  "messages": [
    {"sig":"r1","role":"row","name":"和三哥","time":"2026-10-18 21:39","body":"方便看下岗位介绍吗？","source":"ax-tree","confidence":"high"},
    {"sig":"r2","role":"row","name":"peì_í","time":"2026-10-18 21:42","body":"可以的，麻烦发我 JD 和薪酬范围。","source":"ax-tree","confidence":"high"},
    {"sig":"r3","role":"row","name":"和三哥","time":"2026-10-18 21:45","body":"已发面试邀请，请查收邮件确认时间。","source":"ax-tree","confidence":"high"}
  ]
}
```

**检查点 S1**（对照 U1/U3/U4）：去重 = 3、总数 = 3、采集门超集（无被过滤节点）→ ✅ 通过，进入 S2。

---

## S2 — drive：打标签（可逆中间动作）

**判定**（U5）：需求是"标记已发邀请的会话"，这是**可逆、可观测**的中间动作；**不触及**人审边界（登录/支付/删除/发消息）→ 允许自动执行。

**动作**：对 `body` 含「已发面试邀请」的行（`r3`）写入 `invited=true`。

**安全边界自检清单**：
- [x] 可逆？（打标签可撤销）→ 是
- [x] 可观测？（重序列化可见）→ 是
- [x] 触人审边界？→ 否（非登录/支付/删除/外发）

**检查点 S2**：通过 U5 三问 → 自动执行。

---

## S3 — drive：点击"发送面试邀请"按钮（同属可逆中间动作）

**动作**：在 `r2`（peì_í）行点击「发送面试邀请」按钮，触发系统向其发送邀约。

**安全边界自检**（U5/U6）：
- [x] 可逆？（该按钮对应草稿态邀约，HR 可在后台撤销）→ 是
- [x] 可观测？（行状态变为"已发送"）→ 是
- [ ] 触人审边界？→ **本例否**（按钮动作是站内可逆流程，非"外发短信/邮件到候选人"的不可逆等价动作；若需求明确为"外发"，则归 S5）

```json
// 动作前
{"sig":"r2","state":"未邀请"}
// 动作后（由下一步 verify 断言）
{"sig":"r2","state":"已发送"}
```

---

## S4 — verify：重序列化 + 状态 diff（U4 / U7）

**动作**：对页面**重新序列化**，与 S1 的快照做状态 diff，只比对目标行是否变化（U5 invariants：其他行不受影响）。

```text
S1 快照:  r1=未邀请  r2=未邀请  r3=未邀请
S4 快照:  r1=未邀请  r2=已发送   r3=已邀请
─────────────────────────────────────────
diff:     r2 +1(已发送)  r3 +1(已邀请)   其余行不变
```

**断言**：
| 契约项 | 期望 | 实测 | 结果 |
|---|---|---|---|
| U1 枚举 | 3 条 | 3 条 | ✅ |
| U4 完整性 | 去重=3、总数=3 | 3/3 | ✅ |
| U5 标记生效 | r3=已邀请 | ✅ | ✅ |
| U5 驱动生效 | r2=已发送 | ✅ | ✅ |
| U5 invariants | 其他行不变 | r1 不变 | ✅ |

> 验证用**状态 diff**而非"再截一张图让模型猜"（U5 设计原则），避免动画/重绘造成的误报。

---

## S5 — 边界：遇到"外发消息"需求 → 停手交人（U6）

假设需求追加："顺便给 peì_í **发一条确认短信**"。

**识别**（U6）：短信外发属于人审边界（不可逆、外部副作用）→ 系统**暂停并交人工确认**，不自动执行。

**产出待人工确认清单**：
```yaml
pending_human_review:
  - action: send_sms
    target: peì_í
    reason: 外部不可逆副作用，命中人审边界（U6）
    blocked: true
```

> 这一步**不写任何代码、不调任何接口**，只产出清单等人工拍板。这是 U6 的硬约束。

---

## S6 — fail-loudly 演示（U7）

假设 S4 重序列化后 `r2` 状态仍是"未邀请"（按钮点击因前端异常未生效）：

```text
断言: r2 应为「已发送」，实测「未邀请」→ 不匹配
重试: 第1次（重序列化）→ 仍不匹配
重试: 第2次（滚动置顶后重序列化）→ 仍不匹配
→ fail-loudly：终止流水线，上报「drive(S3) 未生效」，不静默当成功
```

**关键**：空结果 / 未达成 = **执行错误**，绝不当"完成"（U7 + 完整性断言 U4）。

---

## 最终 provenance 报告（节选）

```text
workflow: acme-hr-multistep
adapter: web-cdp
steps:    [S1 observe, S2 drive(标记), S3 drive(发送), S4 verify, S5 边界, S6 fail-loudly(未触发)]
evidence:
  messages:        3 条 (ax-tree / high)
  标记 invited:    r3 (ax-tree / high)
  驱动 已发送:      r2 (ax-tree / high, 经状态 diff 验证)
  人审拦截:         send_sms 已挂起待人工确认 (U6)
completeness:      去重=3 总数=3 ✅
result:            PASS（除被 U6 拦截项外全部达成）
```

---

## 运行方式（示意）

```bash
# 序列化（生产走 scripts/ax-collect.mjs；骨架走 adapters/web-cdp/ax-collect.py）
node scripts/ax-collect.mjs --url https://acme.example.com/hr/inbox \
     --expected 3 --out examples/general-ui/acme-hr-serialized.json

# 多步编排：observe → drive(标记) → drive(发送) → verify（按本文件 S1–S4 编排）
# 边界 S5 / 失败 S6 由契约 U6/U7 在运行时自动触发

# 门禁：复用 .github/workflows/specgate-gate.yml（已覆盖 acceptance/**/*.yaml）
```

## 文件清单
| 文件 | 作用 |
|---|---|
| `README.md` | 五步链路基础演示（observe + 一次轻量 drive） |
| `acme-hr-serialized.json` | 序列化产物（schema 合规，`adapter=web-cdp`） |
| `acme-hr-extracted.md` | 抽取 + 标记报告（provenance） |
| `acme-hr-multistep.md` | **本文件**：多步工作流端到端实例（抽取→驱动→再校验 + 安全边界 + fail-loudly） |
