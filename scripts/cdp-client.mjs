#!/usr/bin/env node
// verify-suite / scripts / cdp-client.mjs
//
// 基础调试 CLI。所有命令只作用于"受控标签页",绝不操作用户当前正在看的页面。
//
// 通信:Chrome DevTools Protocol over WebSocket(原生,零依赖)。
// 用法:node scripts/cdp-client.mjs <command> [args...]
//
// 受控标签页策略:
//   - `navigate` 用 PUT /json/new?about:blank 创建后台标签页(不抢活动焦点)
//   - `goto` / `reload` 在受控标签页内执行(绝不跨页)
//   - 受控标签页不存在时直接报错退出,不回退到活动标签页
//   - 想操作活动标签页需显式 `--steal-active`(本 CLI 默认禁用)
//
// 退出码约定:
//   0  成功 / 全部断言达成
//   1  执行错误(目标未找到、页面加载失败、参数错误)
//   2  断言未达成

import process from 'node:process';

// ---------------------------------------------------------------------------
// argv 解析
// ---------------------------------------------------------------------------

/**
 * 安全的 argv 取值。
 *
 * ★ 5.1 踩过的坑:argv.indexOf('--x') + 1 在未命中时 -1+1=0,取到第一个位置参数,
 *    parseInt 得 NaN,Math.abs(d) <= NaN 永远 false → 所有字段全报 FAIL。
 */
function argValue(argv, name, fallback) {
    const i = argv.indexOf(name);
    if (i < 0) return fallback;
    const v = argv[i + 1];
    return v === undefined ? fallback : v;
}

function hasFlag(argv, name) {
    return argv.includes(name);
}

// ---------------------------------------------------------------------------
// CDP 端点
// ---------------------------------------------------------------------------

const CDP_HOST = process.env.VERIFY_CDP_HOST ?? '127.0.0.1';
const CDP_PORT = Number(process.env.VERIFY_CDP_PORT ?? '9222');
const CDP_BASE = `http://${CDP_HOST}:${CDP_PORT}`;

let STEAL_ACTIVE = hasFlag(process.argv, '--steal-active'); // 默认禁用

// ---------------------------------------------------------------------------
// 日志拦截脚本(注入到页面,window.__getCapturedLogs 暴露)
// ---------------------------------------------------------------------------

const LOG_INTERCEPTOR = `
(function() {
  if (window.__verifySuiteLogInjected) return;
  window.__verifySuiteLogInjected = true;
  window.__capturedLogs = [];
  window.__errorLogs = [];
  const push = (level, args) => {
    const text = (args || []).map(a => {
      try {
        if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
        if (typeof a === 'object') return JSON.stringify(a);
        return String(a);
      } catch (_) { return String(a); }
    }).join(' ');
    const rec = { level, text, time: Date.now() };
    window.__capturedLogs.push(rec);
    if (level === 'error') window.__errorLogs.push(rec);
  };
  ['log','info','warn','error','debug'].forEach(level => {
    const orig = console[level]?.bind(console);
    console[level] = (...args) => { push(level, args); try { orig?.(...args); } catch(_){} };
  });
  window.addEventListener('error', e => push('error', [(e.error && e.error.stack) || (e.message + ' @ ' + e.filename + ':' + e.lineno)]));
  window.addEventListener('unhandledrejection', e => push('error', ['UnhandledRejection: ' + ((e.reason && e.reason.stack) || String(e.reason))]));
})();
`;

// ---------------------------------------------------------------------------
// CDP 会话管理
// ---------------------------------------------------------------------------

class CdpSession {
    /**
     * @param {string} wsUrl - webSocketDebuggerUrl
     * @param {string} targetId - 标签页 targetId(用于日志/受控校验)
     */
    constructor(wsUrl, targetId) {
        this.wsUrl = wsUrl;
        this.targetId = targetId;
        this.ws = null;
        this.nextId = 1;
        this.pending = new Map();   // id → {resolve, reject, method}
        this.events = [];           // 所有收到的事件(用于 watch)
        this.logsInjected = false;
        this.sessionId = null;      // Page/Network sessionId(暂不使用 attachment,保持简单)
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
        // 启用 Page / Runtime / Network / Log 域
        await this.send('Page.enable');
        await this.send('Runtime.enable');
        await this.send('Network.enable');
        await this.send('Log.enable');
    }

