#!/usr/bin/env node
// verify-suite / scripts / unit-collect.mjs
//
// 路线 C:交互单元 + 文本骨架(role 缺失时)。
//
// 为什么需要这条路线(真实项目体检数据):
//                      demo        产线
//   显式 role 属性       0 个        1 个      ← role 基本没人写
//   data-testid         0 个        0 个      ← "两边约定 testid" 在现状下不存在
//   原生交互标签         24 个       17 个
//   div 模拟交互        213 个      61 个     ← 占候选交互元素 90% / 74%
//
// 结论:锁定目标不能从「role 是什么」出发,要从「它真的能点吗 + 文案在哪」出发。
//
// 用法:
//   node scripts/unit-collect.mjs --url <url> [--scope <selector>] [--preload <js>]
//        [--wait <sel>] [--viewport 1440x900] --out <file>
//
// ★ 强烈建议加 --scope:文本骨架覆盖面很大,整页扫会把业务数据全部归入"仅基准侧存在"。

import { argValue, hasFlag } from './lib/args.mjs';
import {
    withSession, fixViewport, addPreload,
    navigateAndWait, waitForSelector, waitRAF, norm,
} from './lib/cdp.mjs';

// ---------------------------------------------------------------------------
// 页面内采集脚本(一次性拿完,避免多次往返)
// ---------------------------------------------------------------------------

const COLLECT_FN = `function(scopeSel){
    const NATIVE = ['button','a','input','select','textarea','summary'];
    const STOP_TAGS = new Set(['nav','aside','main','section','footer','header','body','html']);
    const strip = s => String(s || '').replace(/\\s/g, '');
    const txtOf = e => (e.innerText || e.textContent || '');

    // ---- 信号 1/2/3:交互单元三信号取并集 ----
    function isUnit(el){
        // ① React props 上的 onClick / onMouseDown —— 确定性最高
        const keys = Object.keys(el);
        const k = keys.find(x => x.indexOf('__reactProps$') === 0);
        const p = k ? el[k] : null;
        if (p && (p.onClick || p.onMouseDown)) return 'click';
        // ② 原生交互标签
        if (NATIVE.indexOf(el.tagName.toLowerCase()) >= 0) return 'native';
        // ③ cursor:pointer 且父级非 pointer(★ cursor 是继承属性,不去继承会虚高 6.7 倍)
        try {
            if (getComputedStyle(el).cursor === 'pointer'){
                const pe = el.parentElement;
                if (!pe || getComputedStyle(pe).cursor !== 'pointer') return 'pointer';
            }
        } catch(_) {}
        return null;
    }

    // ---- 叶子文本:两道判据叠用(单一判据实测出过垃圾节点) ----
    function isLeaf(el){
        const t = txtOf(el);
        if (!strip(t)) return false;
        // 判据 a:子元素中有 >=2 个含文本 → 这是容器(比判据 b 鲁棒)
        const kids = Array.from(el.children).filter(c => strip(txtOf(c)).length > 0);
        if (kids.length >= 2) return false;
        // 判据 b:子文本长度之和 < 自己的 90% → 才算自己持有文本
        const tLen = strip(t).length;
        const childSum = kids.reduce((s, c) => s + strip(txtOf(c)).length, 0);
        return childSum < tLen * 0.9;
    }

    function hasVisualBox(el){
        try {
            const cs = getComputedStyle(el);
            const bg = cs.backgroundColor;
            const hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
            const hasBorder = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0
                           || parseFloat(cs.borderRightWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0;
            const hasRadius = parseFloat(cs.borderTopLeftRadius) > 0;
            const hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
            return !!(hasBg || hasBorder || hasRadius || hasShadow);
        } catch(_) { return false; }
    }

    function hashStr(s){
        let h = 0;
        for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return Math.abs(h).toString(36);
    }

    // 无名交互单元:图标形状 hash(取 svg viewBox 或首个 path 的 d 前 60 字符)
    function iconHash(el){
        try {
            const svg = el.querySelector && el.querySelector('svg');
            if (svg){
                const vb = svg.getAttribute('viewBox') || '';
                const path = svg.querySelector('path');
                const d = path ? (path.getAttribute('d') || '') : '';
                return 'i' + hashStr((vb + '|' + d).slice(0, 60));
            }
            const img = el.querySelector && el.querySelector('img');
            if (img && img.src) return 'i' + hashStr(img.src.split('/').pop().slice(0, 60));
        } catch(_) {}
        return null;
    }

    const root = scopeSel ? document.querySelector(scopeSel) : document.body;
    if (!root) return { error: 'scope not found: ' + scopeSel };

    const all = Array.from(root.querySelectorAll('*'));
    const out = [];
    const seen = new Set();

    // ---- 1. 交互单元(含无名图标按钮) ----
    let cursorBefore = 0, cursorAfter = 0, reactClick = 0, divSim = 0;
    for (const el of all){
        try { if (getComputedStyle(el).cursor === 'pointer') cursorBefore++; } catch(_) {}
        const kind = isUnit(el);
        if (!kind) continue;
        if (kind === 'pointer') cursorAfter++;
        if (kind === 'click') reactClick++;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (kind !== 'native' && kind !== 'click') divSim++;
        const t = txtOf(el).trim().slice(0, 120);
        seen.add(el);
        out.push({
            kind: 'unit',
            unitKind: kind,
            text: t,
            iconHash: t ? null : iconHash(el),
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
            __el: el,
        });
    }

    // ---- 2. 叶子文本 → 向上最多 8 层找「要量的那个盒子」 ----
    const leaves = all.filter(isLeaf);
    for (const leaf of leaves){
        const t = txtOf(leaf).trim();
        if (!t) continue;
        const lr = leaf.getBoundingClientRect();
        if (lr.width === 0 && lr.height === 0) continue;
        const leafArea = Math.max(1, lr.width * lr.height);

        let box = leaf, boxKind = 'text';
        let cur = leaf;
        for (let i = 0; i < 8; i++){
            cur = cur.parentElement;
            if (!cur) break;
            if (STOP_TAGS.has(cur.tagName.toLowerCase())) break;
            const bR = cur.getBoundingClientRect();
            // ★ 尺寸防护:单一面积比不够,还要纵向绝对上限 + 视口占比上限
            const tooBig = (bR.width * bR.height) / leafArea > 60
                        || bR.height > lr.height * 4 + 40
                        || bR.height > window.innerHeight * 0.5;
            if (tooBig) break;
            const u = isUnit(cur);
            if (u) { box = cur; boxKind = 'unit'; break; }
            if (hasVisualBox(cur)) { box = cur; boxKind = 'box'; break; }
        }
        if (seen.has(box) && box !== leaf) continue; // 已被交互单元覆盖
        seen.add(box);
        const br = box.getBoundingClientRect();
        out.push({
            kind: boxKind,
            unitKind: null,
            text: t.slice(0, 120),
            iconHash: null,
            rect: { left: br.left, top: br.top, width: br.width, height: br.height },
            __el: box,
        });
    }

    // ---- 3. 对每个目标盒子采视觉度量 ----
    const measureSrc = ${'MEASURE_FN_SRC'};
    const measure = eval('(' + measureSrc + ')');
    const items = [];
    for (const o of out){
        let m;
        try { m = measure.call(o.__el); } catch(_) { continue; }
        items.push({
            kind: o.kind,
            unitKind: o.unitKind,
            text: o.text,
            iconHash: o.iconHash,
            ...m,
        });
    }

    return {
        items,
        stats: { cursorBefore, cursorAfter, reactClick, divSim, leaves: leaves.length },
    };
}`;

