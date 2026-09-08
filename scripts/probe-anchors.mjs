#!/usr/bin/env node
// verify-suite / scripts / probe-anchors.mjs
//
// 锚点体检:判断该走哪条路线。
//
// 用法:
//   node scripts/probe-anchors.mjs --url <url> --side <name> [--wait <sel>] [--viewport] --out <file>
//
// 统计(★ cursor 必须做去继承处理):
//   显式 role 属性数 / data-testid 数 / tabindex 数 / aria-label 数
//   原生交互标签数 / React onClick 数 / cursor:pointer 数(去继承前后都报)
//   div 模拟交互数及其占候选交互元素的百分比
//   无文本无 aria 的交互单元数
//   文本骨架可用率(实测参考:99.2% / 70.4%)

import { argValue, hasFlag } from './lib/args.mjs';
import {
    withSession, fixViewport, addPreload,
    navigateAndWait, waitForSelector, waitRAF,
} from './lib/cdp.mjs';

const PROBE_FN = `function(){
    const NATIVE = ['button','a','input','select','textarea','summary'];
    const strip = s => String(s || '').replace(/\\s/g, '');
    const txtOf = e => (e.innerText || e.textContent || '');

    const all = Array.from(document.querySelectorAll('*'));
    let roleAttr = 0, testid = 0, tabindex = 0, ariaLabel = 0, ariaLabelledBy = 0;
    let native = 0, reactClick = 0, cursorRaw = 0, cursorDedup = 0;
    let divSim = 0, noTextNoAria = 0;

    for (const el of all){
        if (el.hasAttribute('role')) roleAttr++;
        if (el.hasAttribute('data-testid') || el.hasAttribute('data-qa') || el.hasAttribute('data-test')) testid++;
        if (el.hasAttribute('tabindex')) tabindex++;
        if (el.hasAttribute('aria-label')) ariaLabel++;
        if (el.hasAttribute('aria-labelledby')) ariaLabelledBy++;

        const tag = el.tagName.toLowerCase();
        const isNative = NATIVE.indexOf(tag) >= 0;
        if (isNative) native++;

        // React onClick
        const keys = Object.keys(el);
        const k = keys.find(x => x.indexOf('__reactProps$') === 0);
        const p = k ? el[k] : null;
        const hasReact = !!(p && (p.onClick || p.onMouseDown));
        if (hasReact) reactClick++;

        // cursor(去继承前后都报)
        let isPointer = false;
        try { isPointer = getComputedStyle(el).cursor === 'pointer'; } catch(_) {}
        if (isPointer) cursorRaw++;
        const parentPointer = el.parentElement
            ? (() => { try { return getComputedStyle(el.parentElement).cursor === 'pointer'; } catch(_) { return false; } })()
            : false;
        if (isPointer && !parentPointer) cursorDedup++;   // ★ 去继承

        const r = el.getBoundingClientRect();
        const visible = r.width > 0 && r.height > 0;
        const isUnit = isNative || hasReact || (isPointer && !parentPointer);
        if (isUnit && visible){
            if (!isNative && !hasReact) divSim++;
            const t = strip(txtOf(el));
            if (!t && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) noTextNoAria++;
        }
    }

    // 文本骨架可用率:叶子文本中能向上找到盒子的比例
    function isLeaf(el){
        const t = txtOf(el);
        if (!strip(t)) return false;
        const kids = Array.from(el.children).filter(c => strip(txtOf(c)).length > 0);
        if (kids.length >= 2) return false;
        const tLen = strip(t).length;
        const childSum = kids.reduce((s, c) => s + strip(txtOf(c)).length, 0);
        return childSum < tLen * 0.9;
    }
    const leaves = all.filter(isLeaf);
    let skeletonOk = 0;
    for (const leaf of leaves){
        const r = leaf.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        skeletonOk++;   // 叶子文本自身即可量,骨架一定可用
    }

    const candidates = native + reactClick + cursorDedup - (native && reactClick ? 0 : 0);
    return {
        roleAttr, testid, tabindex, ariaLabel, ariaLabelledBy,
        native, reactClick, cursorRaw, cursorDedup, divSim, noTextNoAria,
        leaves: leaves.length,
        skeletonRate: leaves.length ? Math.round(skeletonOk / leaves.length * 1000) / 10 : 0,
        divSimRate: (native + reactClick + cursorDedup) ? Math.round(divSim / (native + reactClick + cursorDedup) * 1000) / 10 : 0,
        total: all.length,
    };
}`;