    _onMessage(ev) {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id != null) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(Object.assign(new Error(p.method + ': ' + msg.error.message), { cdp: msg.error }));
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

    close() {
        try { this.ws?.close(); } catch (_) {}
        this.ws = null;
    }
}

// ---------------------------------------------------------------------------
// 受控标签页管理
// ---------------------------------------------------------------------------

/**
 * 创建受控后台标签页(★ 用 PUT,不是 GET —— GET 会复用现有页/抢焦点)。
 * Returns: { targetId, wsUrl }
 */
async function createControlledTab() {
    const r = await fetch(`${CDP_BASE}/json/new?about:blank`, { method: 'PUT' });
    if (!r.ok) throw new Error(`createControlledTab failed: ${r.status}`);
    const t = await r.json();
    if (!t.webSocketDebuggerUrl) throw new Error('No webSocketDebuggerUrl returned');
    return { targetId: t.id, wsUrl: t.webSocketDebuggerUrl, type: t.type };
}

/**
 * 关闭受控标签页。
 */
async function closeControlledTab(targetId) {
    try { await fetch(`${CDP_BASE}/json/close/${targetId}`); } catch (_) {}
}

/**
 * 列出当前所有标签页(用于 pages/status 命令)。
 */
async function listTabs() {
    const r = await fetch(`${CDP_BASE}/json`);
    if (!r.ok) throw new Error(`listTabs failed: ${r.status}`);
    return await r.json();
}

/**
 * 取活动标签页的 wsUrl(默认禁用,需要 STEAL_ACTIVE)。
 */
async function getActiveTab() {
    const tabs = await listTabs();
    return tabs.find(t => t.type === 'page');
}

// ---------------------------------------------------------------------------
// 视口/会话便捷封装
// ---------------------------------------------------------------------------

async function fixViewport(session, { width = 1440, height = 900 } = {}) {
    await session.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
    });
}

async function ensureLogsInjected(session) {
    if (session.logsInjected) return;
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: LOG_INTERCEPTOR });
    // 立刻在当前已加载页面里也注入一次(如果页面还没 about:blank)
    await session.send('Runtime.evaluate', { expression: LOG_INTERCEPTOR });
    session.logsInjected = true;
}

// ---------------------------------------------------------------------------
// 选择器 / 文本 / 路径 → RemoteObject.objectId(便于取值)
// ---------------------------------------------------------------------------

/**
 * 把 selector 或 text:xxx 解析成 element。
 *   - "text:首页"  → 通过 Runtime.evaluate 用 innerText 查找(深度优先)
 *   - "nth:button(3)" → :nth-of-type(3)
 *   - 其他 → document.querySelector
 */
