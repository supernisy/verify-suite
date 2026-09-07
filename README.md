# verify-suite

> 给前端页面对设计稿 demo 做**视觉还原** + 对 PRD 做**交互还原**。
> 零 npm 依赖,纯 CLI,跑在 CDP 浏览器上,输出**可判定**的差异报告。

## TL;DR · 30 秒建立心智

- **它做什么**:把"页面 1 vs 页面 2"或"页面 vs 设计稿"变成一份**退出码为 0/2**的差异清单 —— 谁偏大、谁偏小、哪侧独有。
- **它不是什么**:不是截图对比工具(不取整张图片的 SSIM / pHash),不是 E2E(不写业务流),不是单测框架。
- **一条命令链**:采集一次 → 采集二次 → 比对 → 看输出。所有脚本共用同一份语义指纹,可比;同一份退出码约定,可接 CI。

## 能做什么 vs 不做什么

| ✅ 能 | ❌ 不 |
|---|---|
| 在 DOM 上采集**运行时**几何/字号/字重/色值 | 读源码声明值(不信 Tailwind class 名,要看到计算后的 px) |
| 对齐**异构 DOM**(语义指纹 = `role\|文案`) | 比整张图(视觉风格抖动它认,像素抖动它不认) |
| 指出**谁偏大、谁偏小**,容差按量纲分档 | 自动改实现(给的是诊断,不是补丁) |
| 同一份轨迹在两侧各跑一次,各自对照断言 | 代替人写断言(语义断言还是人来写) |
| 零 npm 依赖,Node 22 + 任意 Chromium 浏览器 | 服务端 headless 渲染(要真实浏览器) |

## 30 秒最小 demo

开一个独立 profile 的调试浏览器(不碰你正在用的浏览器),跑三条路线,截两张图:

```bash
# 起一个 headless Edge,端口 9222,独立 user-data-dir
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --remote-debugging-port=9222 \
  --user-data-dir=C:/Users/super/AppData/Local/Temp/vs-profile \
  --headless=new about:blank &

# 一键跑 demo(已注入 4 处真实差异)
bash examples/demo/run-demo.sh
```

demo 故意注入的差异:`fontSize 20→18` / `padding 12→8` / 「技能」→「技能市场」/ 产线多一个「删除」/ 产线漏实现点击反馈。

### 视觉还原 · 路线 B 语义指纹

> 路线 B 拿 Accessibility.getFullAXTree 给整页每个交互元素建语义指纹(`role\|文案`),按 8px 网格量化排序、指纹归一化(数字 → `#`、空白剥离、40 字截断)后做四档对齐:精确 / 模糊(文案漂移) / 仅基准 / 仅实测。

![demo 与 prod 点击后对比](docs/demo-clicked.png)
*同一份交互,设计稿(左)出状态条,产线(右)没反应 —— 视觉差异一目了然。*

```text
— 仅实测侧存在(实现多余,1) —
  ⚠ button|删除 "删除"  @40,168
— 度量差异(3 组) —
  ❌ [精确]  heading|数字员工
   ❌ fontSize  产线 18 ←→ 设计稿 20  (产线偏小 -2, strict)
  ❌ [精确]  button|新任务
   ❌ inLeft   产线 8  ←→ 设计稿 12  (产线偏小 -4)
  ⚠ [模糊 0.50]  button|技能      ← 「技能」→「技能市场」文案漂移
汇总: 差异项 3 · 仅实测 1  → 退出码 2
```

### 视觉还原 · 路线 A 探针精确卡尺

> 路线 A 是手动写的探针(知道要测哪个元素,精确到字段)。`strict` 字段零容差(字号/字重/圆角是离散设计 token,差 1 就是选错档,不是抖动),其它默认 ±1px。

