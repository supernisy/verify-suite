# verify-suite

判定前端页面对设计稿 demo 的**视觉还原度**与**对 PRD 的交互还原度**,输出可判定的差异报告。

零 npm 依赖,Node ≥ 22,使用原生 `WebSocket` 与 `fetch` 与 CDP 通信。

## 安装

```bash
# 1. 启动一个支持 CDP 的浏览器(本项目默认沿用 360 极速版,端口 9222)
"C:/Users/super/AppData/Local/360Chrome6\Chrome\Application\360Chrome.exe" \
  --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0

# 2. 直接运行(无需 npm install)
node scripts/cdp-client.mjs navigate https://example.com
```

## 工具一览

| 脚本 | 职责 |
|---|---|
| `scripts/cdp-client.mjs` | 基础调试 CLI:导航/交互/断言/日志/截图/diff |
| `scripts/geo-collect.mjs` / `geo-compare.mjs` | 路线 A:人工探针精确卡尺 |
| `scripts/ax-collect.mjs` / `ax-diff.mjs` | 路线 B:语义指纹全量扫描 + 通用比对器 |
| `scripts/unit-collect.mjs` | 路线 C:交互单元 + 文本骨架(role 缺失时) |
| `scripts/probe-anchors.mjs` | 锚点体检,判断该走哪条路线 |
| `scripts/probe-layer.mjs` | 层级归属 + 弹层定位与可见性 |
| `scripts/trace-run.mjs` / `trace-diff.mjs` | 交互还原(轨迹双跑 + 两侧各对照同一份语义断言) |

详细使用见 [`SKILL.md`](./SKILL.md),设计原理与坑位清单见原始任务文档。

## 路线选择建议

```
显式 role 与 aria 较全      → 走路线 B (ax-collect)
role 几乎没写、div 模拟为主  → 走路线 C (unit-collect)
目标组件明确、需要精确字段    → 走路线 A (geo-collect + 探针)
```

先跑 `probe-anchors` 看一眼体检数据再定。

## 退出码约定

| 码 | 含义 |
|---|---|
| 0 | 无差异 / 全部断言达成 |
| 1 | 执行错误(目标未找到、页面加载失败、参数错误) |
| 2 | 检出差异 / 断言未达成(便于接 CI) |

## License

MIT