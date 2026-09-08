#!/usr/bin/env node
// verify-suite / scripts / probe-layer.mjs
//
// 层级归属判定 + 弹层定位与可见性判定。
//
// 用法:
//   probe-layer --url <url> [--wait <sel>] --list                      列出所有真可点单元
//   probe-layer --url <url> --text "<文案>" [--out <file>]              A: 层级归属
//   probe-layer --url <url> --popup "<文案|CSS selector>" [--out <f>]   B: 弹层定位
//
// A. 哪一层是按钮:多信号交集 + 就近优先
//    信号权重:① 挂了点击处理器 ★★★★★ ② pointer 链的根 ★★★★☆
//             ③ 有视觉边界 ★★★☆☆(单独不够,外层 aside 也有底色)
//             ④ 面积倍数"紧贴内容" ★★★☆☆(按钮 2.8x、容器 8x 起跳)
//    就近优先:从文本往上,第一个同时满足 ①②③ 的层
//
// ★  hover 变化这条判据不稳定(CSS :hover / JS onMouseEnter / group-hover 三种实现
//    对 CDP 事件响应完全不同),只能作辅助信息输出,不能作层级主判据。
// ★★ 真正的风险不是判不准,是【探测完不复位会污染后续所有校验】
//    → 检测到未复位必须打印告警:"跑其它校验前先 reload"

import { argValue, hasFlag } from './lib/args.mjs';
import {
    withSession, fixViewport, addPreload,
    navigateAndWait, waitForSelector, waitRAF, checkVisibility, sleep,
} from './lib/cdp.mjs';

// ---------------------------------------------------------------------------
// 页面内辅助函数
// ---------------------------------------------------------------------------

const LAYERS_FN = `function(targetText){
    const NATIVE = ['button','a','input','select','textarea','summary'];
    const strip = s => String(s || '').replace(/\\s/g, '');
    const txtOf = e => (e.innerText || e.textContent || '');
    const t = (targetText || '').trim();

    // 找持有该文案的最内层元素
    let target = null;
    const all = Array.from(document.querySelectorAll('*'));
    const exact = all.filter(e => e.children.length === 0 && (e.innerText || e.textContent || '').trim() === t);
    if (exact.length) target = exact[0];
    if (!target){
        const contains = all.filter(e => (e.innerText || e.textContent || '').trim().includes(t));
        // 取最深的
        let best = null, bestDepth = -1;
        for (const e of contains){
            let d = 0, c = e; while (c.parentElement){ d++; c = c.parentElement; }
            if (d > bestDepth){ bestDepth = d; best = e; }
        }
        target = best;
    }
    if (!target) return { error: 'text not found: ' + t };

    function signals(el){
        const keys = Object.keys(el);
        const k = keys.find(x => x.indexOf('__reactProps$') === 0);
        const p = k ? el[k] : null;
        const hasClick = !!(p && (p.onClick || p.onMouseDown)) || NATIVE.indexOf(el.tagName.toLowerCase()) >= 0;
        let isPointer = false, parentPointer = false;
        try { isPointer = getComputedStyle(el).cursor === 'pointer'; } catch(_) {}
        try { parentPointer = el.parentElement ? getComputedStyle(el.parentElement).cursor === 'pointer' : false; } catch(_) {}
        const pointerRoot = isPointer && !parentPointer;
        let visualBox = false;
        try {
            const cs = getComputedStyle(el);
            visualBox = (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent')
                || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0
                || parseFloat(cs.borderTopLeftRadius) > 0 || (cs.boxShadow && cs.boxShadow !== 'none');
        } catch(_) {}
        return { hasClick, pointerRoot, visualBox };
    }

    const layers = [];
    const baseRect = target.getBoundingClientRect();
    const baseArea = Math.max(1, baseRect.width * baseRect.height);
    let cur = target;
    for (let i = 0; i < 8; i++){
        const r = cur.getBoundingClientRect();
        const area = r.width * r.height;
        layers.push({
            depth: i,
            tag: cur.tagName.toLowerCase(),
            cls: (typeof cur.className === 'string' ? cur.className : '').split(/\\s+/).filter(Boolean).slice(0, 2).join('.'),
            size: Math.round(r.width) + 'x' + Math.round(r.height),
            areaX: Math.round(area / baseArea * 10) / 10,
            ...signals(cur),
            __el: cur,
        });
        if (cur.tagName.toLowerCase() === 'body') break;
        cur = cur.parentElement;
        if (!cur) break;
    }

    // 存引用,避免用路径重查(★ 路径只取 6 段会匹配错元素)
    window.__probeLayers = layers;
    window.__probeTargetRect = { x: baseRect.left + baseRect.width / 2, y: baseRect.top + baseRect.height / 2 };

    return {
        layers: layers.map(l => ({ depth: l.depth, tag: l.tag, cls: l.cls, size: l.size, areaX: l.areaX, hasClick: l.hasClick, pointerRoot: l.pointerRoot, visualBox: l.visualBox })),
        targetRect: window.__probeTargetRect,
    };
}`;