async function resolveSelector(session, sel) {
    if (sel.startsWith('text:')) {
        const text = sel.slice(5).replace(/"/g, '\\"');
        const expr = `
            (function(){
                const t = ${JSON.stringify(text)};
                const all = Array.from(document.querySelectorAll('*')).filter(e => e.children.length === 0);
                return all.find(e => (e.innerText || e.textContent || '').trim() === t) || null;
            })()
        `;
        const r = await session.send('Runtime.evaluate', { expression: expr, returnByValue: false });
        if (!r.result || !r.result.objectId) {
            throw new Error(`text: selector not found: ${sel}`);
        }
        return r.result;
    }
    const expr = `document.querySelector(${JSON.stringify(sel)})`;
    const r = await session.send('Runtime.evaluate', { expression: expr, returnByValue: false });
    if (!r.result || !r.result.objectId) {
        // 再试一次:也许是 page 内 frame,降级到深度搜索
        if (sel.includes(',')) throw new Error(`selector not found: ${sel}`);
        const expr2 = `
            (function(){
                function walk(root){
                    if(!root) return null;
                    if(root.querySelector && root.querySelector(${JSON.stringify(sel)})) return root.querySelector(${JSON.stringify(sel)});
                    for(const c of (root.children || [])){
                        const r = walk(c); if(r) return r;
                    }
                    return null;
                }
                return walk(document.body);
            })()
        `;
        const r2 = await session.send('Runtime.evaluate', { expression: expr2, returnByValue: false });
        if (!r2.result || !r2.result.objectId) throw new Error(`selector not found: ${sel}`);
        return r2.result;
    }
    return r.result;
}

async function callOnObject(session, obj, expression, returnByValue = true) {
    const r = await session.send('Runtime.callFunctionOn', {
        objectId: obj.objectId,
        functionDeclaration: `(function(){ ${expression} })`,
        returnByValue,
    });
    if (r.exceptionDetails) throw new Error('callFunctionOn error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
}

async function evalOnObject(session, obj, expression) {
    return callOnObject(session, obj, `return (${expression});`);
}

// ---------------------------------------------------------------------------
// 等待稳定
// ---------------------------------------------------------------------------

async function waitRAF(session) {
    // 双 rAF,等布局与绘制落定(文档"等待稳定"硬约束)
    await session.send('Runtime.evaluate', {
        expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
        awaitPromise: true,
    });
}

async function waitForSelector(session, sel, { timeout = 10000, appear = true } = {}) {
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
    await session.send('Runtime.evaluate', { expression: expr, awaitPromise: true });
}

async function waitForUrlContains(session, fragment, { timeout = 10000 } = {}) {
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
    await session.send('Runtime.evaluate', { expression: expr, awaitPromise: true });
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

async function withSession(fn) {
    const { targetId, wsUrl } = await createControlledTab();
    const session = new CdpSession(wsUrl, targetId);
    await session.connect();
    try { await fn(session); }
    finally {
        session.close();
        if (!hasFlag(process.argv, '--keep-tab')) await closeControlledTab(targetId);
    }
}

async function cmdStatus(_argv, _session) {
    const tabs = await listTabs();
    const lines = [
        `CDP endpoint: ${CDP_BASE}`,
        `Total tabs: ${tabs.length}`,
        ...tabs.map(t => `  - ${t.type.padEnd(8)} ${t.id.slice(0, 8)} ${t.url ?? ''}`),
    ];
    console.log(lines.join('\n'));
}

async function cmdPages(_argv, _session) {
    const tabs = await listTabs();
    for (const t of tabs) {
        console.log(`${t.id}\t${t.type}\t${t.url ?? ''}\t${t.title ?? ''}`);
    }
}

async function cmdNavigate(argv, session) {
    const url = argv[1];
    if (!url) throw new Error('navigate <url> required');
    await fixViewport(session);
    await ensureLogsInjected(session);
    const r = await session.send('Page.navigate', { url });
    if (r.errorText) throw new Error('Page.navigate: ' + r.errorText);
    // 等 load 事件
    await new Promise((resolve) => {
        const handler = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.method === 'Page.loadEventFired') {
                session.ws.removeEventListener('message', handler);
                resolve();
            }
        };
        session.ws.addEventListener('message', handler);
        setTimeout(resolve, 30000); // 兜底超时
    });
    await waitRAF(session);
    console.log(`navigated: ${url}`);
}

async function cmdGoto(argv, session) {
    await ensureLogsInjected(session);
    const url = argv[1];
    if (!url) throw new Error('goto <url> required');
    const r = await session.send('Page.navigate', { url });
    if (r.errorText) throw new Error('Page.navigate: ' + r.errorText);
    await new Promise((resolve) => {
        const handler = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.method === 'Page.loadEventFired') {
                session.ws.removeEventListener('message', handler);
                resolve();
            }
        };
        session.ws.addEventListener('message', handler);
        setTimeout(resolve, 30000);
    });
    await waitRAF(session);
    console.log(`goto: ${url}`);
}

async function cmdReload(_argv, session) {
    await session.send('Page.reload', { ignoreCache: true });
    await new Promise((resolve) => {
        const handler = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.method === 'Page.loadEventFired') {
                session.ws.removeEventListener('message', handler);
                resolve();
            }
        };
        session.ws.addEventListener('message', handler);
        setTimeout(resolve, 30000);
    });
    await waitRAF(session);
    console.log('reloaded');
}

