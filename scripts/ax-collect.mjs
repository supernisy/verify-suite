#!/usr/bin/env node
// verify-suite / scripts / ax-collect.mjs
//
// 路线 B:语义指纹全量扫描。
// 适用:两侧组件库不同(任何 CSS selector 都无法通用)、或事先不知道该测哪些组件。
//
// 用法:
//   node scripts/ax-collect.mjs --url <url> [--scope <selector>] [--preload <js>]
//        [--wait <sel>] [--viewport 1440x900] --out <file>
//
// 链路:Accessibility.getFullAXTree → DOM.resolveNode → Runtime.callFunctionOn
//
// ★ 第 ② 级主键(role + accessible name)零配合生效的地基:
//   W3C accname 规范定义了浏览器如何为元素算出名字,即使被测方完全没做无障碍标注,
//   浏览器也已经算好了名字 —— 对被测代码零侵入。

import {
    argValue, hasFlag, withSession, fixViewport, addPreload,
    navigateAndWait, waitForSelector, waitRAF, measureElement,
    resolveBackendNode, norm, gridKey,
} from './lib/cdp.mjs';

/** 有语义的 role(用于过滤 AX 树) */
const SEMANTIC_ROLES = new Set([
    'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'tab', 'textbox', 'heading', 'checkbox', 'radio', 'switch',
    'combobox', 'listbox', 'option', 'searchbox', 'slider', 'spinbutton',
    'navigation', 'complementary', 'main', 'banner', 'contentinfo', 'region',
    'form', 'group', 'article', 'section', 'toolbar', 'menu', 'menubar',
    'tablist', 'table', 'row', 'grid', 'tree', 'list', 'listitem',
    'alert', 'dialog', 'tooltip', 'img', 'figure', 'separator', 'status',
]);

/** 从 AX 节点取 accessible name */
function axName(node) {
    const n = node.name?.value;
    if (n && typeof n === 'string') return n;
    // 退回到 value / description
    const v = node.value?.value;
    if (v && typeof v === 'string') return v;
    const d = node.description?.value;
    if (d && typeof d === 'string') return d;
    return '';
}

async function main() {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, '--help') || argv.length === 0) {
        console.log(`ax-collect · 路线 B 语义指纹全量扫描

用法:
  node scripts/ax-collect.mjs --url <url> [--scope <selector>] [--preload <js>]
       [--wait <sel>] [--viewport 1440x900] --out <file>

算法:
  1. Accessibility.getFullAXTree
  2. 过滤有语义的 role
  3. DOM.resolveNode → Runtime.callFunctionOn 采视觉度量
  4. 指纹 key = role + "|" + norm(accessible name)
  5. 同 key 多个 → 按 8px 网格量化坐标后按视觉阅读顺序编号

归一化(norm)四步,每步都有实测理由:
  去所有空白  — innerText 会在块级子元素间插分隔符
  数字 → #     — 解决「活跃任务 5」vs「活跃任务 12」
  截断 40 字   — 超长文本尾部差异不影响主键
  转小写
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

    const result = await withSession(async (session) => {
        await fixViewport(session, vp);
        // ★ preload → 导航 → 采集 同一 session
        if (preload) await addPreload(session, preload);
        await navigateAndWait(session, url);
        if (waitSel) await waitForSelector(session, waitSel);
        await waitRAF(session);

        // 1. 取完整 AX 树
        const ax = await session.send('Accessibility.getFullAXTree');
        const nodes = ax.nodes ?? [];

        const candidates = [];
        for (const n of nodes) {
            if (n.ignored) continue;
            const role = n.role?.value;
            if (!role || !SEMANTIC_ROLES.has(role)) continue;
            if (!n.backendDOMNodeId) continue;
            candidates.push(n);
        }

        const items = [];
        const counters = new Map();

        for (const n of candidates) {
            let obj;
            try {
                obj = await resolveBackendNode(session, n.backendDOMNodeId);
            } catch { continue; }
            if (!obj?.objectId) continue;

            // scope 过滤
            if (scope) {
                const inScope = await session.send('Runtime.callFunctionOn', {
                    objectId: obj.objectId,
                    functionDeclaration: `function(){ return !!this.closest(${JSON.stringify(scope)}); }`,
                    returnByValue: true,
                }).then(r => r.result?.value).catch(() => true);
                if (!inScope) continue;
            }

            let m;
            try {
                m = await measureElement(session, obj.objectId);
            } catch { continue; }

            // 跳过零尺寸(不可见)
            if (m.rect.width === 0 && m.rect.height === 0) continue;

            const name = axName(n);
            const normName = norm(name);
            const fp = `${n.role?.value}|${normName}`;

            // 同名节点编号(★ 先按 8px 网格量化坐标再排序,否则 1px 抖动会让两侧编号错位)
            const g = gridKey(m.rect);
            const cnt = counters.get(fp) ?? 0;
            counters.set(fp, cnt + 1);

            items.push({
                fp,
                fpIndex: cnt,
                role: n.role?.value,
                name: name.slice(0, 120),
                normName,
                grid: g,
                ...m,
            });
        }

        // 视觉阅读顺序排序 + 编号
        items.sort((a, b) => (a.grid.gy - b.grid.gy) || (a.grid.gx - b.grid.gx));

        return {
            url,
            scope: scope ?? null,
            viewport: vp,
            collectedAt: new Date().toISOString(),
            count: items.length,
            items,
        };
    });

    const json = JSON.stringify(result, null, 2);
    if (outPath) {
        const fs = await import('node:fs/promises');
        await fs.writeFile(outPath, json);
        const nameless = result.items.filter(i => !i.normName).length;
        console.log(`ax-collect: ${result.count} 语义节点 -> ${outPath}${nameless ? ` (无名 ${nameless} 个,比对时默认跳过)` : ''}`);
    } else {
        console.log(json);
    }
}

main().catch(err => {
    console.error('error:', err.message ?? err);
    if (process.env.VERIFY_DEBUG) console.error(err.stack);
    process.exit(1);
});