/** 记录每层样式快照(用于 hover 变化 / 复位检测) */
const SNAP_FN = `function(){
    if (!window.__probeLayers) return null;
    return window.__probeLayers.map(l => {
        try {
            const cs = getComputedStyle(l.__el);
            return [cs.backgroundColor, cs.color, cs.borderColor, cs.transform, cs.opacity, cs.boxShadow].join('|');
        } catch(_) { return ''; }
    });
}`;

/** 弹层候选集:只认物理特征,不认 class */
const POPUP_SCAN_FN = `function(){
    const all = Array.from(document.querySelectorAll('*'));
    const out = [];
    for (const el of all){
        let cs;
        try { cs = getComputedStyle(el); } catch(_) { continue; }
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        const z = parseInt(cs.zIndex, 10);
        if (!Number.isFinite(z) || z < 1) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) continue;
        const area = r.width * r.height;
        const vArea = window.innerWidth * window.innerHeight;
        const text = (el.innerText || el.textContent || '').trim().slice(0, 100);
        out.push({
            z, position: cs.position,
            rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
            coverage: Math.round(area / vArea * 100) / 100,
            text: text.slice(0, 80),
            hasText: text.length > 0,
            depth: (() => { let d = 0, c = el; while (c.parentElement){ d++; c = c.parentElement; } return d; })(),
            __el: el,
        });
    }
    return out;
}`;

