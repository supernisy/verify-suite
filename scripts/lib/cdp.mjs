// verify-suite / scripts / lib / cdp.mjs
//
// 共享 CDP 能力。零 npm 依赖,Node >= 22 原生 WebSocket / fetch。
//
// ★ 硬约束(文档 §2):preload 生命周期绑定 session ——
//   Page.addScriptToEvaluateOnNewDocument 注册的脚本,连接断开即失效。
//   所以「注册 preload → 导航 → 采集」必须在同一个连接内完成。
//   本模块提供 session,但调用方(*-collect.mjs)必须自己保证三步在同一 session 内。

import process from 'node:process';

export const CDP_HOST = process.env.VERIFY_CDP_HOST ?? '127.0.0.1';
export const CDP_PORT = Number(process.env.VERIFY_CDP_PORT ?? '9222');
export const CDP_BASE = `http://${CDP_HOST}:${CDP_PORT}`;

// ---------------------------------------------------------------------------
// argv 工具
// ---------------------------------------------------------------------------

/**
 * ★ 5.1:indexOf 未命中时 -1+1=0 会取到第一个位置参数,parseInt 得 NaN,
 *   Math.abs(d) <= NaN 永远 false → 全量误报。必须先判 i >= 0。
 */
export function argValue(argv, name, fallback) {
    const i = argv.indexOf(name);
    if (i < 0) return fallback;
    const v = argv[i + 1];
    return v === undefined ? fallback : v;
}

export function hasFlag(argv, name) {
    return argv.includes(name);
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export class CdpSession {
    constructor(wsUrl, targetId) {
        this.wsUrl = wsUrl;
        this.targetId = targetId;
        this.ws = null;
        this.nextId = 1;
        this.pending = new Map();
        this.events = [];
        this.logsInjected = false;
        this.preloads = [];
    }

    async connect() {
        this.ws = new WebSocket(this.wsUrl);
        await new Promise((resolve, reject) => {
            const onOpen = () => { this.ws.removeEventListener('open', onOpen); resolve(); };
            const onErr = (e) => { this.ws.removeEventListener('error', onErr); reject(new Error('WebSocket error: ' + (e?.message ?? ''))); };
            this.ws.addEventListener('open', onOpen);
            this.ws.addEventListener('error', onErr);
        });
        this.ws.addEventListener('message', (ev) => this._onMessage(ev));
        await this.send('Page.enable');
        await this.send('Runtime.enable');
        await this.send('Network.enable');
    }

    _onMessage(ev) {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id != null) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(Object.assign(new Error(`${p.method}: ${msg.error.message}`), { cdp: msg.error }));
            else p.resolve(msg.result);
        } else if (msg.method) {
            this.events.push(msg);
        }
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, method });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async evalAsync(expression, { awaitPromise = false, returnByValue = true } = {}) {
        const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue });
        if (r.exceptionDetails) {
            throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        }
        return returnByValue ? r.result?.value : r.result;
    }

    close() {
        try { this.ws?.close(); } catch (_) {}
        this.ws = null;
    }
}

/**
 * 创建受控后台标签页。★ 用 PUT 不是 GET(GET 会复用现有页/抢用户焦点)。
 */
export async function createControlledTab() {
    const r = await fetch(`${CDP_BASE}/json/new?about:blank`, { method: 'PUT' });
    if (!r.ok) throw new Error(`createControlledTab failed: ${r.status} (CDP 端点 ${CDP_BASE} 是否可达?)`);
    const t = await r.json();
    if (!t.webSocketDebuggerUrl) throw new Error('no webSocketDebuggerUrl returned');
    return { targetId: t.id, wsUrl: t.webSocketDebuggerUrl, type: t.type };
}

export async function closeControlledTab(targetId) {
    try { await fetch(`${CDP_BASE}/json/close/${targetId}`); } catch (_) {}
}

export async function listTabs() {
    const r = await fetch(`${CDP_BASE}/json`);
    if (!r.ok) throw new Error(`listTabs failed: ${r.status}`);
    return await r.json();
}

/**
 * 开一个受控标签页跑 fn,结束自动关。
 * @param {(s: CdpSession) => Promise<void>} fn
 */
export async function withSession(fn, { keepTab = false } = {}) {
    const { targetId, wsUrl } = await createControlledTab();
    const session = new CdpSession(wsUrl, targetId);
    await session.connect();
    try {
        return await fn(session);
    } finally {
        session.close();
        if (!keepTab) await closeControlledTab(targetId);
    }
}

// ---------------------------------------------------------------------------
// 视口 / preload / 等待
// ---------------------------------------------------------------------------

export async function fixViewport(session, { width = 1440, height = 900 } = {}) {
    await session.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
    });
}

/**
 * 注册 preload 脚本。★ 必须在导航/刷新之前调用,且与后续采集同一 session。
 */
export async function addPreload(session, source) {
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source });
    session.preloads.push(source);
    // 若页面已加载,立即再注入一次(覆盖 about:blank 场景)
    try { await session.send('Runtime.evaluate', { expression: source }); } catch (_) {}
}

/**
 * 导航并等 load。
 */
