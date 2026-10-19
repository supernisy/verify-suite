#!/usr/bin/env node
// verify-suite / scripts / ax-collect-pw.mjs
//
// 路线 B (Playwright 引擎版): 语义指纹全量扫描。
//
// ★ 执行层已改为「直接调用 Playwright 官方库」(adopt-industry-drivers 变更):
//   本脚本不再封装任何自研 driver 类 (playwright-driver.mjs 已删除)，
//   而是直接调用 Playwright 自有 API —— 即"用现成轮子"，不是重造。
//   - AX 树: page.accessibility.snapshot()  (仍是 AX 为 ground truth)
//   - 定位:   page.getByRole(role,{name})  (Playwright 自带 semantic + strict)
//   - 等待:   page.goto / locator 的 auto-wait (Playwright 自带, 无手写 sleep)
//   - 断言:   见下方 assertVisible / assertCount (web-first 可重试, 失败含定位器+实际+期望)
//   - trace:  context.tracing (Playwright 自带, 可回放取证)
//
// 我们自留的护城河层 (不重造): AX 感知主源 + 语义指纹 norm/gridKey + 证据等级 +
// 完整性断言 (空采集=错误) + 降级账本 (degradation)。这些逻辑与 CDP 版 scripts/ax-collect.mjs
// 同算法同指纹 (role|norm(name)), 仅底层驱动从裸 CDP 换成 Playwright 官方库。
//
// 用法:
//   node scripts/ax-collect-pw.mjs --url <url> [--scope <selector>] [--preload <js>]
//        [--wait <sel>] [--viewport 1440x900] [--trace out/trace.zip] --out <file>

import { chromium } from 'playwright';
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

// 从 AX 树 (page.accessibility.snapshot 的树形结构) 递归收集语义节点
function collectSemantic(tree, roles) {
    const out = [];
    const walk = (node) => {
        if (!node) return;
        if (node.role && roles.has(node.role)) out.push(node);
        (node.children || []).forEach(walk);
    };
    walk(tree);
    return out;
}

// 度量: 复用 Playwright locator.evaluate 直接读元素的几何 + 计算样式
async function measure(page, role, name) {
    const loc = page.getByRole(role, { name });
    return await loc.first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
            boxW: Math.round(r.width * 100) / 100,
            boxH: Math.round(r.height * 100) / 100,
            rect: {
                left: Math.round(r.left), top: Math.round(r.top),
                width: Math.round(r.width), height: Math.round(r.height),
            },
            fontSize: parseFloat(cs.fontSize),
            fontWeight: cs.fontWeight,
            textColor: cs.color,
            radius: cs.borderRadius,
            bg: cs.backgroundColor,
        };
    });
}

// web-first 可重试断言 (Playwright 自带 actionability 之上, 带定位器+实际+期望信息)
async function assertVisible(loc, { timeout = 5000 } = {}) {
    const start = Date.now();
    let lastErr = '';
    while (Date.now() - start < timeout) {
        try {
            const box = await loc.first().boundingBox();
            if (box && box.width > 0 && box.height > 0) return;
            lastErr = 'boundingBox 为空（元素不可见或零尺寸）';
        } catch (e) { lastErr = e.message; }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`assertVisible 超时（${timeout}ms）: ${lastErr}`);
}

async function main() {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, '--help') || argv.length === 0) {
        console.log(`ax-collect-pw · 路线 B (Playwright 官方库驱动) 语义指纹全量扫描

用法:
  node scripts/ax-collect-pw.mjs --url <url> [--scope <selector>] [--preload <js>]
       [--wait <sel>] [--viewport 1440x900] [--trace out/trace.zip] --out <file>

引擎: Playwright 官方库 (commodity, 非自研 driver)
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

    // ---- 直接调用 Playwright 官方库启动引擎 (auto-wait 由 Playwright 提供) ----
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: vp });
    const page = await context.newPage();
    if (tracePath) await context.tracing.start({ screenshots: true, snapshots: true });

    try {
        if (preload) await page.addInitScript(preload);
        await page.goto(url, { waitUntil: 'load' });
        if (waitSel) await page.waitForSelector(waitSel, { timeout: 15000 });

        // 1. 取 AX 树（Playwright 快照，AX 为 ground truth）
        const tree = await page.accessibility.snapshot();
        if (!tree) throw new Error('accessibility.snapshot() 返回空 —— 页面可能未加载或无可访问内容');
        const nodes = collectSemantic(tree, SEMANTIC_ROLES);

        const items = [];
        const counters = new Map();
        for (const n of nodes) {
            const name = axName(n);
            const normName = norm(name);
            const fp = `${n.role}|${normName}`;

            // scope 过滤（若指定）
            if (scope) {
                const inScope = await page.getByRole(n.role, { name })
                    .first().evaluate((el, sel) => !!el.closest(sel), scope).catch(() => true);
                if (!inScope) continue;
            }

            let meas;
            try { meas = await measure(page, n.role, name); } catch { continue; }
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
        if (tracePath) {
            try { await context.tracing.stop({ path: tracePath }); } catch (_) {}
        }
        await browser.close();
    }
}

// 暴露 web-first 断言供契约/回归调用 (保留能力, 由 Playwright 提供底层)
export { assertVisible };

main().catch((err) => {
    console.error('error:', err.message ?? err);
    if (process.env.VERIFY_DEBUG) console.error(err.stack);
    process.exit(1);
});