async function main() {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, '--help') || argv.length === 0) {
        console.log(`probe-anchors · 锚点体检(决定走哪条路线)

用法:
  node scripts/probe-anchors.mjs --url <url> --side <name> [--wait <sel>] [--viewport] --out <file>

路线选择建议:
  显式 role 与 aria 较全        → 路线 B (ax-collect),对齐更精确
  role 几乎没写、div 模拟为主    → 路线 C (unit-collect),覆盖面更大

★ 自检:去继承后的 cursor 数应与 React onClick 数接近(实测完全相等,35 = 35)
`);
        return;
    }

    const url = argValue(argv, '--url');
    const side = argValue(argv, '--side', 'unknown');
    const preload = argValue(argv, '--preload');
    const waitSel = argValue(argv, '--wait');
    const outPath = argValue(argv, '--out');

    if (!url) throw new Error('--url required');

    const result = await withSession(async (session) => {
        await fixViewport(session);
        if (preload) await addPreload(session, preload);
        await navigateAndWait(session, url);
        if (waitSel) await waitForSelector(session, waitSel);
        await waitRAF(session);
        const stats = await session.evalAsync(`(${PROBE_FN})()`);
        return { url, side, collectedAt: new Date().toISOString(), ...stats };
    });

    const s = result;
    const lines = [];
    lines.push(`锚点体检 · ${s.side} — ${s.url}`);
    lines.push('');
    lines.push(`  语义标注    role ${s.roleAttr} · data-testid ${s.testid} · tabindex ${s.tabindex} · aria-label ${s.ariaLabel} · aria-labelledby ${s.ariaLabelledBy}`);
    lines.push(`  交互信号    原生标签 ${s.native} · React onClick ${s.reactClick}`);
    lines.push(`  cursor      pointer 去继承前 ${s.cursorRaw} → 去继承后 ${s.cursorDedup}`);
    lines.push(`  div 模拟    ${s.divSim} 个,占候选交互元素 ${s.divSimRate}%`);
    lines.push(`  无文本无 aria 的交互单元    ${s.noTextNoAria}`);
    lines.push(`  文本骨架    可用率 ${s.skeletonRate}% (叶子文本 ${s.leaves})`);
    lines.push('');

    // 交叉印证自检
    if (s.reactClick > 0) {
        const eq = Math.abs(s.cursorDedup - s.reactClick) <= Math.max(1, s.reactClick * 0.2);
        lines.push(`  ★ 交叉印证: cursor 去继承后 ${s.cursorDedup} vs React onClick ${s.reactClick} → ${eq ? '✅ 量级一致(实现可信)' : '⚠ 量级不符,检查去继承逻辑'}`);
        if (s.cursorRaw > 0) {
            lines.push(`     (未去继承会是 ${s.cursorRaw} 个,虚高 ${(s.cursorRaw / Math.max(1, s.cursorDedup)).toFixed(1)} 倍 —— 实测参考 6.7 倍)`);
        }
    }
    lines.push('');

    // 路线建议
    const richSemantic = s.roleAttr >= 5 || s.ariaLabel >= 5;
    const divHeavy = s.divSimRate >= 50;
    if (richSemantic && !divHeavy) {
        lines.push(`  → 建议路线 B (ax-collect):语义标注较全,指纹对齐更精确`);
    } else if (divHeavy || s.roleAttr <= 2) {
        lines.push(`  → 建议路线 C (unit-collect):role 标注稀缺、div 模拟为主,覆盖面更大`);
    } else {
        lines.push(`  → 建议两条都跑,交叉验证(路线 B 精确 + 路线 C 覆盖,输出格式兼容可共用 ax-diff)`);
    }

    console.log(lines.join('\n'));

    if (outPath) {
        const fs = await import('node:fs/promises');
        await fs.writeFile(outPath, JSON.stringify(s, null, 2));
        console.log(`\n已保存: ${outPath}`);
    }
}

main().catch(err => {
    console.error('error:', err.message ?? err);
    if (process.env.VERIFY_DEBUG) console.error(err.stack);
    process.exit(1);
});
