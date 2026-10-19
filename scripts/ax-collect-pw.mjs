#!/usr/bin/env node
// verify-suite / scripts / ax-collect-pw.mjs
//
// 路线 B (Playwright 引擎版): 语义指纹全量扫描。
// 底层由 Playwright 驱动, 替代 scripts/ax-collect.mjs 的裸 CDP。
//   - AX 树: page.accessibility.snapshot()  (仍是 AX 为 ground truth)
//   - 指纹主键: role|norm(accessible name)  (与 CDP 版完全一致)
//   - 等待/交互/断言: Playwright 语义 locator + auto-wait + web-first 可重试
// 复用 scripts/lib/cdp.mjs 的 norm / gridKey (纯函数, 无 CDP 依赖)。
//
// 用法:
//   node scripts/ax-collect-pw.mjs --url <url> [--scope <selector>] [--preload <js>]
//        [--wait <sel>] [--viewport 1440x900] [--trace out/trace.zip] --out <file>

import { PlaywrightDriver } from '../adapters/web-cdp/playwright-driver.mjs';
import { norm, gridKey } from './lib/cdp.mjs';
import { argValue, hasFlag } from './lib/args.mjs';

const SEMANTIC_ROLES = new Set([
    'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'tab', 'textbox', 'heading', 'checkbox', 'radio', 'switch',
    'combobox', 'listbox', 'option', 'searchbox', 'slider', 'spinbutton',
    'navigation', 'complementary', 'main', 'banner', 'contentinfo', 'region',
    'form', 'group', 'article', 'section', 'toolbar', 'menu', 'menubar',
    'tablist', 'table', 'row', 'grid', 'tree', 'list', 'listitem',
    'alert', 'dialog', 'tooltip', 'img', 'figure', 'separator', 'status',
]);

function axName(node) {
    if (node?.name && typeof node.name === 'string') return node.name;
    if (node?.value && typeof node.value === 'string') return node.value;
    if (node?.description && typeof node.description === 'string') return node.description;
    return '';
}

async function main() {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, '--help') || argv.length === 0) {
        console.log(`ax-collect-pw · 路线 B (Playwright 引擎版) 语义指纹全量扫描

用法:
  node scripts/ax-collect-pw.mjs --url <url> [--scope <selector>] [--preload <js>]
       [--wait <sel>] [--viewport 1440x900] [--trace out/trace.zip] --out <file>

引擎: Playwright (替代裸 CDP)
算法:
  1. page.accessibility.snapshot() 取 AX 树 (AX 为 ground truth)
  2. 过滤有语义的 role
  3. getByRole(role,{name}).first() 度量视觉几何
  4. 指纹 key = role + "|" + norm(accessible name)
  5. 同 key 多个 → 按 8px 网格量化坐标后按视觉阅读顺序编号
`);
        return;
    }

    const url = argValue(argv, '--url');
    const scope = argValue(argv, '--scope');
    const preload = argValue(argv, '--preload');
    const waitSel = argValue(argv, '--wait');
    const outPath = argValue(argv, '--out');
    const tracePath = argValue(argv, '--trace');
    const vpArg = argValue(argv, '--viewport', '1440x900');
    const m = String(vpArg).match(/^(\d+)\s*[xX]\s*(\d+)$/);
    const vp = m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1440, height: 900 };
    if (!url) throw new Error('--url required');

    const driver = await new PlaywrightDriver({ viewport: vp, tracePath }).launch();
    try {
        if (preload) await driver.goto(url, { preload });
        else await driver.goto(url);
        if (waitSel) await driver.waitForSelector(waitSel);

        // 1. 取 AX 树（Playwright 快照，AX 为 ground truth）
        const nodes = await driver.collectSemantic(SEMANTIC_ROLES);

        const items = [];
        const counters = new Map();
        for (const n of nodes) {
            const name = axName(n);
            const normName = norm(name);
            const fp = `${n.role}|${normName}`;

            // scope 过滤（若指定）
            if (scope) {
                const inScope = await driver.locate({ role: n.role, name }).first()
                    .evaluate((el, sel) => !!el.closest(sel), scope).catch(() => true);
                if (!inScope) continue;
            }

            const target = driver.locate({ role: n.role, name }).first();
            let meas;
            try { meas = await driver.measure(target); } catch { continue; }
            if (meas.rect.width === 0 && meas.rect.height === 0) continue;

            const g = gridKey(meas.rect);
            const cnt = counters.get(fp) ?? 0;
            counters.set(fp, cnt + 1);
            const hasIdentity = !!n.role && !['generic', 'None', 'presentation'].includes(n.role);
            items.push({
                fp, fpIndex: cnt, role: n.role,
                name: name.slice(0, 120), normName, grid: g,
                evidence: 'ax-tree', confidence: hasIdentity ? 'high' : 'medium',
                ...meas,
            });
        }

        items.sort((a, b) => (a.grid.gy - b.grid.gy) || (a.grid.gx - b.grid.gx));

        const noIdentity = items.filter((i) => i.confidence === 'medium').length;
        const identityRatio = items.length ? 1 - noIdentity / items.length : 0;
        const degraded = identityRatio < 0.5;

        const result = {
            url,
            scope: scope ?? null,
            viewport: vp,
            collectedAt: new Date().toISOString(),
            count: items.length,
            engine: 'playwright',
            evidence: {
                primary: 'ax-tree',
                confidence: degraded ? 'medium' : 'high',
                byItem: { high: items.length - noIdentity, medium: noIdentity },
            },
            degradation: degraded ? {
                from: 'ax-tree',
                to: 'text-skeleton',
                reason: `${items.length} 个节点中 ${noIdentity} 个无有效 role(语义化比例 ${(identityRatio * 100).toFixed(0)}%)`,
                identityRatio,
            } : null,
            items,
        };

        // ★ P0-1: 空采集 = 执行错误, 绝不等于「无差异」
        if (result.count === 0) {
            console.error('ax-collect-pw: 采集到 0 个语义节点 —— 这是执行错误(退出码 1), 不是无差异');
            console.error('  可能原因: preload 静默失效 / 页面未加载完成 / URL 指向空白页 / scope 选择器不匹配');
            process.exit(1);
        }
        const minItems = Number(argValue(argv, '--min-items', '3'));
        if (result.count < minItems) {
            console.error(`ax-collect-pw: 仅采集到 ${result.count} 个语义节点, 低于 --min-items ${minItems} 阈值 —— 视为页面未稳定加载, 执行错误(退出码 1)`);
            process.exit(1);
        }

        if (outPath) {
            const fs = await import('node:fs/promises');
            await fs.writeFile(outPath, JSON.stringify(result, null, 2));
            console.log(`ax-collect-pw: ${result.count} 语义节点 -> ${outPath} (engine=playwright)`);
        } else {
            console.log(JSON.stringify(result, null, 2));
        }
    } finally {
        await driver.close();
    }
}

main().catch((err) => {
    console.error('error:', err.message ?? err);
    if (process.env.VERIFY_DEBUG) console.error(err.stack);
    process.exit(1);
});