async function findByTextOrSelector(session, spec) {
    // --popup 先按文案找,找不到才当 selector
    const r = await session.send('Runtime.evaluate', {
        expression: `(() => {
            const t = ${JSON.stringify(spec)};
            const all = Array.from(document.querySelectorAll('*'));
            const leaf = all.find(e => e.children.length === 0 && (e.innerText || e.textContent || '').trim() === t);
            if (leaf) return { found: 'text', rect: leaf.getBoundingClientRect().toJSON() };
            const contains = all.filter(e => (e.innerText || e.textContent || '').trim().includes(t));
            if (contains.length) {
                let best = contains[0], bd = -1;
                for (const e of contains){ let d=0,c=e; while(c.parentElement){d++;c=c.parentElement;} if(d>bd){bd=d;best=e;} }
                return { found: 'text-contains', rect: best.getBoundingClientRect().toJSON() };
            }
            const bySel = document.querySelector(t);
            if (bySel) return { found: 'selector', rect: bySel.getBoundingClientRect().toJSON() };
            return { found: null };
        })()`,
        returnByValue: true,
    });
    return r.result?.value;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, '--help') || argv.length === 0) {
        console.log(`probe-layer · 层级归属 + 弹层定位

用法:
  probe-layer --url <url> [--wait <sel>] [--viewport] [--out <file>]
      --list                        列出所有真可点单元
      --text "<文案>"                A: 层级归属(哪一层才是按钮)
      --popup "<文案|CSS selector>"  B: 弹层定位(点击后新增了什么)

A 的信号权重:
  ① 挂了点击处理器 ★★★★★
  ② pointer 链的根 ★★★★☆
  ③ 有视觉边界     ★★★☆☆ (单独不够 —— 外层 aside 也有底色)
  ④ 面积倍数紧贴   ★★★☆☆ (按钮 2.8x、容器 8x 起跳)
  就近优先:从文本往上,第一个同时满足 ①②③ 的层

B 的弹层识别:只认物理特征(position ∈ {fixed,absolute} + z-index ≥1 + 面积 >40x40)
  遮罩 = 覆盖率 >0.8 且无文本;弹层主体 = 其余中面积最大的

★  hover 变化只作辅助信息(三种实现对 CDP 响应不同),不作层级主判据
★★ 探测完不复位会污染后续所有校验 —— 未复位时会告警"跑其它校验前先 reload"
`);
        return;
    }

    const url = argValue(argv, '--url');
    const waitSel = argValue(argv, '--wait');
    const outPath = argValue(argv, '--out');
    const mode = hasFlag(argv, '--list') ? 'list'
        : argv.includes('--text') ? 'layer'
        : argv.includes('--popup') ? 'popup'
        : null;
    const textSpec = argValue(argv, '--text');
    const popupSpec = argValue(argv, '--popup');

    if (!url) throw new Error('--url required');
    if (!mode) throw new Error('需要 --list / --text "<文案>" / --popup "<文案|selector>" 之一');

    const result = await withSession(async (session) => {
        await fixViewport(session);
        await navigateAndWait(session, url);
        if (waitSel) await waitForSelector(session, waitSel);
        await waitRAF(session);

        // ---- 模式 1:列出真可点单元 ----
        if (mode === 'list') {
            const r = await session.evalAsync(`(() => {
                const NATIVE = ['button','a','input','select','textarea','summary'];
                const strip = s => String(s||'').replace(/\\s/g,'');
                const out = [];
                for (const el of Array.from(document.querySelectorAll('*'))){
                    const keys = Object.keys(el);
                    const k = keys.find(x => x.indexOf('__reactProps$') === 0);
                    const p = k ? el[k] : null;
                    const hasClick = !!(p && (p.onClick || p.onMouseDown)) || NATIVE.indexOf(el.tagName.toLowerCase()) >= 0;
                    let isPointer=false, pp=false;
                    try { isPointer = getComputedStyle(el).cursor==='pointer'; } catch(_){}
                    try { pp = el.parentElement ? getComputedStyle(el.parentElement).cursor==='pointer' : false; } catch(_){}
                    if (!hasClick && !(isPointer && !pp)) continue;
                    const rect = el.getBoundingClientRect();
                    if (rect.width===0 && rect.height===0) continue;
                    out.push({
                        tag: el.tagName.toLowerCase(),
                        text: (el.innerText||el.textContent||'').trim().slice(0,60),
                        size: Math.round(rect.width)+'x'+Math.round(rect.height),
                        at: Math.round(rect.left)+','+Math.round(rect.top),
                        kind: hasClick ? 'click' : 'pointer',
                    });
                }
                return out;
            })()`);
            return { mode, units: r };
        }

        // ---- 模式 2:层级归属 ----
        if (mode === 'layer') {
            const r = await session.evalAsync(`(${LAYERS_FN})(${JSON.stringify(textSpec)})`);
            if (r?.error) throw new Error(r.error);

            const center = r.targetRect;
            // hover 探测(辅助信息)
            const s0 = await session.evalAsync(`(${SNAP_FN})()`);
            await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y });
            await sleep(150);
            const s1 = await session.evalAsync(`(${SNAP_FN})()`);
            // 移开,检查复位
            await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
            await sleep(150);
            const s2 = await session.evalAsync(`(${SNAP_FN})()`);

            const hoverChanged = s0.map((v, i) => v !== s1[i]);
            const restored = s0.map((v, i) => v === s2[i]);
            const anyNotRestored = restored.some((v, i) => hoverChanged[i] && !v);
            const anyHover = hoverChanged.some(Boolean);

            return {
                mode,
                target: textSpec,
                layers: r.layers,
                hover: { changed: hoverChanged, restored, anyHover, anyNotRestored },
                warnings: anyNotRestored ? ['hover 探测后样式未复位 —— 跑其它校验前先 reload'] : [],
            };
        }

        // ---- 模式 3:弹层定位 ----
        if (mode === 'popup') {
            const found = await findByTextOrSelector(session, popupSpec);
            if (!found?.found) throw new Error(`--popup 目标未找到: ${popupSpec}`);
            const c = { x: found.rect.left + found.rect.width / 2, y: found.rect.top + found.rect.height / 2 };

            // 点击前先派发 mouseover(★ 很多"更多"按钮是 opacity-0 + group-hover 才显现)
            await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
            await sleep(120);

            // S0
            await session.evalAsync(`window.__popupS0 = (${POPUP_SCAN_FN})(); 0`);
            const before = await session.evalAsync(`window.__popupS0.map(p => ({z:p.z,position:p.position,rect:p.rect,coverage:p.coverage,text:p.text,hasText:p.hasText,depth:p.depth}))`);

            // 点击
            await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
            await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
            await sleep(500);
            await waitRAF(session);

            // S1
            await session.evalAsync(`window.__popupS1 = (${POPUP_SCAN_FN})(); 0`);
            const after = await session.evalAsync(`window.__popupS1.map(p => ({z:p.z,position:p.position,rect:p.rect,coverage:p.coverage,text:p.text,hasText:p.hasText,depth:p.depth}))`);

            // 新增 = S1 − S0(按 z + rect 签名比对)
            const sig = (p) => `${p.z}|${p.rect.left},${p.rect.top},${p.rect.width},${p.rect.height}`;
            const set0 = new Set(before.map(sig));
            const added = after.filter(p => !set0.has(sig(p)));

            const masks = added.filter(p => p.coverage > 0.8 && !p.hasText);
            const bodies = added.filter(p => !(p.coverage > 0.8 && !p.hasText))
                .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));

            return { mode, target: popupSpec, foundBy: found.found, before: before.length, after: after.length, added, mask: masks[0] ?? null, popupBody: bodies[0] ?? null };
        }
    });

    // ---- 输出 ----
    if (result.mode === 'list') {
        console.log(`真可点单元: ${result.units.length} 个\n`);
        console.log(`  ${'标签'.padEnd(10)} ${'类型'.padEnd(8)} ${'尺寸'.padEnd(12)} ${'位置'.padEnd(12)} 文案`);
        for (const u of result.units.slice(0, 60)) {
            console.log(`  ${u.tag.padEnd(10)} ${u.kind.padEnd(8)} ${u.size.padEnd(12)} ${u.at.padEnd(12)} ${u.text}`);
        }
        if (result.units.length > 60) console.log(`  ... 还有 ${result.units.length - 60} 个`);
    } else if (result.mode === 'layer') {
        const L = result.layers;
        // 就近优先:第一个同时满足 hasClick + pointerRoot + visualBox 的层
        const hitIdx = L.findIndex(l => l.hasClick && l.pointerRoot && l.visualBox);
        const hitIdx2 = hitIdx >= 0 ? hitIdx : L.findIndex(l => l.hasClick && l.pointerRoot);
        console.log(`层级归属 · 目标文案 "${result.target}"\n`);
        console.log(`  ${'层'.padEnd(4)}${'标签'.padEnd(12)}${'尺寸'.padEnd(12)}${'面积倍数'.padEnd(10)}${'onClick'.padEnd(9)}${'pointer根'.padEnd(10)}${'视觉边界'.padEnd(10)}${'hover变'.padEnd(8)}${'复位'.padEnd(6)}判定`);
        L.forEach((l, i) => {
            const hv = result.hover.changed[i] ? '变化' : '·';
            const rs = result.hover.changed[i] ? (result.hover.restored[i] ? '✓' : '✗') : '·';
            const judge = i === 0 ? '文本自身'
                : (hitIdx2 === i ? '★ 就是它' : (l.areaX >= 8 ? '容器' : '排版容器'));
            console.log(`  ${String(l.depth).padEnd(4)}${(l.tag + (l.cls ? '.' + l.cls : '')).slice(0, 11).padEnd(12)}${l.size.padEnd(12)}${(l.areaX + 'x').padEnd(10)}${(l.hasClick ? '✓' : '·').padEnd(9)}${(l.pointerRoot ? '✓' : '·').padEnd(10)}${(l.visualBox ? '✓' : '·').padEnd(10)}${hv.padEnd(8)}${rs.padEnd(6)}${judge}`);
        });
        console.log('');
        if (hitIdx2 >= 0) {
            console.log(`  结论:第 ${L[hitIdx2].depth} 层是交互单元(${L[hitIdx2].tag},面积倍数 ${L[hitIdx2].areaX}x)`);
        } else {
            console.log(`  ⚠ 未找到同时满足 onClick + pointer 根 + 视觉边界的层`);
        }
        if (!result.hover.anyHover) {
            console.log(`  ⓘ hover 探测:没有层的样式发生变化(可能是 group-hover 加在子元素上,或 JS 实现未响应)`);
        }
        for (const w of result.warnings) console.log(`  ⚠⚠ ${w}`);
    } else if (result.mode === 'popup') {
        console.log(`弹层定位 · 目标 "${result.target}" (按 ${result.foundBy} 定位)\n`);
        console.log(`  点击前候选 ${result.before} 个 → 点击后 ${result.after} 个,新增 ${result.added.length} 个\n`);
        for (const p of result.added) {
            const role = (p.coverage > 0.8 && !p.hasText) ? '遮罩' : '弹层主体候选';
            console.log(`  z=${p.z} ${p.position} 位置 ${p.rect.left},${p.rect.top},${p.rect.width},${p.rect.height} 覆盖率 ${p.coverage} DOM深度 ${p.depth}`);
            console.log(`      文本 "${p.text}"  → ${role}`);
        }
        if (result.popupBody) {
            console.log(`\n  判定弹层主体: z=${result.popupBody.z} @${result.popupBody.rect.left},${result.popupBody.rect.top} ${result.popupBody.rect.width}x${result.popupBody.rect.height}`);
            console.log(`      文本 "${result.popupBody.text}"`);
        }
        if (result.mask) console.log(`  判定遮罩: z=${result.mask.z} 覆盖率 ${result.mask.coverage}`);
        if (result.added.length === 0) console.log(`  ⚠ 点击后无新增弹层 —— 可能未触发,或弹层未用 fixed/absolute + z-index 实现`);
    }

    if (outPath) {
        const fs = await import('node:fs/promises');
        await fs.writeFile(outPath, JSON.stringify(result, null, 2));
        console.log(`\n已保存: ${outPath}`);
    }
}

main().catch(err => {
    console.error('error:', err.message ?? err);
    if (process.env.VERIFY_DEBUG) console.error(err.stack);
    process.exit(1);
});
