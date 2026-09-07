# AGENTS.md - AI 协作者须知

本文档面向任何继续维护本仓库的 AI(以及人类),记录所有**自主决策点**与**踩过的坑**。原始任务文档已经把"做什么"写得很清楚,这里聚焦"为什么这么做"。

## 1. 项目定位与边界

- **是什么**:基于 CDP 的命令行工具集,判定前端页面相对 demo 原型的视觉/交互还原度。
- **不是什么**:不是浏览器自动化框架(不替代 Playwright/Puppeteer);不是单元测试框架;不是性能/可访问性审计工具。
- **核心场景**:产品/设计给了一个可运行的 demo 原型,开发照着实现产线页面 —— 两边用不同组件库、不同 DOM 结构、不同 class 名,本工具回答"实现得对不对"。

## 2. 自主决策(已默认值的 8 项)

| # | 决策项 | 值 | 理由 |
|---|---|---|---|
| 1 | 项目仓库位置 | `supernisy/verify-suite`(public) | 与 `clearbox`/`archverdict` 同级,均用 `supernisy` 账号 |
| 2 | 代码风格 | 纯 ESM(`*.mjs`),Node 22+,JSDoc 标注关键契约,4 空格缩进,无分号 | 文档明文要求"零 npm 依赖";ESM 与 Node 22 原生 fetch/WebSocket 配合最自然 |
| 3 | 退出码 | `0=无差异` / `1=执行错误` / `2=检出差异` | 文档第六章硬约定,接 CI 必须 |
| 4 | 输出格式 | 终端给**单行 PASS/FAIL + 差值**;JSON 文件给**结构化**(`items[]` + `count`);差值标注方向(`产线 vs demo`) | token 经济;路线 B/C 字段兼容以便共用 ax-diff |
| 5 | 错误处理 | 全局 try/catch + `--debug` 开关打 dump;preload 失败时**明确打印**(`addScriptToEvaluateOnNewDocument` 静默失效最难排) | 踩过代价 |
| 6 | 自检要求 | 每个 collect/compare 脚本实现后必须跑 §6.1 故障注入(故意点一个基准侧独有条目,期望 3 项差异 + 退出码 2) | 文档第六章明文要求;否则"全绿"可能是检测器静默没工作 |
| 7 | 等待稳定 | 默认 `URL 含某片段` 或 `某选择器出现`;**双 rAF** 等布局绘制落定;定长 sleep 仅作动画兼容尾巴 | 文档"等待稳定"硬约束 |
| 8 | 受控标签页策略 | `PUT /json/new?about:blank` 新建后台页;无 `--steal-active` 旗标时**永不**操作活动标签页 | 文档 ★ 条目 —— 把用户浏览的页面跳走是 P0 事故 |

## 3. 七条核心设计原则(地基)

违反任何一条都会导致结论不可信。所有脚本都是这七条的落地:

1. **只认运行时计算值** —— `getBoundingClientRect()` + `getComputedStyle()`,绝不读源码声明值
2. **不比属性,比坐标差值** —— `inLeft = 内容左边缘 - 盒子左边缘`,与实现手段无关
3. **主键选择凭存在目的** —— ① data-testid ② role+accname ③ 表单 name ④ 接口字段路径 ⑤ 结构性文案 ⑥ 结构指纹 ⑦ 阅读顺序
4. **第 ② 级零配合生效** —— W3C accname 规范,即使被测方无任何标注,浏览器已算好名字 → 对被测代码零侵入
5. **区分两类文本** —— 结构性文案(代码写死)= 可做主键;数据性文案(接口返回)= 绝不能做主键
6. **动态内容区比模板不比内容** —— 卡片尺寸/内边距/圆角可比对,卡片内的具体数值不可比对
7. **容差按量纲分类** —— 连续量 ±1px;离散设计 token(字号/粗细/圆角/档位间距)零容差(差 1 就是选错档)

## 4. 明确否决的路线(不要再尝试)

| 否决项 | 理由 |
|---|---|
| i18n 翻译 key 做主键 | 稳定性契约在翻译流程手里 |
| 框架内部结构(Fiber)做主路线 | 绑框架绑版本;可作诊断期兜底,不可进主链 |
| `__reactProps$` 反查业务数据 | 它上面只有 DOM 属性,业务数据被箭头函数闭包捕获,命中率 0 |
| 纯像素截图 diff 做主判据 | 误报率高(动画/字体/亚像素);仅作渐变/阴影/图标形状兜底 |
| hover 变化判定层级归属 | 实测不稳定 + 探测后不复位会污染后续校验 |
| 依赖被测方提供 data-testid | 实测两侧都是 0;放接口但不指望 |
| 比较两侧的 diff 是否相同 | 两侧数据量不同时不可判定;必须改成两侧各自对照同一份断言 |