export async function navigateAndWait(session, url, { timeoutMs = 30000 } = {}) {
    const r = await session.send('Page.navigate', { url });
    if (r.errorText) throw new Error('Page.navigate: ' + r.errorText);
    await new Promise((resolve) => {
        let done = false;
        const handler = (ev) => {
            if (done) return;
            let msg; try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.method === 'Page.loadEventFired') {
                done = true;
                session.ws.removeEventListener('message', handler);
                resolve();
            }
        };
        session.ws.addEventListener('message', handler);
        setTimeout(() => { if (!done) { done = true; session.ws.removeEventListener('message', handler); resolve(); } }, timeoutMs);
    });
    await waitRAF(session);
}

/** 双 rAF,等布局与绘制落定。 */
export async function waitRAF(session) {
    await session.evalAsync(
        'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
        { awaitPromise: true }
    );
}

export async function waitForSelector(session, sel, { timeout = 15000, appear = true } = {}) {
    const expr = `
        new Promise((resolve, reject) => {
            const start = Date.now();
            const t = ${JSON.stringify(sel)};
            (function tick(){
                const el = document.querySelector(t);
                const ok = !!el;
                if (${appear} ? ok : !ok) return resolve(true);
                if (Date.now() - start > ${timeout}) return reject(new Error('wait timeout: ' + t));
                setTimeout(tick, 50);
            })();
        })
    `;
    await session.evalAsync(expr, { awaitPromise: true });
}

export async function waitForUrlContains(session, fragment, { timeout = 15000 } = {}) {
    const expr = `
        new Promise((resolve, reject) => {
            const start = Date.now();
            const f = ${JSON.stringify(fragment)};
            (function tick(){
                if (location.href.includes(f)) return resolve(true);
                if (Date.now() - start > ${timeout}) return reject(new Error('url wait timeout: ' + f));
                setTimeout(tick, 50);
            })();
        })
    `;
    await session.evalAsync(expr, { awaitPromise: true });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 归一化 / 指纹(路线 B、C 共用)
// ---------------------------------------------------------------------------

/**
 * ★ 归一化四步,每步都有实测理由:
 *   去空白:innerText 会在块级子元素间插分隔符
 *   数字→#:"活跃任务 5" vs "活跃任务 12"
 *   截断 40:超长文本尾部差异不影响主键
 *   小写
 */
export function norm(s) {
    return String(s ?? '')
        .replace(/\s+/g, '')
        .replace(/\d+/g, '#')
        .slice(0, 40)
        .toLowerCase();
}

/** 视觉阅读顺序用的坐标量化(★ 8px 网格,否则 1px 抖动会让两侧排序不一致) */
export function gridKey(rect) {
    const gy = Math.round(rect.top / 8);
    const gx = Math.round(rect.left / 8);
    return { gy, gx };
}

// ---------------------------------------------------------------------------
// 视觉度量(原则 1 + 原则 2:只认运行时计算值,比坐标差值不比属性)
// ---------------------------------------------------------------------------

/**
 * 在页面里对单个元素采集视觉度量。
 * 返回字段:
 *   boxW / boxH            盒子尺寸
 *   inLeft/inRight/inTop   内容边缘到盒子边缘的距离(视觉内边距等价物)
 *   iconGap                文字左边缘 − 图标右边缘
 *   iconSize               图标尺寸
 *   vBias                  文字中线 − 盒子中线(垂直居中偏差)
 *   fontSize/fontWeight/textColor
 *   radius/bg/hasShadow
 */
export const MEASURE_FN = `function(){
    const el = this;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const boxW = r.width, boxH = r.height;

    // 内容边缘:找真正持有文本的最内层子元素(叶子文本块),否则用自身
    let textEl = el;
    const strip = s => (s || '').replace(/\\s/g, '');
    const txtOf = e => (e.innerText || e.textContent || '');
    (function(){
        const kids = Array.from(el.children);
        const withText = kids.filter(c => strip(txtOf(c)).length > 0);
        if (withText.length === 1 && strip(txtOf(withText[0])).length > 0) {
            // 单个含文本的子元素:继续往下钻到最内层
            let cur = withText[0];
            for (let i = 0; i < 8; i++) {
                const ks = Array.from(cur.children).filter(c => strip(txtOf(c)).length > 0);
                if (ks.length !== 1) break;
                cur = ks[0];
            }
            textEl = cur;
        }
    })();
    // ★ 兜底:el 自己没有元素子节点含文本(纯文本节点场景,如 <button>新任务</button>),
    //   用 Range 测第一个非空文本节点的 rect。el.children 只看元素节点,看不到文本节点。
    if (textEl === el) {
        try {
            const tn = Array.from(el.childNodes).find(n =>
                n.nodeType === 3 && n.nodeValue && n.nodeValue.replace(/\\s/g,'').length > 0);
            if (tn) {
                const range = document.createRange();
                range.selectNodeContents(tn);
                textEl = { getBoundingClientRect: () => range.getBoundingClientRect() };
            }
        } catch (_) {}
    }
    const tr = textEl.getBoundingClientRect();

    // 图标:取最近的 svg / img(限自身子树内)
    let iconEl = null;
    try {
        iconEl = el.querySelector('svg, img, [class*="icon" i], [class*="Icon"]');
    } catch (_) {}

    let iconGap = null, iconSize = null;
    if (iconEl) {
        const ir = iconEl.getBoundingClientRect();
        if (ir.width > 0 && ir.height > 0) {
            iconSize = Math.round(Math.max(ir.width, ir.height));
            // iconGap = 文字左边缘 − 图标右边缘(图标在左时为正)
            iconGap = Math.round(tr.left - ir.right);
        }
    }

    const textMid = tr.top + tr.height / 2;
    const boxMid = r.top + r.height / 2;

    return {
        boxW: Math.round(boxW * 100) / 100,
        boxH: Math.round(boxH * 100) / 100,
        inLeft: Math.round((tr.left - r.left) * 100) / 100,
        inRight: Math.round((r.right - tr.right) * 100) / 100,
        inTop: Math.round((tr.top - r.top) * 100) / 100,
        iconGap,
        iconSize,
        vBias: Math.round((textMid - boxMid) * 100) / 100,
        fontSize: parseFloat(cs.fontSize),
        fontWeight: cs.fontWeight,
        textColor: cs.color,
        radius: cs.borderRadius,
        bg: cs.backgroundColor,
        hasShadow: cs.boxShadow !== 'none',
        rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    };
}`;

/**
 * 对 objectId 对应的元素执行视觉度量。
 */
export async function measureElement(session, objectId) {
    const r = await session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `(${MEASURE_FN})`,
        returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('measure: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
}

// ---------------------------------------------------------------------------
// 语义节点链路(Accessibility.getFullAXTree → DOM.resolveNode → callFunctionOn)
// ---------------------------------------------------------------------------

export async function resolveBackendNode(session, backendNodeId) {
    const r = await session.send('DOM.resolveNode', { backendNodeId });
    return r.object;
}

// ---------------------------------------------------------------------------
// 交互操作(每条 API 的选择理由见文档 §2 表格)
// ---------------------------------------------------------------------------

export async function clickByObjectId(session, objectId) {
    await session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(){ this.scrollIntoView({block:"center"}); }',
    });
    await waitRAF(session);
    await session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(){ this.click(); }',
    });
    await waitRAF(session);
}

