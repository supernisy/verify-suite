#!/usr/bin/env node
// verify-suite / scripts / trace-run.mjs
//
// 交互还原 —— 执行轨迹 + 逐步状态快照。
//
// 用法:
//   node scripts/trace-run.mjs --url <url> --trace <trace.json> --side <expected|actual>
//        [--basename <str>] [--preload <js>] [--wait <sel>] [--viewport] --out <file>
//
// 验的是状态之间的迁移(点击后该跳转没跳转、选中态该切没切、弹层该开没开),
// 静态比对完全抓不到。
//
// 两个关键设计:
//   ① target 用语义指纹,不用 selector → 一份轨迹两侧共用
//   ② ★★ 判据是「两侧各自对照同一份语义断言」,不是「两侧的 diff 是否相同」
//      (两侧数据量不同时,"比变化量是否一致"不是可判定命题 —— 实测 82 项噪声)

import { argValue, hasFlag, argNumber } from './lib/args.mjs';
import {
    withSession, fixViewport, addPreload,
    navigateAndWait, waitForSelector, waitForUrlContains, waitRAF, sleep,
    norm, gridKey,
} from './lib/cdp.mjs';

const SEMANTIC_ROLES = new Set([
    'button', 'link', 'menuitem', 'tab', 'textbox', 'heading', 'checkbox', 'radio',
    'switch', 'combobox', 'option', 'searchbox', 'navigation', 'complementary',
    'main', 'banner', 'contentinfo', 'region', 'form', 'group', 'article',
    'section', 'toolbar', 'menu', 'menubar', 'tablist', 'table', 'row', 'grid',
    'tree', 'list', 'listitem', 'alert', 'dialog', 'tooltip', 'img', 'figure', 'status',
]);

/** 视觉状态指纹:只关心"有没有变化",不关心变成什么颜色(那是路线 B 的事) */
const VISUAL_FP_FN = `function(){
    const cs = getComputedStyle(this);
    return [cs.backgroundColor, cs.fontWeight, cs.boxShadow, cs.color, cs.borderColor].join('|');
}`;

/**
 * 采集语义快照:{ fp → { visualFp, rect } }
 * ★ 无名节点(指纹退化为 role|)全程排除 —— 它们随数据量变化,会污染迁移判定
 */