async function main() {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, '--help') || argv.length === 0) {
        console.log(`unit-collect · 路线 C 交互单元 + 文本骨架

用法:
  node scripts/unit-collect.mjs --url <url> [--scope <selector>] [--preload <js>]
       [--wait <sel>] [--viewport 1440x900] --out <file>

适用场景(实测):role 几乎没写、div 模拟交互占 74%~90% 的项目。
★ 强烈建议加 --scope:整页扫会把业务数据全部归入"仅基准侧存在",占满报告。

三信号取并集判定交互单元:
  ① React __reactProps$ 上有 onClick / onMouseDown  (确定性最高)
  ② 原生交互标签 button/a/input/select/textarea/summary
  ③ cursor:pointer 且父级非 pointer  ★ 不去继承会虚高 6.7 倍

主键 = 归一化文案 + 视觉网格位置(★ 不含 role)
无名交互单元用图标形状 hash(svg viewBox / path d 前 60 字符)
输出与 ax-collect 兼容(items + count),可共用 ax-diff
`);
        return;
    }

    const url = argValue(argv, '--url');
    const scope = argValue(argv, '--scope');
    const preload = argValue(argv, '--preload');
    const waitSel = argValue(argv, '--wait');
    const outPath = argValue(argv, '--out');
    const vpArg = argValue(argv, '--viewport', '1440x900');
    const m = String(vpArg).match(/^(\d+)\s*[xX]\s*(\d+)$/);
    const vp = m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1440, height: 900 };

    if (!url) throw new Error('--url required');

    // 把 MEASURE_FN 注入页面内脚本
    const { MEASURE_FN } = await import('./lib/cdp.mjs');
    const collectSrc = COLLECT_FN.replace("'MEASURE_FN_SRC'", JSON.stringify(MEASURE_FN));

    const result = await withSession(async (session) => {
        await fixViewport(session, vp);
        if (preload) await addPreload(session, preload);
        await navigateAndWait(session, url);
        if (waitSel) await waitForSelector(session, waitSel);
        await waitRAF(session);

        const raw = await session.evalAsync(`(${collectSrc})(${scope ? JSON.stringify(scope) : 'null'})`);
        if (raw?.error) throw new Error(raw.error);

        // Node 侧做归一化 + 指纹(与 ax-collect 保持一致的 fp 格式)
        const counters = new Map();
        const items = raw.items.map(it => {
            const text = it.text ?? '';
            const n = norm(text);
            const base = n
                ? `text|${n}`
                : (it.iconHash ? `icon|${it.iconHash}` : `unit|`);
            const c = counters.get(base) ?? 0;
            counters.set(base, c + 1);
            const gy = Math.round(it.rect.top / 8);
            const gx = Math.round(it.rect.left / 8);
            return {
                fp: base,
                fpIndex: c,
                role: n ? 'text' : 'icon',   // 供 ax-diff 模糊配对用
                name: text.slice(0, 120),
                normName: n,
                grid: { gy, gx },
                kind: it.kind,
                unitKind: it.unitKind,
                iconHash: it.iconHash,
                // P1-5 证据等级:路线 C 的主键是「归一化文案 + 网格位置」,不是 role ——
                // 拿不到语义身份,所以证据档位本身就是 text-skeleton。
                evidence: 'text-skeleton',
                // native(原生交互标签) / click(React onClick) 是硬证据;
                // pointer(仅 cursor 推断) 与纯文本只是推断 → medium
                confidence: (it.unitKind === 'native' || it.unitKind === 'click') ? 'high' : 'medium',
                boxW: it.boxW, boxH: it.boxH,
                inLeft: it.inLeft, inRight: it.inRight, inTop: it.inTop,
                iconGap: it.iconGap, iconSize: it.iconSize, vBias: it.vBias,
                fontSize: it.fontSize, fontWeight: it.fontWeight,
                textColor: it.textColor, radius: it.radius, bg: it.bg,
                hasShadow: it.hasShadow, rect: it.rect,
            };
        });
        items.sort((a, b) => (a.grid.gy - b.grid.gy) || (a.grid.gx - b.grid.gx));

        const nHigh = items.filter(i => i.confidence === 'high').length;

        return {
            url,
            scope: scope ?? null,
            viewport: vp,
            collectedAt: new Date().toISOString(),
            count: items.length,
            evidence: {
                primary: 'text-skeleton',
                // 路线 C 整体比路线 B 低一档:无语义身份,靠文案 + 位置对齐
                confidence: 'medium',
                byItem: { high: nHigh, medium: items.length - nHigh },
            },
            // P1-5 降级留痕:选用路线 C 本身就是一次降级(预期走 AX 树但 role 不足),
            // 必须写进报告,严禁静默降级 —— 读报告的人要知道结论颗粒度已经变粗。
            degradation: {
                from: 'ax-tree',
                to: 'text-skeleton',
                reason: '主动降级:页面语义化不足(实测此类项目 div 模拟交互占 74%~90%),'
                    + '拿不到 role 身份,主键退化为「归一化文案 + 网格位置」。'
                    + '失去语义身份后只能判「文案与位置是否对得上」,判不了「是不是同一个语义元素」。',
                identityRatio: 0,
            },
            items,
            stats: raw.stats,
        };
    });

    // ★ P0-1:空采集 = 执行错误,绝不等于「无差异」。
    if (result.count === 0) {
        console.error('unit-collect: 采集到 0 个交互单元 / 文本骨架 —— 这是执行错误(退出码 1),不是无差异');
        console.error('  可能原因:preload 静默失效 / 页面未加载完成 / URL 指向空白页 / scope 选择器不匹配');
        process.exit(1);
    }
    const minItems = Number(argValue(argv, '--min-items', '3'));
    if (result.count < minItems) {
        console.error(`unit-collect: 仅采集到 ${result.count} 个单元,低于 --min-items ${minItems} 阈值 —— 视为页面未稳定加载,执行错误(退出码 1)`);
        process.exit(1);
    }

    const json = JSON.stringify(result, null, 2);
    if (outPath) {
        const fs = await import('node:fs/promises');
        await fs.writeFile(outPath, json);
        const s = result.stats;
        console.log(`unit-collect: ${result.count} 单元 -> ${outPath}`);
        console.log(`  自检: cursor:pointer 去继承前 ${s.cursorBefore} → 去继承后 ${s.cursorAfter} | React onClick ${s.reactClick} | div 模拟 ${s.divSim} | 叶子文本 ${s.leaves}`);
        if (s.reactClick > 0) {
            console.log(`  ★ 交叉印证:去继承后的 pointer 数(${s.cursorAfter}) 应与 React onClick 数(${s.reactClick}) 接近 —— 差异过大说明实现有误`);
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