async function cmdSnapshot(argv, session) {
    const compact = hasFlag(argv, '--compact');
    const focusIdx = argv.indexOf('--focus');
    const focus = focusIdx >= 0 ? argv[focusIdx + 1] : null;
    const sel = argv[1];
    const expr = focus
        ? `(() => { const root = document.querySelector(${JSON.stringify(focus)}) || document; root.__focus = true; return root; })()`
        : (sel
            ? `document.querySelector(${JSON.stringify(sel)}) || document.body`
            : `document.body`);
    // 简化版 snapshot:遍历子树给一行摘要
    const snapExpr = `
        (function(){
            const root = (${expr});
            if (!root) return { empty: true };
            const out = [];
            const W = window.innerWidth;
            function walk(el, depth){
                if (depth > 8) return;
                const r = el.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) return;
                const tag = el.tagName.toLowerCase();
                const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(/\\s+/).filter(Boolean).slice(0, 3).join('.') : '';
                const txt = (el.children.length === 0 ? (el.innerText || el.textContent || '').trim().slice(0, 60) : '');
                const id = el.id ? '#' + el.id : '';
                const aria = el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : '';
                const label = el.getAttribute('aria-label');
                if (${compact}) {
                    out.push(\`\${tag}\${id}\${cls}\${aria} \${Math.round(r.left)},\${Math.round(r.top)} \${Math.round(r.width)}x\${Math.round(r.height)} \${txt ? '"' + txt + '"' : ''}\${label ? ' aria="' + label + '"' : ''}\`.trim());
                } else {
                    out.push({ tag, id, cls, role: el.getAttribute('role'), label, left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), text: txt });
                }
                if (!${compact} && depth < 3) for (const c of el.children) walk(c, depth + 1);
            }
            walk(root, 0);
            return ${compact} ? out.join('\\n') : out;
        })()
    `;
    const r = await session.send('Runtime.evaluate', { expression: snapExpr, returnByValue: true });
    console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2));
}

async function cmdInspect(argv, session) {
    const sel = argv[1];
    if (!sel) throw new Error('inspect <selector> required');
    const obj = await resolveSelector(session, sel);
    const data = await evalOnObject(session, obj, `(() => {
        const r = this.getBoundingClientRect();
        const cs = getComputedStyle(this);
        return {
            tag: this.tagName.toLowerCase(),
            id: this.id || null,
            className: this.className || null,
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
            computed: {
                fontSize: cs.fontSize,
                fontWeight: cs.fontWeight,
                color: cs.color,
                backgroundColor: cs.backgroundColor,
                borderRadius: cs.borderRadius,
                padding: cs.padding,
                margin: cs.margin,
                display: cs.display,
                cursor: cs.cursor,
            },
            text: (this.innerText || this.textContent || '').trim().slice(0, 200),
        };
    })()`);
    console.log(JSON.stringify(data, null, 2));
}

async function cmdClick(argv, session) {
    const sel = argv[1];
    if (!sel) throw new Error('click <sel|text:xxx> required');
    const obj = await resolveSelector(session, sel);
    // scrollIntoView + click()(文档:不要算坐标发鼠标事件)
    await callOnObject(session, obj, `this.scrollIntoView({block: 'center'});`);
    await waitRAF(session);
    await callOnObject(session, obj, `this.click();`);
    await waitRAF(session);
    console.log(`clicked: ${sel}`);
}

async function cmdDblclick(argv, session) {
    const sel = argv[1];
    if (!sel) throw new Error('dblclick <sel> required');
    const obj = await resolveSelector(session, sel);
    await callOnObject(session, obj, `this.scrollIntoView({block: 'center'});`);
    await waitRAF(session);
    await callOnObject(session, obj, `
        const ev = (type) => new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
        this.dispatchEvent(ev('mousedown'));
        this.dispatchEvent(ev('mouseup'));
        this.dispatchEvent(ev('click'));
        this.dispatchEvent(ev('mousedown'));
        this.dispatchEvent(ev('mouseup'));
        this.dispatchEvent(ev('click'));
        this.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    `);
    await waitRAF(session);
    console.log(`dblclicked: ${sel}`);
}