async function snapshot(session) {
    const ax = await session.send('Accessibility.getFullAXTree');
    const nodes = (ax.nodes ?? []).filter(n =>
        !n.ignored && n.backendDOMNodeId && SEMANTIC_ROLES.has(n.role?.value));

    const map = new Map();
    const counters = new Map();
    const items = [];
    for (const n of nodes) {
        let obj;
        try {
            const r = await session.send('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId });
            obj = r.object;
        } catch { continue; }
        if (!obj?.objectId) continue;

        const name = n.name?.value ?? '';
        const normName = norm(name);
        if (!normName) continue;                       // ★ 排除无名节点
        const fp = `${n.role?.value}|${normName}`;
        const c = counters.get(fp) ?? 0;
        counters.set(fp, c + 1);

        let rect = null, visualFp = null;
        try {
            const rr = await session.send('Runtime.callFunctionOn', {
                objectId: obj.objectId,
                functionDeclaration: `function(){ const r = this.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; }`,
                returnByValue: true,
            });
            rect = rr.result?.value;
            const vr = await session.send('Runtime.callFunctionOn', {
                objectId: obj.objectId,
                functionDeclaration: `(${VISUAL_FP_FN})`,
                returnByValue: true,
            });
            visualFp = vr.result?.value;
        } catch { continue; }

        // 编号后缀(用网格量化保证稳定)
        const g = rect ? gridKey(rect) : { gy: 0, gx: 0 };
        items.push({ fp: `${fp}#${c}`, role: n.role?.value, name: name.slice(0, 80), visualFp, rect, g });
    }
    for (const it of items) map.set(it.fp, it);
    return { map, items };
}

/** 用指纹定位元素并点击(支持 "button|定时任务" 或 "text:文案" 兜底) */
async function clickTarget(session, target) {
    if (target.startsWith('text:')) {
        const t = target.slice(5);
        const r = await session.send('Runtime.evaluate', {
            expression: `(() => { const all = Array.from(document.querySelectorAll('*')); const e = all.find(x => x.children.length === 0 && (x.innerText||x.textContent||'').trim() === ${JSON.stringify(t)}); return e ? true : false; })()`,
            returnByValue: true,
        });
        if (!r.result?.value) throw new Error(`text target not found: ${t}`);
        await session.send('Runtime.evaluate', {
            expression: `(() => { const all = Array.from(document.querySelectorAll('*')); const e = all.find(x => x.children.length === 0 && (x.innerText||x.textContent||'').trim() === ${JSON.stringify(t)}); e.scrollIntoView({block:'center'}); e.click(); })()`,
        });
        return;
    }
    // 语义指纹:role|normName
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
    await session.send('Runtime.callFunctionOn', {
        objectId: obj.objectId,
        functionDeclaration: 'function(){ this.scrollIntoView({block:"center"}); }',
    });
    await waitRAF(session);
    await session.send('Runtime.callFunctionOn', {
        objectId: obj.objectId,
        functionDeclaration: 'function(){ this.click(); }',
    });
}

/** URL 归一化(★ --basename 必需:产线常带子应用前缀) */
function normalizeUrl(session, basename) {
    return session.evalAsync(`(() => {
        let p = location.pathname;
        const bn = ${JSON.stringify(basename ?? '')};
        if (bn && p.startsWith(bn)) p = p.slice(bn.length);
        return (p === '' ? '/' : p) + location.search + location.hash;
    })()`);
}

async function main() {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, '--help') || argv.length === 0) {
        console.log(`trace-run · 交互轨迹执行 + 状态快照

用法:
  node scripts/trace-run.mjs --url <url> --trace <trace.json> --side <expected|actual>
       [--basename <str>] [--preload <js>] [--wait <sel>] [--viewport]
       [--no-progress-k <n>] --out <file>

--no-progress-k  连续 n 步语义快照完全相同时判定为「卡住」并中止(默认 3)。
                 防止点击没生效却跑完全程、产出一串假的「未达成」。

轨迹格式:
{
  "steps": [
    {
      "action": "click",
      "target": "button|定时任务",
      "label": "导航到定时任务",
      "await": { "urlContains": "task-center" },
      "settleMs": 800,
      "expect": {
        "urlTail": "task-center",
        "appeared": ["heading|定时任务", "button|创建任务"],
        "disappeared": ["heading|数字员工"],
        "visualChanged": ["button|定时任务"]
      }
    }
  ]
}

要点:
  - target 用语义指纹(role|文案),不用 selector → 一份轨迹两侧共用
  - --basename 必需:两侧 URL 前缀不同时,不归一化没法比路由
  - 无名节点全程排除(role| 或纯编号后缀):它们随数据量变化,会污染迁移判定
  - visualChanged 比视觉指纹是否【变化】,不关心变成什么颜色
`);
        return;
    }

    const url = argValue(argv, '--url');
    const tracePath = argValue(argv, '--trace');
    const side = argValue(argv, '--side', 'actual');
    const basename = argValue(argv, '--basename', '');
    const preload = argValue(argv, '--preload');
    const waitSel = argValue(argv, '--wait');
    const outPath = argValue(argv, '--out');

    if (!url) throw new Error('--url required');
    if (!tracePath) throw new Error('--trace required');

    const fs = await import('node:fs/promises');
    const trace = JSON.parse(await fs.readFile(tracePath, 'utf8'));
    const steps = trace.steps ?? [];

    const result = await withSession(async (session) => {
        await fixViewport(session);
        if (preload) await addPreload(session, preload);
        await navigateAndWait(session, url);
        if (waitSel) await waitForSelector(session, waitSel);
        await waitRAF(session);

        const stepResults = [];
        let prev = await snapshot(session);

        // P2-6 无进展检测:连续 K 步语义快照完全相同 = 页面卡住了
        // (点击没生效 / 路由没跳转 / 弹层挡住了)。继续跑完只会得到一串
        // 「未达成」的假结论 —— 真因是执行卡住,不是实现有差异。
        const noProgressK = argNumber(argv, '--no-progress-k', 3);
        const snapHistory = [];

        for (let i = 0; i < steps.length; i++) {
            const st = steps[i];
            const assertions = [];
            const before = prev;

            // 1. 执行动作
            try {
                if (st.action === 'click') {
                    await clickTarget(session, st.target);
                } else if (st.action === 'hover') {
                    const [role, ...rest] = (st.target ?? '').split('|');
                    // 简化:先按文案找中心点再派发 mouseMoved(★ 内核级事件才能触发 CSS :hover)
                    const c = await session.evalAsync(`(() => {
                        const all = Array.from(document.querySelectorAll('*'));
                        const e = all.find(x => x.children.length === 0 && (x.innerText||x.textContent||'').trim() === ${JSON.stringify(rest.join('|'))});
                        if (!e) return null;
                        const r = e.getBoundingClientRect();
                        return { x: r.left + r.width/2, y: r.top + r.height/2 };
                    })()`);
                    if (c) await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
                } else if (st.action === 'keypress') {
                    const key = st.target ?? 'Enter';
                    const codes = { Enter: 13, Escape: 27, Tab: 9 };
                    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: codes[key] ?? key.charCodeAt(0) });
                    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: codes[key] ?? key.charCodeAt(0) });
                } else if (st.action === 'goto') {
                    await navigateAndWait(session, st.target);
                } else if (st.action === 'type') {
                    await session.send('Input.insertText', { text: st.value ?? '' });
                }
            } catch (e) {
                assertions.push({ kind: 'action', target: st.target, ok: false, detail: e.message });
            }

            // 2. 等终态
            try {
                if (st.await?.urlContains) await waitForUrlContains(session, st.await.urlContains);
                if (st.await?.selector) await waitForSelector(session, st.await.selector);
            } catch (_) { /* 终态未达成本身就是断言失败的信号,交给 expect 判定 */ }

            await sleep(Number(st.settleMs ?? 300));
            await waitRAF(session);

            // 3. 采 after 快照 + URL
            const after = await snapshot(session);
            const path = await normalizeUrl(session, basename);
            prev = after;

            // 4. 判定 expect
            const ex = st.expect ?? {};
            if (ex.urlTail != null) {
                const ok = path.includes(ex.urlTail);
                assertions.push({ kind: 'urlTail', expect: ex.urlTail, actual: path, ok });
            }
            for (const fp of (ex.appeared ?? [])) {
                const key = fp.replace(/#\d+$/, '');
                const hit = [...after.map.keys()].some(k => k.replace(/#\d+$/, '') === key);
                const had = [...before.map.keys()].some(k => k.replace(/#\d+$/, '') === key);
                assertions.push({ kind: 'appeared', target: fp, ok: hit && !had, detail: hit ? (had ? '步骤前已存在' : 'ok') : '未出现' });
            }
            for (const fp of (ex.disappeared ?? [])) {
                const key = fp.replace(/#\d+$/, '');
                const had = [...before.map.keys()].some(k => k.replace(/#\d+$/, '') === key);
                const still = [...after.map.keys()].some(k => k.replace(/#\d+$/, '') === key);
                assertions.push({ kind: 'disappeared', target: fp, ok: had && !still, detail: !had ? '步骤前本就不存在' : (still ? '仍未消失' : 'ok') });
            }
            for (const fp of (ex.visualChanged ?? [])) {
                const key = fp.replace(/#\d+$/, '');
                const b = [...before.map.entries()].find(([k]) => k.replace(/#\d+$/, '') === key)?.[1];
                const a = [...after.map.entries()].find(([k]) => k.replace(/#\d+$/, '') === key)?.[1];
                const ok = !!(b && a && b.visualFp !== a.visualFp);
                assertions.push({ kind: 'visualChanged', target: fp, ok, detail: !b ? '步骤前未找到' : (!a ? '步骤后未找到' : (ok ? 'ok' : '视觉指纹未变化')) });
            }

            stepResults.push({
                index: i,
                label: st.label ?? `${st.action} ${st.target}`,
                action: st.action,
                path,
                nodesAfter: after.items.length,
                // P1-5 证据等级:轨迹断言建立在语义快照(AX 树指纹)之上。
                // 快照节点过少 = 这一页没被语义化,断言其实没有证据支撑。
                evidence: 'ax-tree',
                confidence: after.items.length >= 3 ? 'high' : 'medium',
                assertions,
                allOk: assertions.every(a => a.ok),
            });

            // P2-6:这一步跑完了,检查是否卡住
            snapHistory.push(after.items.map(x => `${x.fp}#${x.fpIndex}`).join('|'));
            if (snapHistory.length >= noProgressK) {
                const tail = snapHistory.slice(-noProgressK);
                if (tail.every(s => s === tail[0])) {
                    throw new Error(
                        `无进展:连续 ${noProgressK} 步语义快照完全相同(第 ${i - noProgressK + 2}~${i + 1} 步)`
                        + ` — 页面可能卡住(点击未生效 / 路由未跳转 / 被弹层遮挡)。`
                        + `继续执行只会产出假结论,已中止。可调大 --no-progress-k 放宽`);
                }
            }
        }

        return {
            side, url, basename,
            collectedAt: new Date().toISOString(),
            steps: stepResults,
            evidence: {
                primary: 'ax-tree',
                confidence: stepResults.every(s => s.confidence === 'high') ? 'high' : 'medium',
            },
            // P1-5 降级留痕:某步快照节点过少,说明这一步的断言没有足够证据
            degradation: stepResults.some(s => s.confidence === 'medium') ? {
                from: 'ax-tree',
                to: 'text-skeleton',
                reason: `有步骤的语义快照节点数 < 3（${stepResults.filter(s => s.confidence === 'medium').map(s => s.label).join(', ')}）— 该步断言依据不足`,
            } : null,
        };
    });

    const total = result.steps.reduce((s, x) => s + x.assertions.length, 0);
    const failed = result.steps.reduce((s, x) => s + x.assertions.filter(a => !a.ok).length, 0);
    result.totalAssertions = total;
    result.failedAssertions = failed;

    const json = JSON.stringify(result, null, 2);
    if (outPath) {
        await fs.writeFile(outPath, json);
        console.log(`trace-run: ${side} · ${result.steps.length} 步 · ${total} 条断言 · 未达成 ${failed} → ${outPath}`);
        for (const s of result.steps) {
            const bad = s.assertions.filter(a => !a.ok);
            console.log(`  ${bad.length === 0 ? '✅' : '❌'} [${s.index}] ${s.label}  (${s.assertions.length} 断言${bad.length ? `, ${bad.length} 未达成` : ''})`);
            for (const b of bad) console.log(`       ❌ ${b.kind} ${b.target ?? b.expect ?? ''} ${b.detail ?? ''}`);
        }
    } else {
        console.log(json);
    }
}

main().catch(err => {
    console.error('error:', err.message ?? err);
    if (process.env.VERIFY_DEBUG) console.error(err.stack);
    process.exit(1);
});
