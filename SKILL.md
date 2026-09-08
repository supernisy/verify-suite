---
name: verify-suite
description: 前端还原度判定工具集(判定层为主,CDP 为当前采集适配器)。判定页面对设计稿 demo 的视觉还原度与对 PRD 的交互还原度,输出可判定的差异报告。当用户要「对比两个页面的还原度」「验证实现和原型是否一致」「检查视觉还原 / 交互还原」「跑一遍前端验收」时使用。
version: 0.1.0
type: tool
---

# verify-suite · 前端还原度校验工具集

## 它解决什么

产品/设计给了一个可运行的 demo 原型,开发照着它实现产线页面。两边用**不同的组件库、不同的 DOM 结构、不同的 class 名**,业务数据也不同。本工具回答:**实现得对不对**。

第一个难题不是度量,是**怎么定义"同一个元素"** —— 两个异构系统之间没有共享主键,必须先构造业务主键才能比对(这和跨库数据对账同构)。
第二个难题是**度量什么** —— 不能比 DOM 属性(实现手段),要比布局引擎算完的坐标(视觉事实)。
第三个难题是**判据怎么设计** —— 两侧业务数据量不同时,"比两侧变化量是否一致"不是可判定命题。

## 前置条件

```bash
# 1. 启动一个开了 CDP 的浏览器(端口 9222)
#    360 极速版示例:
"C:/Users/super/AppData/Local/360Chrome6/Chrome/Application/360Chrome.exe" \
  --remote-debugging-port=9222

# 2. 验证连通
node scripts/cdp-client.mjs status

# 3. 无需 npm install(零依赖,Node >= 22)
```

## 路线选择(先跑体检再定)

```
┌─ 跑 probe-anchors 看体检数据 ─────────────────┐
│                                               │
│  role / aria-label 较全(≥5)  → 路线 B         │
│  role 几乎没写、div 模拟 ≥50% → 路线 C         │
│  目标组件明确、要精确到字段    → 路线 A         │
└───────────────────────────────────────────────┘
```

| 路线 | 场景 | 命令 |
|---|---|---|
| **A 人工探针** | 同仓库/同组件库,目标组件明确 | `geo-collect` + `geo-compare` |
| **B 语义指纹** | 两侧组件库不同,或不知该测哪些 | `ax-collect` + `ax-diff` |
| **C 交互单元** | role 没写、div 模拟为主(多数项目) | `unit-collect` + `ax-diff` |
| **轨迹** | 验交互还原(点击后该跳转没跳转) | `trace-run` + `trace-diff` |

> 路线 B 与 C 输出格式兼容(`items` + `count`),共用 `ax-diff`,可交叉验证。

## 典型工作流

### 1. 视觉还原度(推荐 B/C 双跑交叉验证)

```bash
# 体检
node scripts/probe-anchors.mjs --url http://demo.local --side demo
node scripts/probe-anchors.mjs --url http://prod.local --side 产线

# 采集(两侧视口必须一致)
node scripts/ax-collect.mjs    --url http://demo.local --out exp-ax.json
node scripts/ax-collect.mjs    --url http://prod.local --out act-ax.json
node scripts/unit-collect.mjs  --url http://demo.local --scope "aside" --out exp-unit.json
node scripts/unit-collect.mjs  --url http://prod.local --scope ".sidebar" --out act-unit.json

# 比对(★ 传 label,报告里才会标注哪边是哪边)
node scripts/ax-diff.mjs exp-ax.json act-ax.json --label-exp demo --label-act 产线
node scripts/ax-diff.mjs exp-unit.json act-unit.json --label-exp demo --label-act 产线
```

### 2. 交互还原度(轨迹双跑)

```bash
node scripts/trace-run.mjs --url http://demo.local --trace examples/trace-example.json \
  --side expected --out trace-exp.json
node scripts/trace-run.mjs --url http://prod.local --trace examples/trace-example.json \
  --side actual --basename /app --out trace-act.json

node scripts/trace-diff.mjs trace-exp.json trace-act.json examples/trace-example.json
```

### 3. 精确到字段(路线 A)

```bash
node scripts/geo-collect.mjs --url http://demo.local --probes examples/probes-example.json \
  --side expected --out geo-exp.json
node scripts/geo-collect.mjs --url http://prod.local --probes examples/probes-example.json \
  --side actual --out geo-act.json
node scripts/geo-compare.mjs geo-exp.json geo-act.json examples/probes-example.json
```

### 4. 行为还原(路线 E · 视觉对上了但行为可能不同)

