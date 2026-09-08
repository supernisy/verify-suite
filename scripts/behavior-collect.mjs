#!/usr/bin/env node
/**
 * 路线 E · 行为契约采集(behavior-collect)
 *
 * 前四条路线回答"看起来对不对",路线 E 回答"**做对了没有**" ——
 * 页面长一样不代表行为一致:按钮点了但没发请求、请求发了但参数少一个字段、
 * 埋点丢了,这些视觉比对一条都抓不到。
 *
 * 观测三类事实(只记录,不断言):
 *   1. 网络请求  —— 方法 / URL / 关键 body 字段
 *   2. console   —— 埋点最常用的落点(正则可匹配即可)
 *   3. 响应结构  —— 字段**存在性与类型**,不断言业务数值
 *   4. 可选产物  —— 落盘文件的存在性与大小
 *
 * ★ 断言不写在这里。断言写在 behavior 配置里,由 behavior-diff 让两侧
 *   各自对照**同一份**断言 —— 与 trace 同构:不比较两侧变化量是否相同。
 *
 * 用法:
 *   node scripts/behavior-collect.mjs --url <url> --behavior <behavior.json>
 *        --side <expected|actual> [--wait <sel>] [--settle <ms>] --out <file>
 *
 * 退出码: 0=采集完成 | 1=执行错误(目标未找到/页面加载失败/采集为空)
 */
import { argValue, hasFlag, argNumber } from './lib/args.mjs';
import {
    withSession, fixViewport, navigateAndWait, waitForSelector,
    waitForUrlContains, waitRAF, sleep, norm, insertText,
} from './lib/cdp.mjs';
import { stat } from 'node:fs/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// 元素定位与动作
// ---------------------------------------------------------------------------

/** 把 target 解析成 objectId。支持:CSS 选择器 / text:文案 / role|名称 */
async function resolveTarget(session, target) {
    if (target.startsWith('text:')) {
        const t = target.slice(5);
        const r = await session.send('Runtime.evaluate', {
            expression: `(() => {
                const all = Array.from(document.querySelectorAll('*'));
                const e = all.find(x => x.children.length === 0 && (x.innerText||x.textContent||'').trim() === ${JSON.stringify(t)});
                if (!e) return null;
                return true;
            })()`,
            returnByValue: true,
        });
        if (!r.result?.value) throw new Error(`text target not found: ${t}`);
        const obj = await session.send('Runtime.evaluate', {
            expression: `(() => {
                const all = Array.from(document.querySelectorAll('*'));
                return all.find(x => x.children.length === 0 && (x.innerText||x.textContent||'').trim() === ${JSON.stringify(t)});
            })()`,
        });
        return obj.result?.objectId;
    }

    if (target.startsWith('[') || target.startsWith('.') || target.startsWith('#')) {
        const obj = await session.send('Runtime.evaluate', {
            expression: `document.querySelector(${JSON.stringify(target)})`,
        });
        if (!obj.result?.objectId) throw new Error(`selector not found: ${target}`);
        return obj.result.objectId;
    }

    // 语义指纹 role|name
    const [role, ...rest] = target.split('|');
    const wantNorm = norm(rest.join('|').replace(/#\d+$/, ''));
    const ax = await session.send('Accessibility.getFullAXTree');
    const nodes = (ax.nodes ?? []).filter(n => !n.ignored && n.backendDOMNodeId && n.role?.value === role);
    let hit = null;
    for (const n of nodes) {
        if (norm(n.name?.value ?? '') === wantNorm) { hit = n; break; }
    }
    if (!hit) throw new Error(`semantic target not found: ${target}`);
    const obj = (await session.send('DOM.resolveNode', { backendNodeId: hit.backendDOMNodeId })).object;
    if (!obj?.objectId) throw new Error(`cannot resolve: ${target}`);
    return obj.objectId;
}

async function doAction(session, step) {
    const kind = step.action?.kind ?? step.action;
    const target = step.action?.target ?? step.target;

    if (kind === 'sleep') { await sleep(step.action?.ms ?? step.ms ?? 300); return; }
    if (kind === 'wait') {
        if (step.action?.urlContains) await waitForUrlContains(session, step.action.urlContains);
        if (step.action?.selector) await waitForSelector(session, step.action.selector);
        return;
    }
    if (kind === 'navigate') {
        await navigateAndWait(session, step.action.url);
        return;
    }

    const objectId = await resolveTarget(session, target);

    if (kind === 'click') {
        await session.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: 'function(){ this.scrollIntoView({block:"center"}); }',
        });
        await waitRAF(session);
        await session.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: 'function(){ this.click(); }',
        });
    } else if (kind === 'type') {
        await session.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: 'function(){ this.scrollIntoView({block:"center"}); this.focus(); }',
        });
        // ★ 用 Input.insertText:富文本编辑器有自己的 document model
        await insertText(session, step.action?.text ?? step.text ?? '');
    } else {
        throw new Error(`unknown action kind: ${kind}`);
    }
}