```text
❌ 页面标题
  ❌ fontSize  产线 18 ←→ 设计稿 20  (产线偏小 -2, strict(零容差))
  ✅ fontWeight  产线 "600" ←→ 设计稿 "600"
❌ 主按钮·新任务
  ❌ inLeft    产线 8 ←→ 设计稿 12  (产线偏小 -4, 容差±1)
  ✅ fontSize  产线 14 ←→ 设计稿 14
  ✅ borderRadius  产线 "6px" ←→ 设计稿 "6px"
✅ 次按钮·技能   fontSize/borderRadius 一致,inLeft 与设计稿相同
汇总: 通过 0 · 差异 3  → 退出码 2
```

### 交互还原 · 轨迹两侧各自对照同一份语义断言

> 关键设计:**两侧各自对照同一份断言**,不比较"变化量是否相同"。两侧 DOM 量不同时,"比变化量"会产生 82 项噪声。
>
 三种判定:✓ 双达成 / ✗ 仅一侧不达成(真 bug,改代码)/ ⚠️ 双不达成(断言写错了,改断言)。

![点击后视觉差异](docs/prod-clicked.png)
*产线点击「新任务」按钮后,缺少绿色状态条 —— trace-diff 输出 ✗ 真差异。*

```text
步骤 [0] 点击「新任务」按钮
  ❌ appeared heading|任务已创建   仅 产线 未达成  ← 真差异,改代码
汇总:
  ✓ 两侧都达成      0
  ✗ 仅一侧不达成    1   → 真差异,改代码
  ⚠ 两侧都不达成    0
退出码 2
```

## 路线选择

```
跑 probe-anchors 体检  →  看角色密度 + testid 密度 + div 模拟占比
 ├─ 角色/testid 较全(>40%)  → 走路线 B(ax-collect + ax-diff)
 ├─ 角色缺失,div 模拟为主    → 走路线 C(unit-collect)
 └─ 目标组件明确,需要精确字段 → 走路线 A(geo-collect + 手写 probes.json)
```

> DOM 决策一旦动了,指纹照样能跟上;用 selector 一动就废,这是 fingerprint vs selector 的成本差。

## 命令索引

| 脚本 | 职责 |
|---|---|
| `cdp-client.mjs` | 基础调试 CLI:新建受控标签页、注入日志拦截器、snapshot/click/type/drag/assert/screenshot/evaluate/watch 等 |
| `geo-collect.mjs` / `geo-compare.mjs` | 路线 A:人工探针精确卡尺 |
| `ax-collect.mjs` / `ax-diff.mjs` | 路线 B:语义指纹全量扫描 + 通用比对器(本项目核心) |
| `unit-collect.mjs` | 路线 C:交互单元 + 文本骨架(角色缺失时的主路线) |
| `probe-anchors.mjs` / `probe-layer.mjs` | 诊断:选路线 / 弹层定位与归属 |
| `trace-run.mjs` / `trace-diff.mjs` | 交互还原:轨迹双跑 + 两侧各对照同一份语义断言 |

详细参数与坑位清单见 [`SKILL.md`](./SKILL.md),七条核心原则与各路线权衡见原始任务文档。

## 退出码(CI 可消费)

| 码 | 含义 |
|---|---|
| `0` | 无差异 / 全部断言达成 |
| `1` | 执行错误(目标未找到、页面加载失败、参数错误) |
| `2` | 检出差异 / 断言未达成 |

## 与 specgate 联动

验收标准以机器可消费的契约形式落在 [`acceptance/contract.yaml`](./acceptance/contract.yaml),
由 [specgate](https://github.com/supernisy/specgate) 做确定性门禁(零模型、可复现)。
契约里每条 `accept` 的 `verify` 字段直接对应本工具的某条路线:
`geo` → geo-compare · `ax` → ax-diff · `unit-visual` → unit-collect · `trace` → trace-diff。

> specgate 管「该验什么」,verify-suite 管「怎么验」。

## 文档导航

- [`SKILL.md`](./SKILL.md) · 每条命令的用法 + 场景选择 + 踩坑提示
- [`AGENTS.md`](./AGENTS.md) · 给后续 AI 的工程化决策与设计权衡
- [`acceptance/contract.yaml`](./acceptance/contract.yaml) · specgate 验收契约
- [`examples/demo/`](./examples/demo) · 可一键复现的最小 demo

## License

MIT