```bash
# 断言写在 behavior 配置里,两侧各自对照同一份
node scripts/behavior-collect.mjs --url http://demo.local \
  --behavior examples/behavior-example.json --side expected --out bh-exp.json
node scripts/behavior-collect.mjs --url http://prod.local \
  --behavior examples/behavior-example.json --side actual --out bh-act.json
node scripts/behavior-diff.mjs bh-exp.json bh-act.json \
  --behavior examples/behavior-example.json --label-exp demo --label-act 产线
```

配置里可断言四类:**network**(方法 / URL 正则 / body 关键字段)、**console**(正则匹配埋点,最刚需)、
**schema**(响应字段存在性 + 类型)、**artifacts**(产物文件存在性与大小)。

> ★ 只断言结构,不断言业务数值。id 等于几、金额多少是业务测试的事 —— 还原度断言写业务数值会瞬间腐烂。

## 命令参考

### cdp-client.mjs — 基础调试 CLI

```bash
node scripts/cdp-client.mjs navigate <url>      # 新建受控后台标签页 + 注入日志拦截 + 导航
node scripts/cdp-client.mjs goto <url>          # 受控页内换地址(★ 批量多轮导航必须用 goto,否则开出几十个标签页)
node scripts/cdp-client.mjs snapshot --compact  # 一行摘要
node scripts/cdp-client.mjs inspect <sel>       # rect + computed style
node scripts/cdp-client.mjs click <sel|text:文字>
node scripts/cdp-client.mjs hover <sel> [--ms N]
node scripts/cdp-client.mjs type <sel> <text>
node scripts/cdp-client.mjs assert <sel> <visible|hidden|text|count|attr> [...]
node scripts/cdp-client.mjs assert no-error | assert url-contains <s>
node scripts/cdp-client.mjs watch [--ms 5000]   # 只列接口请求(自动过滤 js/css/图片/字体)
node scripts/cdp-client.mjs logs [error|warn|all]
node scripts/cdp-client.mjs screenshot [path]
node scripts/cdp-client.mjs evaluate <js>
```

★ **绝不操作用户当前正在看的标签页**。所有命令只作用于自己新建的受控标签页;受控页不存在时报错退出,**不回退去操作活动标签页**(会把用户浏览的页面跳走)。需要操作活动页必须显式 `--steal-active`。

### probe-layer.mjs — 层级归属 + 弹层定位

```bash
node scripts/probe-layer.mjs --url <url> --list                    # 列出所有真可点单元
node scripts/probe-layer.mjs --url <url> --text "定时任务"          # A: 哪一层才是按钮
node scripts/probe-layer.mjs --url <url> --popup "更多"            # B: 弹层定位
```

`--popup` 先按文案找,找不到才当 CSS selector 用(很多"更多"按钮无文案)。

## ★ 必须踩对的坑

### 1. 全绿不能证明等价 —— 必须故障注入

```
断言全绿时有两种可能:① 两边确实等价 ② 检测器根本没在工作(主键全没命中,静默跳过)
→ 必须注入一个已知故障,确认检测器能报出来。
  实测做法:故意点一个只在基准侧存在的文案 → 期望报出差异、退出码 2
```

### 2. 报告必须标注方向

```bash
# ❌ 不传 label,输出 "inLeft 8 vs 12" —— 读的人会把方向读反,
#    一路怀疑到"服务跑错了/产物过期",白白损失整轮排查
node scripts/ax-diff.mjs exp.json act.json

# ✅ 传入可读名称
node scripts/ax-diff.mjs exp.json act.json --label-exp demo --label-act 产线
#    输出: inLeft  产线 8 ←→ demo 12  (产线偏小 -4, 容差±1)
```

### 3. preload 生命周期绑定 session

`Page.addScriptToEvaluateOnNewDocument` 注册的脚本,**连接断开即失效**。所以「注册 preload → 导航 → 采集」必须在**同一个连接内**完成。拆成多次 CLI 调用会静默失效、无报错、最难排。

→ 所有 `*-collect.mjs` 都自己串完这三步,不复用通用 client。

### 4. 容差按量纲分类

```
连续量(位置、被内容撑开的高度)              → ±1px
离散设计 token(字号/字重/圆角/图标尺寸)      → 零容差
```

⚠️ 实测踩过:给 `fontSize` 设 ±1 容差,把 `14px vs 13px` 的真实差异吞掉了,误判 PASS。

### 5. 两侧业务数据必须一致