// ---------------------------------------------------------------------------
// 观测:从 CDP 事件里提取行为事实
// ---------------------------------------------------------------------------

/** 取 JSON 的顶层字段名(bodyFields 断言用) */
function jsonTopKeys(s) {
    if (!s) return [];
    try {
        const v = JSON.parse(s);
        if (v && typeof v === 'object' && !Array.isArray(v)) return Object.keys(v);
    } catch { /* 非 JSON body,忽略 */ }
    return [];
}

/** 把响应 JSON 拍平成 "a.b.c": type,只取存在性与类型(★ 不断言业务数值) */
function flattenTypes(obj, prefix = '', out = {}, depth = 0) {
    if (depth > 3 || out.size > 200) return out;
    if (obj === null) return out;
    if (Array.isArray(obj)) {
        if (obj.length > 0 && typeof obj[0] === 'object') flattenTypes(obj[0], prefix + '[0]', out, depth + 1);
        else out[prefix] = 'array';
        return out;
    }
    if (typeof obj !== 'object') { out[prefix] = typeof obj; return out; }
    for (const [k, v] of Object.entries(obj)) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (v === null) out[p] = 'null';
        else if (Array.isArray(v)) out[p] = 'array';
        else if (typeof v === 'object') flattenTypes(v, p, out, depth + 1);
        else out[p] = typeof v;
    }
    return out;
}

/**
 * 从新增事件里抽出网络 / console / 响应三类事实。
 * @param {import('./lib/cdp.mjs').CdpSession} session
 * @param {number} fromIndex 本步开始时的事件游标
 */
async function observeSince(session, fromIndex, { schemaPatterns = [] } = {}) {
    const network = [];
    const console_ = [];
    const responses = [];
    const pendingResp = [];

    for (let i = fromIndex; i < session.events.length; i++) {
        const e = session.events[i];
        const p = e.params ?? {};
        if (e.method === 'Network.requestWillBeSent') {
            const r = p.request ?? {};
            network.push({
                method: r.method,
                url: r.url,
                postData: r.postData ?? null,
                bodyFields: jsonTopKeys(r.postData),
            });
        } else if (e.method === 'Network.responseReceived') {
            const resp = p.response ?? {};
            pendingResp.push({
                requestId: p.requestId,
                url: resp.url,
                status: resp.status,
                mimeType: resp.mimeType,
            });
        } else if (e.method === 'Runtime.consoleAPICalled') {
            const text = (p.args ?? []).map(a => a.value ?? a.description ?? '').join(' ');
            console_.push({ type: p.type, text });
        }
    }

    // 只给配置里声明了 urlPattern 的响应取 body(避免把所有流量都拉一遍)
    for (const r of pendingResp) {
        const wanted = schemaPatterns.length === 0
            || schemaPatterns.some(pat => new RegExp(pat).test(r.url));
        const rec = { url: r.url, status: r.status, mimeType: r.mimeType, types: null };
        if (wanted && /json/.test(r.mimeType ?? '')) {
            try {
                const body = await session.send('Network.getResponseBody', { requestId: r.requestId });
                if (body.body) rec.types = flattenTypes(JSON.parse(body.body));
            } catch { /* body 已被回收或不是 JSON,留 null */ }
        }
        responses.push(rec);
    }

    return { network, console: console_, responses };
}