## 5. 踩过的坑(每条都有真实项目代价)

### 5.1 `argv.indexOf('--x') + 1` 全量误报

未命中时 `-1+1=0`,取到第一个位置参数,`parseInt` 得 `NaN`,`Math.abs(d) <= NaN` 永远 `false` → 所有字段全报 FAIL,连 240 vs 240 也报错。

```javascript
// ❌ 错误
const tol = parseInt(argv[argv.indexOf('--tol') + 1]);

// ✅ 正确
const i = argv.indexOf('--tol');
const tol = i >= 0 ? parseInt(argv[i + 1]) : 1;
```

### 5.2 preload 生命周期

`Page.addScriptToEvaluateOnNewDocument` 注册的脚本,**连接断开即失效**。所以「注册 preload → 导航/刷新 → 采集」必须在**同一个连接内**完成。如果拆成多次 CLI 调用(每次新建 session),preload 静默失效、无报错、最难排。

→ **所有 `*-collect.mjs` 都必须把这三步做在一个脚本里**,不能复用通用 client。

### 5.3 cursor 继承虚高 6.7 倍

`<div class="cursor-pointer" onClick><svg/><span/></div>` —— svg 和 span 都"继承"了 pointer。实测 235 个 → 去继承后 35 个,与 React onClick 的 35 个**数量完全相等**(两个独立信号交叉印证)。

### 5.4 hover 三种实现

- CSS `:hover` → 对 `mouseMoved` 稳定响应
- JS `onMouseEnter`/`onMouseLeave` → 移开可能不触发 leave,★ **状态不复位**
- `group-hover:` 加在子元素上 → 被测层自身不变,探测不到

★ 真正的风险是**探测完不复位会污染后续所有校验**。必须实现:检测到未复位时打印告警"跑其它校验前先 reload"。

### 5.5 弹层消失的六条判据

抽屉式弹层用 `translateX(100%)`,DOM 在、display 正常、opacity=1 —— 只有「与视口相交面积 > 自身面积的 5%」能判出它已消失。其它四条单独用都不够。

### 5.6 不比变化量,比断言达成

第一版曾犯:比较两侧每步的节点变化量是否相同。实测 demo mock 10 条、产线真实 20 条 → 报"变化量不同",82 项噪声把真实迁移差异完全掩盖。

★ 两边数据量本来就不同时,"比总数"不是可判定命题。**必须**:轨迹里写 expect 语义断言,两侧各自判定是否达成,再比达成情况。

### 5.7 排列方向不能信 `flexDirection`

`display:block` 时它也返回 `'row'`,会把纵向间距算成负数。必须按子元素实际位置推断(相邻子元素 rect 横向/纵向递增)。

### 5.8 归一化必去数字

innerText 在块级子元素间插分隔符 → 先 `.replace(/\s+/g, '')` 去所有空白;`.replace(/\d+/g, '#')` 把数字换掉(解决"活跃任务 5" vs "活跃任务 12");`.slice(0, 40)` 截断(超长文本尾部差异不影响主键)。

### 5.9 受控标签页 vs 活动标签页

绝不操作用户当前正在看的标签页。所有命令只作用于自己新建的受控标签页;受控标签页不存在时**报错退出**,不要回退去操作活动标签页(会把用户浏览的页面跳走)。需要操作活动标签页时必须由显式环境变量开启。

## 6. 协议硬约束(技术底座)

| 操作 | 正确 API | 为什么 |
|---|---|---|
| 点击 | `Runtime.callFunctionOn` 调 `this.click()`,前置 `scrollIntoView` | 算坐标发鼠标事件受滚动/遮盖影响 |
| 悬停 | `Input.dispatchMouseEvent { type:'mouseMoved', x, y }` | JS 合成的 MouseEvent 触发不了 CSS `:hover` |
| 输入 | `Input.insertText` | 富文本编辑器(Slate/ProseMirror/Lexical)有自己的 document model,改 DOM 会导致不一致 |
| 拖拽 | `mousePressed` → **多步插值** `mouseMoved` → `mouseReleased` | 一步跳到终点很多拖拽库不认 |
| 原生 HTML5 拖拽 | `Input.setInterceptDrags` + `Input.dispatchDragEvent` | `draggable=true` 走 drag 事件流 |
| 改接口响应 | `Fetch.enable` + `Fetch.requestPaused` → `Fetch.fulfillRequest` | 造空态/4xx/5xx/慢响应,被测服务无需配合 |
| 断言输入值 | `Network.enable` + 监听 `requestWillBeSent` 取 `postData` | 结构化节点(@提及/附件)在 DOM 序列化跨编辑器不一致,放网络层 |

