# Design: 执行层改用业界现成轮子

## 1. 选型对比（执行引擎 commodity 层）

| 维度 | 自研 playwright-driver | Playwright MCP | Stagehand |
|---|---|---|---|
| 定位 | 自研执行引擎 | 微软官方协议桥（browser→agent） | Browserbase 的 AX 树 + LLM 确定性 action 框架 |
| auto-wait / strict / web-first | 已实现 | 原生具备 | 原生具备 + observe 缓存 |
| 供应商锁定 | 无（但自担维护） | 无（开源） | 可选 Browserbase 后端 |
| 接入成本 | 已投入 | 低（npm + 本地） | 中（TS 栈更顺） |
| 与我们护城河关系 | 重叠（重造） | 纯手脚，不碰验证层 | 手脚 + 部分智能，验证层仍在我们 |

**结论**：底层驱动用 **Playwright（官方库 / Playwright MCP 皆可，均为 commodity）**；参考实现直接调用 Playwright 官方库，Playwright MCP 作为可插拔升级形态（不改动验证层）。若后续需要「自然语言→确定性 action + 缓存自愈」，再叠 Stagehand。两者都不替代我们的 specgate 验证层。

## 2. 剔除清单 vs 保留清单

| 类别 | 内容 | 处置 |
|---|---|---|
| 剔除（可替） | `playwright-driver.mjs` 的 locate/drive/assert/trace 自研实现 | 删除，改用 Playwright MCP |
| 剔除（可替） | `ax-collect-pw.mjs` 的自研驱动外壳 | 改为调用现成引擎 AX 采集 |
| 剔除（可替） | playwright 作为「自研依赖」 | 降为「接入依赖」 |
| 保留（不可替） | specgate 契约 / 证据等级 / 完整性断言 / 安全边界 | 不动，继续自研深化 |
| 保留（不可替） | AX 树感知主源 | 不动（我们的感知层） |
| 保留（不可替） | 双入口 A（契约）/ B（轻量） | 不动 |

## 3. 接入架构（分层）

```
用户 / 契约 → specgate（护城河: 契约 + 证据 + 断言 + 安全边界）
                ↓
         web-cdp 适配器（我们的: AX 采集 + 证据等级 + 完整性断言）
                ↓
      执行引擎（commodity: Playwright MCP / Stagehand）  ← 现成轮子
                ↓
             Chromium
```

现成轮子只做「手脚」（驱动 / 等待 / 断言执行），「大脑」（判什么对、凭什么信）仍在 specgate。

## 4. 风险与缓解
- 外部引擎版本漂移 → 锁定版本 + 契约回归（P1–P9）卡门禁。
- 引擎能力不足 → 仅在验证层自研，执行层不做深定制。