/** 产物文件检查(可选观测点) */
async function checkArtifacts(list = []) {
    const out = [];
    for (const a of list) {
        const path = a.path;
        let exists = false, bytes = 0;
        try {
            const st = await stat(path);
            exists = st.isFile();
            bytes = st.size;
        } catch { /* 不存在 */ }
        out.push({ path, exists, bytes, minBytes: a.minBytes ?? 1 });
    }
    return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, '--help') || argv.length === 0) {
        console.log(`behavior-collect · 路线 E 行为契约采集

用法:
  node scripts/behavior-collect.mjs --url <url> --behavior <behavior.json>
       --side <expected|actual> [--wait <sel>] [--settle <ms>] --out <file>

只采集事实,不做断言。断言写在 behavior 配置的 expect 里,
由 behavior-diff 让两侧各自对照同一份断言。

观测点: network(方法/URL/body 字段) · console(埋点) ·
        响应 schema(字段存在性+类型,不断言业务数值) · artifacts(产物文件)

退出码: 0=采集完成 | 1=执行错误(含采集为空)
`);
        return 0;
    }

    const url = argValue(argv, '--url');
    const behaviorPath = argValue(argv, '--behavior');
    const side = argValue(argv, '--side', 'actual');
    const outPath = argValue(argv, '--out');
    const settle = argNumber(argv, '--settle', 800);
    const waitSel = argValue(argv, '--wait', undefined);
    const debug = hasFlag(argv, '--debug');

    if (!url || !behaviorPath || !outPath) {
        console.error('缺少必需参数:--url / --behavior / --out');
        return 1;
    }

    const behavior = JSON.parse(await (await import('node:fs/promises')).readFile(behaviorPath, 'utf8'));
    const steps = behavior.steps ?? [];
    if (steps.length === 0) {
        console.error('执行错误:behavior 配置里没有 steps —— 空配置不代表"无行为",拒绝产出空报告');
        return 1;
    }

    let result;
    try {
        result = await withSession(async (session) => {
            await fixViewport(session);
            await navigateAndWait(session, url);
            if (waitSel) await waitForSelector(session, waitSel);
            await waitRAF(session);

            const schemaPatterns = [];
            for (const s of steps) {
                for (const sc of (s.expect?.schema ?? [])) {
                    if (sc.urlPattern) schemaPatterns.push(sc.urlPattern);
                }
            }

            const outSteps = [];
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                const cursor = session.events.length;
                await doAction(session, step);
                await sleep(step.settleMs ?? settle);
                await waitRAF(session);

                const obs = await observeSince(session, cursor, { schemaPatterns });
                const artifacts = await checkArtifacts(step.artifacts ?? []);

                outSteps.push({
                    index: i,
                    label: step.label ?? `step-${i}`,
                    network: obs.network,
                    console: obs.console,
                    responses: obs.responses,
                    artifacts,
                    // P1-5 证据等级:行为观测的来源是网络与 console
                    evidence: obs.network.length || obs.responses.length
                        ? (obs.console.length ? 'network+console' : 'network')
                        : (obs.console.length ? 'console' : 'none'),
                    confidence: obs.network.length || obs.console.length || obs.responses.length
                        ? 'high' : 'low',
                });
            }
            return { side, url, behavior: behavior.name ?? '', steps: outSteps };
        });
    } catch (err) {
        console.error(`执行错误: ${err.message}`);
        if (debug) console.error(err.stack);
        return 1;
    }

    // P0-1 原则 8:空结果不是无差异。三步以上却一条观测都没有 = 采集失败
    const totalObs = result.steps.reduce(
        (n, s) => n + s.network.length + s.console.length + s.responses.length, 0);
    if (totalObs === 0) {
        console.error('执行错误:全程未观测到任何网络请求 / console / 响应 —— '
            + '这更可能是采集没工作(页面未加载?选择器没命中?事件未开启),而不是"没有行为"');
        return 1;
    }

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(result, null, 2), 'utf8');

    const nNet = result.steps.reduce((n, s) => n + s.network.length, 0);
    const nCon = result.steps.reduce((n, s) => n + s.console.length, 0);
    const nRes = result.steps.reduce((n, s) => n + s.responses.length, 0);
    console.log(`behavior-collect [${side}] 步骤 ${result.steps.length} · `
        + `请求 ${nNet} · console ${nCon} · 响应 ${nRes} → ${outPath}`);
    return 0;
}

process.exit(await main());