## 7. 与其他项目的关系

- `clearbox` —— 本地最小化 Agent 平台(在开发中)
- `archverdict` —— TypeScript CLI 开源项目
- `verify-suite` —— 本仓库,前端还原度校验工具集

三个项目共用 `supernisy` GitHub 账号 + gh CLI 推送流程(已在用户记忆里登记)。

## 8. 与 specgate 配合(实测经验)

`specgate` 管「该验什么」(需求 → 验收契约 → 判定每条是否可机械判定),本仓库管「怎么验」。
契约在 `acceptance/contract.yaml`,`verify` 字段直接对应本工具的路线:

| specgate verify | 本仓库命令 |
|---|---|
| `geo` | `geo-collect` + `geo-compare` |
| `ax` | `ax-collect` + `ax-diff` |
| `unit-visual` | `unit-collect` + `ax-diff` |
| `trace` | `trace-run` + `trace-diff` |

### ★★ 踩过的坑:specgate 的 invariants 必须用**固定变动词表**内的词

`specgate` 判定 invariants 是否为"蜕变关系"时,靠两张固定词表做字符串匹配
(见 `specgate/src/words.js`):

- **变动词**(描述输入侧变动):`新增 增加 添加 加一 减少 移除 删除 去掉 修改 扩大 缩小 交换 调整 翻倍 拆分 合并 再次 两次 三次 重复 连续 先后 打乱 逆序 变为 改成 换成 之后 同样的 相同入参 同一参数`
- **关系词**(描述输出侧怎么变):`增加 减少 不变 相同 一致 相等 等于 之和 ...`

实测被拦的写法(都不在词表里,报"没有描述输入侧的变动"):

```
❌ "父容器可用宽度单调收窄时,boxW 单调不增"      → "收窄" 不在词表
❌ "容差数值从 0 单调放宽时,FAIL 字段数单调不增" → "放宽" 不在词表
```

改成词表内的词才通过:

```
✅ "父容器可用宽度缩小后,采集到的 boxW 不增加"
✅ "容差数值调整变大后,被判定为 FAIL 的字段数不增加"
```

另有一条补充模式 `CHANGE_PATTERN = /([^，。；、\s]{2,8})后[，,、]/g`,能捕捉"……后,"结构,
但会排除副词(`最后/然后/随后/以后/此后/之后`)。写 invariants 时优先用明确的表内动词。

### 迭代流程

```bash
node ~/.workbuddy/specgate/src/cli.js draft requirement.md   # 产出空白模板 + 填写提示
# (AI 填写 contract.yaml,每条 accept 标 suspect)
node ~/.workbuddy/specgate/src/cli.js lint contract.yaml     # 退出 0 才通过,失败看 review.md
node ~/.workbuddy/specgate/src/cli.js plan contract.yaml     # 产出 impl-task/ + test-task/(物理隔离)
```

lint 全程零模型、零网络、可复现 —— 同一份契约跑一百次输出完全相同。
**失败(退出 2)是正常的**,那是门禁在拦"不可验"的需求,按 `review.md` 改即可,不要绕过门禁删条目。

## 9. 未来扩展方向(留给后续 AI)

- 路线 D:WebGL/Canvas 截图局部比对(需要按图层拆分)
- 暗色模式/高对比度模式自动切换对照
- 录制回放:把 trace-run 的执行序列转成可独立回放的脚本
- 把 `ax-diff` 的报告输出成 GitHub Actions 的 PR 评论(已留退出码 2 接口)
- 浏览器侧集成:支持 Safari(WebKit)、Firefox(Gecko)的 CDP-like 协议

## 10. 已知 bug 修复(给后续 AI 留排查路线)

### 10.1 `inLeft` 对纯文本子节点测不出

**症状**:对 `<button>新任务</button>`(只有文本子节点,无元素子节点)这种组件,
`geo-collect` 采到的 `inLeft = 0`,无论 padding-left 写多少。

**根因**:`scripts/lib/cdp.mjs` 里的 `MEASURE_FN` 用 `el.children` 找"含文本的最内层子元素"作为 textEl。
`el.children` **只包含元素节点**,不包含文本节点。纯文本场景下 `kids = []`,`textEl` 保持为 `el` 本身,
`inLeft = textEl.left - el.left = 0`。

**修法**:在 textEl 仍是 `el` 时,fallback 用 `Range.selectNodeContents()` 测第一个非空文本节点的 rect。

**复现**:`bash examples/demo/run-demo.sh`,看路线 A 的「主按钮·新任务」之前 inLeft=0 vs inLeft=0 都 PASS;
修完之后才看到「产线 8 ←→ 设计稿 12 (产线偏小 -4)」。