demo 侧走 mock server 而非硬编码:① 硬编码演示不了 loading/空态/错误态;② 走网络的 mock 才能被拦截改写;③ 才能拿到字段绑定关系。

### 6. 微前端本地裸开会白屏

若 `rollupOptions.external` 把 react 外置,`vite preview` 必然报 `React is not defined`。**本地对比用 `vite`(dev)而不是 `preview`**,端口被占就换端口,不要杀别人在跑的进程。

### 7. 先确认路由形式

应用可能在 BrowserRouter/HashRouter 间切换且带 basename。本地裸开常需 `http://host/#/<basename>/<path>`,否则**页面渲染为空且无报错**,最难排。

### 8. 页面有无关顶层报错时用 `--preload` 绕过

不要改源码(尤其不能改别人本地未提交的代码)。例:某模块顶层 `ReferenceError: foo is not defined`,用 `--preload "window.foo=()=>{}"` 即可继续。

### 9. 区分"真差异"与"环境差异"

`top`(两侧顶栏高度不同)、`childCount`(DOM 层级不同)应进 `ignore`。**机器能量出事实,但"哪些事实是约束"必须人确认一次。**

### 10. hover 探测后不复位会污染后续校验

三种 hover 实现对 CDP 响应完全不同:CSS `:hover` 稳定响应;JS `onMouseEnter/Leave` 移开可能不触发 leave;group-hover 加在子元素上则探测不到。
`probe-layer` 检测到未复位会打印告警:**跑其它校验前先 reload**。

### 11. 调试 loop 上限

```
调试 loop 最多 5 轮;同一操作连续失败 3 次即换方案;每轮最多 10 个命令
遇白屏/崩溃 reload 一次即可,不要反复 reload
同一 assert 连续失败不要重复执行,应分析原因
```

### 12. 空结果不是「无差异」,是「执行错误」

采集到 0 个节点、或低于 `--min-items`(默认 3),一律退出码 **1**,绝不落 0。

失效链:preload 静默失效 → 采到空快照 → 两侧都空 → diff 判"无差异"退出 0 → **误报通过**。
比对器任一侧输入为空也一样判 1。宁可吵,不可假绿。

### 13. 别让判定层依赖驱动层

判定层(比对器)不得 import `lib/cdp.mjs` —— 用到里面的纯函数就迁到 `lib/args.mjs` /
`lib/tolerance.mjs` / `lib/evidence.mjs`,再从判据层引。由 `npm run check:layering` 强制。

理由:驱动能力会被商品化、可替换;判定能力才是资产。判据长在执行脚本里,换一次驱动就要重写一遍。
耦合是渐进发生的(某天顺手 import 一个工具函数),只能交给 CI 守。

### 14. 无进展时要中止,不要跑完

`trace-run` 连续 3 步(`--no-progress-k` 可调)语义快照完全相同 → 判定卡住,退出码 1。
继续跑完只会产出一串"未达成",把「执行卡住」伪装成「实现有差异」—— 这比报错更糟。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 无差异 / 全部断言达成 |
| 1 | 执行错误(目标未找到、页面加载失败、参数错误、**采集为空**、检测到无进展) |
| 2 | 检出差异 / 断言未达成(便于接 CI 门禁) |

## 能力边界(不要过度承诺)

**已覆盖**:静态视觉几何比对 · 语义节点对齐 · 交互迁移(轨迹) · 行为契约(埋点/请求/响应结构/产物) · 层级归属 · 弹层定位与可见性

**不覆盖**:单元测试逻辑 · 性能/内存 · 可访问性合规审计 · WebGL/Canvas 内容(需按图层拆分) · 暗色/高对比度模式自动对照 · 纯像素级质感(渐变、阴影质感、插画细节)

> 每条结论都带 `evidence`(computed-style / ax-tree / text-skeleton / network / console / pixel)
> 与 `confidence`(high / medium / low)。一次比对的可信度取**所有 item 里最低的那一档**,汇总行会打印。
> 发生降级(预期无障碍树但角色不足,落到文本骨架)时报告写 `degradation` 字段说明原因,**不静默降级**。

## 与 specgate 配合

`specgate` 负责「该验什么」(需求 → 验收契约 → 判定每条是否可机械判定),本工具负责「怎么验」:

```
需求 PRD → [specgate] contract.yaml(每条 accept 标 verify)
              ├─ verify: trace        → trace-run + trace-diff
              └─ verify: unit-visual  → unit-collect + ax-diff
         → [verify-suite] 两侧各跑一遍 → 退出码 0 / 2(接 CI)
```