/** ★ hover 必须走内核级事件:JS 合成的 MouseEvent 触发不了 CSS :hover */
export async function hoverAt(session, x, y) {
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

/** ★ 输入用 Input.insertText:富文本编辑器有自己的 document model */
export async function insertText(session, text) {
    await session.send('Input.insertText', { text });
}

/** ★ 拖拽必须多步插值,一步跳终点很多拖拽库不认 */
export async function dragInterpolated(session, from, to, steps = 16) {
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
        await sleep(16);
    }
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
}

// ---------------------------------------------------------------------------
// 弹层「消失」六条判据(文档 §4.7 B)
// ---------------------------------------------------------------------------

export const VISIBILITY_FN = `function(){
    const el = this;
    if (!el.isConnected) return { visible: false, reason: 'dom-detached' };
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return { visible: false, reason: 'display-none' };
    if (cs.visibility === 'hidden') return { visible: false, reason: 'visibility-hidden' };
    if (parseFloat(cs.opacity) <= 0.01) return { visible: false, reason: 'opacity-zero' };
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area <= 0) return { visible: false, reason: 'zero-area' };
    const ix = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const iy = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    const inter = ix * iy;
    // ★ 第 5 条:与视口相交面积 > 自身面积 5%(抽屉式 translateX(100%) 只有这条能判出)
    if (inter / area <= 0.05) return { visible: false, reason: 'off-viewport' };
    if (cs.pointerEvents === 'none') return { visible: false, reason: 'pointer-events-none' };
    return { visible: true, reason: null, intersectRatio: Math.round(inter / area * 100) / 100 };
}`;

export async function checkVisibility(session, objectId) {
    const r = await session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `(${VISIBILITY_FN})`,
        returnByValue: true,
    });
    if (r.exceptionDetails) return { visible: false, reason: 'eval-error' };
    return r.result.value;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

export function writeJson(path, data) {
    return import('node:fs/promises').then(fs => fs.writeFile(path, JSON.stringify(data, null, 2)));
}

export function readJson(path) {
    return import('node:fs/promises').then(fs => fs.readFile(path, 'utf8')).then(JSON.parse);
}

// ---------------------------------------------------------------------------
// 容差策略(原则 7:连续量 ±1px,离散设计 token 零容差)
// ---------------------------------------------------------------------------

export const STRICT_FIELDS = new Set(['fontSize', 'fontWeight', 'radius', 'borderRadius', 'iconSize', 'lineHeight']);

/**
 * 判断字段是否零容差。
 * @param {string} field
 * @param {string[]} strictList 探针里显式声明的 strict 字段
 */
export function toleranceFor(field, strictList = [], defaultTol = 1) {
    if (strictList.includes(field)) return 0;
    if (STRICT_FIELDS.has(field)) return 0;
    return defaultTol;
}
