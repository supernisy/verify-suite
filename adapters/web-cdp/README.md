# web-cdp 适配器（主适配器）

verify-suite 的**主适配器**：浏览器 / Web 场景走 CDP + Accessibility 语义树（AX）。

## 与既有能力的关系

- **生产实现 = `scripts/ax-collect.mjs`**（Node，零依赖 CDP）。它已完成：
  `Accessibility.getFullAXTree` → 过滤语义 role → `DOM.resolveNode` 采视觉度量
  → 指纹主键 `role|norm(accessible name)` → 同 key 多节点按 8px 网格量化 + 阅读顺序编号。
- **本目录的 `ax-collect.py` 是「可移植骨架」**：与 `adapters/ax-native/` 同构，
  演示枚举/富化分离、超集采集门、无静默降级、完整性断言的通用结构，
  方便非 Node 环境或需要 Python 接入时复用判定层。生产请用上面的 `.mjs`。

## 为什么浏览器是主适配器

- 浏览器天然有 AX 树（W3C accname 已算好名字），对页面**零侵入**；
- 截图补位只用于 AX 盲区：canvas / 自定义控件 / 纯视觉校验；
- 与 verify-suite 路线 B「语义指纹」同源，主键复用 `role|文案`。

## Playwright 引擎（可选替换 CDP）

`adapters/web-cdp/playwright-driver.mjs` 提供与裸 CDP **等价但更稳**的驱动层：
auto-wait（自动等元素可操作）、strict mode（多命中即报错不盲选）、语义定位
`getByRole`/`getByLabel`（基于 AX 树）、web-first 可重试断言、Trace 可回放证据。
AX 树仍是感知主源（`page.accessibility.snapshot()`），截图仅补 AX 盲区。

对应采集器 `scripts/ax-collect-pw.mjs` 与原 `scripts/ax-collect.mjs` **同算法、同指纹**
（`role|norm(name)`），仅把底层驱动从 CDP 换成 Playwright。

## 用法

```bash
# 生产（推荐，裸 CDP）
node scripts/ax-collect.mjs --url https://acme.example.com/hr --out acme-ax.json

# Playwright 引擎版（更稳：auto-wait / strict / 可回放 trace）
npm install playwright && npx playwright install chromium   # 一次性装引擎 + 浏览器
node scripts/ax-collect-pw.mjs --url https://acme.example.com/hr --out acme-ax-pw.json

# 骨架（验证 schema / 非 Node 环境移植）
python adapters/web-cdp/ax-collect.py --demo
python adapters/web-cdp/ax-collect.py --url <url> --expected <n> --out out.json
```

## 选型矩阵中的位置

| 目标类型 | 首选工具 | 状态 |
|---|---|---|
| **Web / 浏览器** | **CDP / AX** | **主适配器（本目录 + scripts/ax-collect.mjs）** |
| 原生桌面 App | 原生 AX（UIA / macOS AX） | 扩展适配器 `adapters/ax-native/` |
| 移动端 | 无障碍桥 | 同 AX 家族，待扩展 |
| 纯视觉/画布 | 截图 + 模型 | 最后手段，标 `uncertain` |