async function cmdRightclick(argv, session) {
    const sel = argv[1];
    if (!sel) throw new Error('rightclick <sel> required');
    const obj = await resolveSelector(session, sel);
    const rect = await evalOnObject(session, obj, `(() => { const r = this.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'right', clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'right', clickCount: 1 });
    await waitRAF(session);
    console.log(`rightclicked: ${sel}`);
}

async function cmdHover(argv, session) {
    const sel = argv[1];
    const ms = Number(argValue(argv, '--ms', '0'));
    if (!sel) throw new Error('hover <sel> [ms] required');
    const obj = await resolveSelector(session, sel);
    const rect = await evalOnObject(session, obj, `(() => { const r = this.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    if (ms > 0) await new Promise(r => setTimeout(r, ms));
    await waitRAF(session);
    console.log(`hovered: ${sel} ${ms ? `(${ms}ms)` : ''}`);
}

async function cmdDrag(argv, session) {
    const from = argv[1], to = argv[2];
    if (!from || !to) throw new Error('drag <from> <to> required');
    const o1 = await resolveSelector(session, from);
    const o2 = await resolveSelector(session, to);
    const r1 = await evalOnObject(session, o1, `(() => { const r = this.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    const r2 = await evalOnObject(session, o2, `(() => { const r = this.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    // 多步插值(文档:很多拖拽库不认一步跳到终点)
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r1.x, y: r1.y, button: 'left', clickCount: 1 });
    const STEPS = 16;
    for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS;
        await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r1.x + (r2.x - r1.x) * t, y: r1.y + (r2.y - r1.y) * t });
        await new Promise(r => setTimeout(r, 16));
    }
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r2.x, y: r2.y, button: 'left', clickCount: 1 });
    await waitRAF(session);
    console.log(`dragged: ${from} -> ${to}`);
}

async function cmdType(argv, session) {
    const sel = argv[1];
    const text = argv[2];
    if (!sel || text == null) throw new Error('type <sel> <text> required');
    const obj = await resolveSelector(session, sel);
    await callOnObject(session, obj, `this.focus();`);
    // Input.insertText(文档:富文本编辑器有自己的 document model,改 DOM 会不一致)
    await session.send('Input.insertText', { text });
    await waitRAF(session);
    console.log(`typed ${text.length} chars into: ${sel}`);
}

async function cmdSelect(argv, session) {
    const sel = argv[1];
    const value = argv[2];
    if (!sel || value == null) throw new Error('select <sel> <option> required');
    const obj = await resolveSelector(session, sel);
    await callOnObject(session, obj, `
        this.value = ${JSON.stringify(value)};
        this.dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await waitRAF(session);
    console.log(`selected: ${value} on ${sel}`);
}

async function cmdScroll(argv, session) {
    const target = argv[1] || 'page';
    const dir = argv[2] || 'down';
    const expr = target === 'page'
        ? `(() => { window.scrollBy({ top: ${dir === 'up' ? '-' : ''}window.innerHeight * 0.9, behavior: 'instant' }); })()`
        : `(() => { const el = document.querySelector(${JSON.stringify(target)}); el && el.scrollBy({ top: ${dir === 'up' ? '-' : ''}el.clientHeight * 0.9, behavior: 'instant' }); })()`;
    await session.send('Runtime.evaluate', { expression: expr });
    await waitRAF(session);
    console.log(`scrolled ${target} ${dir}`);
}

async function cmdKeypress(argv, session) {
    const key = argv[1];
    if (!key) throw new Error('keypress <Key> required');
    // 支持常见快捷键:Enter / Escape / Tab / ArrowDown 等
    const KEY_MAP = {
        Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
        Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
        Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
        Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
        ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
        ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
        ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
        ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    };
    const k = KEY_MAP[key] || { key, code: key, windowsVirtualKeyCode: key.charCodeAt(0) };
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    await waitRAF(session);
    console.log(`keypress: ${key}`);
}

async function cmdFocus(argv, session) {
    const sel = argv[1];
    if (!sel) throw new Error('focus <sel> required');
    const obj = await resolveSelector(session, sel);
    await callOnObject(session, obj, `this.focus();`);
    console.log(`focused: ${sel}`);
}

async function cmdWait(argv, session) {
    const sel = argv[1];
    const state = argv[2] ?? 'appear';
    const timeout = Number(argv[3] ?? '10000');
    if (!sel) throw new Error('wait <sel> [appear|disappear] [timeout] required');
    await waitForSelector(session, sel, { timeout, appear: state !== 'disappear' });
    console.log(`wait: ${sel} ${state}`);
}

async function cmdLogs(argv, session) {
    const filter = argv[1] ?? 'all';
    const r = await session.send('Runtime.evaluate', { expression: `JSON.stringify({ all: window.__capturedLogs || [], errors: window.__errorLogs || [] })`, returnByValue: true });
    const data = JSON.parse(r.result.value);
    if (filter === 'error') {
        for (const l of data.errors) console.log(`[error] ${l.text}`);
        console.log(`total errors: ${data.errors.length}`);
    } else if (filter === 'warn') {
        for (const l of data.all.filter(x => x.level === 'warn')) console.log(`[warn] ${l.text}`);
    } else {
        for (const l of data.all) console.log(`[${l.level}] ${l.text}`);
        console.log(`total: ${data.all.length}, errors: ${data.errors.length}`);
    }
}

async function cmdScreenshot(argv, session) {
    const path = argv[1] ?? `verify-snap-${Date.now()}.png`;
    const r = await session.send('Page.captureScreenshot', { format: 'png' });
    const fs = await import('node:fs/promises');
    await fs.writeFile(path, Buffer.from(r.data, 'base64'));
    console.log(`screenshot: ${path}`);
}

async function cmdEvaluate(argv, _session) {
    const expr = argv.slice(1).join(' ');
    if (!expr) throw new Error('evaluate <js> required');
    const r = await _session.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) {
        console.error('eval error:', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        process.exit(1);
    }
    console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value));
}

async function cmdWatch(argv, session) {
    const ms = Number(argValue(argv, '--ms', '5000'));
    const filterStatic = !hasFlag(argv, '--all');
    const start = Date.now();
    const startEvents = session.events.length;
    await new Promise(r => setTimeout(r, ms));
    const slice = session.events.slice(startEvents);
    const seen = new Set();
    const requests = slice
        .filter(e => e.method === 'Network.requestWillBeSent')
        .map(e => e.params?.request?.url)
        .filter(Boolean);
    const responses = slice.filter(e => e.method === 'Network.responseReceived').map(e => ({ url: e.params?.response?.url, status: e.params?.response?.status }));
    const filtered = filterStatic
        ? requests.filter(u => !/\\.(js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf)(\\?|$)/i.test(u))
        : requests;
    for (const u of new Set(filtered)) console.log(`[req] ${u}`);
    for (const r of responses) console.log(`[${r.status}] ${r.url}`);
    console.log(`\\nwindow: ${ms}ms, requests: ${filtered.length}, responses: ${responses.length}`);
}

// ---------------------------------------------------------------------------
// assert 系列(★ 单行 PASS/FAIL)
// ---------------------------------------------------------------------------

function pass(msg) { console.log(`PASS  ${msg}`); return 0; }
function fail(msg) { console.log(`FAIL  ${msg}`); return 2; }

async function cmdAssert(argv, session) {
    const mode = argv[1];
    if (!mode) throw new Error('assert <sel> <kind> [...] or assert no-error or assert url-contains <s>');

    if (mode === 'no-error') {
        const r = await session.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__errorLogs || [])', returnByValue: true });
        const errs = JSON.parse(r.result.value);
        if (errs.length === 0) return pass('no-error');
        for (const e of errs) console.error(`  ${e.text}`);
        process.exitCode = fail(`no-error (${errs.length} errors)`);
        return;
    }
    if (mode === 'url-contains') {
        const s = argv[2];
        const r = await session.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
        const href = r.result.value;
        if (href.includes(s)) return pass(`url-contains ${s}`);
        process.exitCode = fail(`url-contains ${s} (got: ${href})`);
        return;
    }

    // assert <sel> <kind> [...]
    const sel = mode;
    const kind = argv[2];
    const rest = argv.slice(3);

    const obj = await resolveSelector(session, sel).catch(() => null);
    if (kind === 'visible') {
        if (!obj) { process.exitCode = fail(`${sel} visible (not found)`); return; }
        const r = await evalOnObject(session, obj, `(() => { const rect = this.getBoundingClientRect(); const cs = getComputedStyle(this); return { w: rect.width, h: rect.height, d: cs.display, v: cs.visibility, o: cs.opacity }; })()`);
        const visible = r.w > 0 && r.h > 0 && r.d !== 'none' && r.v !== 'hidden' && parseFloat(r.o) > 0.01;
        if (visible) return pass(`${sel} visible`);
        process.exitCode = fail(`${sel} visible (display=${r.d} visibility=${r.v} opacity=${r.o} ${r.w}x${r.h})`);
        return;
    }
    if (kind === 'hidden') {
        if (!obj) return pass(`${sel} hidden (not in DOM)`);
        const r = await evalOnObject(session, obj, `(() => { const rect = this.getBoundingClientRect(); const cs = getComputedStyle(this); return { w: rect.width, h: rect.height, d: cs.display, v: cs.visibility, o: cs.opacity }; })()`);
        const hidden = r.w === 0 || r.h === 0 || r.d === 'none' || r.v === 'hidden' || parseFloat(r.o) <= 0.01;
        if (hidden) return pass(`${sel} hidden`);
        process.exitCode = fail(`${sel} hidden (still visible)`);
        return;
    }
    if (kind === 'text') {
        const expected = rest[0];
        if (!obj) { process.exitCode = fail(`${sel} text (not found)`); return; }
        const txt = await evalOnObject(session, obj, `(this.innerText || this.textContent || '').trim()`);
        if (txt.includes(expected)) return pass(`${sel} text contains "${expected}"`);
        process.exitCode = fail(`${sel} text "${expected}" (got: "${txt.slice(0, 80)}")`);
        return;
    }
    if (kind === 'count') {
        const op = rest[0]; // >, <, =, >=, <=
        const n = Number(rest[1]);
        const r = await session.send('Runtime.evaluate', { expression: `document.querySelectorAll(${JSON.stringify(sel)}).length`, returnByValue: true });
        const got = r.result.value;
        const cmp = op === '=' ? got === n
            : op === '>' ? got > n
            : op === '<' ? got < n
            : op === '>=' ? got >= n
            : op === '<=' ? got <= n
            : null;
        if (cmp) return pass(`${sel} count ${op} ${n} (got ${got})`);
        process.exitCode = fail(`${sel} count ${op} ${n} (got ${got})`);
        return;
    }
    if (kind === 'attr') {
        const name = rest[0];
        const expected = rest[1];
        if (!obj) { process.exitCode = fail(`${sel} attr ${name} (not found)`); return; }
        const v = await evalOnObject(session, obj, `this.getAttribute(${JSON.stringify(name)})`);
        if (expected == null) return pass(`${sel} attr ${name} present (=${v})`);
        if (v === expected) return pass(`${sel} attr ${name} = ${expected}`);
        process.exitCode = fail(`${sel} attr ${name} expected ${expected}, got ${v}`);
        return;
    }
    throw new Error('unknown assert kind: ' + kind);
}

// ---------------------------------------------------------------------------
// diff 系列(snapshot / compare 当前页面)
// ---------------------------------------------------------------------------

async function cmdDiff(argv, session) {
    const sub = argv[1];
    if (sub === 'save') {
        const path = argv[2] ?? 'verify-snap.json';
        const r = await session.send('Runtime.evaluate', {
            expression: `(() => {
                const out = [];
                function walk(el, depth){
                    if (depth > 10) return;
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 && rect.height === 0) return;
                    const cs = getComputedStyle(el);
                    out.push({
                        tag: el.tagName.toLowerCase(),
                            id: el.id || null,
                            className: typeof el.className === 'string' ? el.className : null,
                            role: el.getAttribute('role'),
                            left: rect.left, top: rect.top, width: rect.width, height: rect.height,
                            fontSize: cs.fontSize,
                            color: cs.color,
                            backgroundColor: cs.backgroundColor,
                            borderRadius: cs.borderRadius,
                            text: (el.children.length === 0 ? (el.innerText || el.textContent || '').trim() : '').slice(0, 80),
                        });
                    if (depth < 6) for (const c of el.children) walk(c, depth + 1);
                }
                walk(document.body, 0);
                return out;
            })()`,
            returnByValue: true,
        });
        const fs = await import('node:fs/promises');
        await fs.writeFile(path, JSON.stringify(r.result.value, null, 2));
        console.log(`saved: ${path} (${r.result.value.length} nodes)`);
    } else {
        // 简化版:打印当前页面结构概要
        await cmdSnapshot([], session);
    }
}

// ---------------------------------------------------------------------------
// 命令分派
// ---------------------------------------------------------------------------

const COMMANDS = {
    status: cmdStatus,
    pages: cmdPages,
    navigate: cmdNavigate,
    goto: cmdGoto,
    reload: cmdReload,
    snapshot: cmdSnapshot,
    inspect: cmdInspect,
    diff: cmdDiff,
    click: cmdClick,
    dblclick: cmdDblclick,
    rightclick: cmdRightclick,
    hover: cmdHover,
    drag: cmdDrag,
    type: cmdType,
    select: cmdSelect,
    scroll: cmdScroll,
    keypress: cmdKeypress,
    focus: cmdFocus,
    wait: cmdWait,
    logs: cmdLogs,
    screenshot: cmdScreenshot,
    evaluate: cmdEvaluate,
    assert: cmdAssert,
    watch: cmdWatch,
};

async function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
        console.log(`verify-suite cdp-client · 基础调试 CLI

用法: node scripts/cdp-client.mjs <command> [args...]

命令一览:
  navigate <url>           新建受控后台标签页 + 注入日志拦截器 + 导航
  goto <url>               在受控标签页内换地址(不开新页)
  reload                   在受控标签页内刷新
  status | pages           列出当前浏览器所有标签页
  snapshot [sel]           打印当前页面节点结构(默认 body)
      --compact            单行摘要
      --focus <sel>        聚焦子树
  inspect <sel>            打印单个元素的 rect + computed style
  diff save <path>         保存当前页面几何快照(JSON)
  click | dblclick | rightclick <sel>
  hover <sel> [--ms N]     派发 mouseMoved(★ 走内核事件才能触发 CSS :hover)
  drag <from> <to>         多步插值拖拽
  type <sel> <text>        Input.insertText(富文本编辑器专用)
  select <sel> <opt>       设置 select 值
  scroll <page|sel> <up|down>
  keypress <Key>           Enter / Escape / Tab / ArrowUp|Down|Left|Right
  focus <sel>              元素 focus
  wait <sel> [appear|disappear] [timeout]
  logs [error|warn|all]    读取页面内捕获的 console/uncaught error
  screenshot [path]
  evaluate <js>            在页面上下文里求值
  assert <sel> <visible|hidden|text|count|attr> [...]
  assert no-error          断言页面无未捕获错误
  assert url-contains <s>  断言 URL 包含某片段
  watch [--ms 5000]        列出窗口内所有网络请求(默认过滤静态资源)

环境变量:
  VERIFY_CDP_HOST          默认 127.0.0.1
  VERIFY_CDP_PORT          默认 9222

旗标:
  --steal-active           (禁用)允许操作活动标签页 —— 默认拒绝
  --keep-tab               关闭 CLI 时保留受控标签页(便于 inspect)

退出码: 0 成功 | 1 执行错误 | 2 断言未达成
`);
        return;
    }
    const cmd = argv[0];
    const handler = COMMANDS[cmd];
    if (!handler) {
        console.error(`unknown command: ${cmd}\nrun with --help to see all commands`);
        process.exit(1);
    }
    // navigate / goto / reload / snapshot / inspect / click / ... 等需要 session 的命令
    const NEEDS_SESSION = new Set(['navigate','goto','reload','snapshot','inspect','click','dblclick','rightclick','hover','drag','type','select','scroll','keypress','focus','wait','logs','screenshot','evaluate','assert','watch','diff']);
    if (NEEDS_SESSION.has(cmd)) {
        await withSession(async (session) => handler(argv, session));
    } else {
        await handler(argv, null);
    }
}

main().catch(err => {
    console.error('error:', err.message ?? err);
    if (process.env.VERIFY_DEBUG) console.error(err.stack);
    process.exit(1);
});