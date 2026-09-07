#!/usr/bin/env node
// verify-suite / scripts / geo-collect.mjs
//
// 路线 A:人工探针精确卡尺。
// 适用:同仓库或同组件库、目标组件明确、需要精确到具体字段。
//
// 用法:
//   node scripts/geo-collect.mjs --url <url> --probes <probes.json> --side <expected|actual>
//        [--preload <js>] [--wait <selector>] [--viewport 1440x900] --out <file>
//
// ★ 硬约束(文档 §2):preload 注册、导航、采集必须在同一 session 内完成 ——
//   所以本脚本不复用 cdp-client,自己串完三步。

import {
    argValue, hasFlag, withSession, fixViewport, addPreload,
    navigateAndWait, waitForSelector, waitRAF, measureElement,
} from './lib/cdp.mjs';

// 探针字段名 → 度量字段名(文档原则 2:比坐标差值,不比属性)
const FIELD_ALIAS = {
    width: 'boxW',
    height: 'boxH',
    borderRadius: 'radius',
};

/** 解析 WxH */
function parseViewport(vp) {
    if (!vp) return { width: 1440, height: 900 };
    const m = String(vp).match(/^(\d+)\s*[xX]\s*(\d+)$/);
    if (!m) return { width: 1440, height: 900 };
    return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * 采集排列方向。
 *
 * ★ 不能信 flexDirection:display:block 时它也返回 'row',
 *   会把纵向间距算成负数。必须按子元素实际位置推断。
 */
async function measureArrangement(session, objectId) {
    const r = await session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(){
            const el = this;
            const kids = Array.from(el.children).map(c => c.getBoundingClientRect())
                .filter(r => r.width > 0 && r.height > 0)
                .sort((a, b) => (a.top - b.top) || (a.left - b.left));
            if (kids.length < 2) return { direction: 'unknown', gap: null, childCount: el.children.length };
            // 判断相邻元素是横向递增还是纵向递增
            let horiz = 0, vert = 0;
            for (let i = 1; i < kids.length; i++) {
                const dx = kids[i].left - kids[i - 1].right;   // 水平间距
                const dy = kids[i].top - kids[i - 1].bottom;   // 垂直间距
                if (Math.abs(dx) < Math.abs(dy)) vert++; else horiz++;
            }
            const direction = vert >= horiz ? 'column' : 'row';
            // 间距:取主轴方向相邻间距的中位数
            const gaps = [];
            for (let i = 1; i < kids.length; i++) {
                if (direction === 'column') gaps.push(kids[i].top - kids[i - 1].bottom);
                else gaps.push(kids[i].left - kids[i - 1].right);
            }
            gaps.sort((a, b) => a - b);
            const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
            return {
                direction,
                gap: gap == null ? null : Math.round(gap * 100) / 100,
                childCount: el.children.length,
            };
        }`,
        returnByValue: true,
    });
    if (r.exceptionDetails) return { direction: 'unknown', gap: null, childCount: 0 };
    return r.result.value;
}

async function collectProbe(session, probe, side) {
    const sel = probe[side];
    if (!sel) return { name: probe.name, side, missing: true, reason: `no selector for side "${side}"` };

    // 定位元素
    const r = await session.send('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(sel)})`,
        returnByValue: false,
    });
    if (!r.result || !r.result.objectId) {
        return { name: probe.name, side, missing: true, reason: `selector not found: ${sel}` };
    }
    const objId = r.result.objectId;
    const m = await measureElement(session, objId);
    const arr = await measureArrangement(session, objId);

    // 只保留探针声明的字段
    const fields = probe.fields ?? Object.keys(m);
    const ignore = new Set(probe.ignore ?? []);
    const out = { name: probe.name, side, selector: sel, missing: false };
    for (const f of fields) {
        if (ignore.has(f)) continue;
        const key = FIELD_ALIAS[f] ?? f;
        if (key in m) out[f] = m[key];
        else if (key in arr) out[f] = arr[key];
    }
    // 排列方向/间距若被显式声明也带上
    if (fields.includes('direction') || fields.includes('gap')) {
        out.direction = arr.direction;
        out.gap = arr.gap;
    }
    out._rect = m.rect;
    return out;
}

async function main() {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, '--help') || argv.length === 0) {
        console.log(`geo-collect · 路线 A 人工探针采集

用法:
  node scripts/geo-collect.mjs --url <url> --probes <probes.json> --side <expected|actual>
       [--preload <js>] [--wait <selector>] [--viewport 1440x900] --out <file>

探针配置结构:
{
  "probes": [
    {
      "name": "侧边栏导航项",
      "expected": "aside nav button:first-child",
      "actual": ".sidebar .menu-item:first-child",
      "fields": ["width", "height", "inLeft", "fontSize", "borderRadius"],
      "strict": ["fontSize", "borderRadius"],
      "tolerance": 1,
      "ignore": ["top", "childCount"]
    }
  ]
}

说明:
  - expected / actual 两侧各自的 selector 显式映射,DOM 结构不同也能对齐
  - fields 支持: boxW/boxH(width/height)/inLeft/inRight/inTop/iconGap/iconSize
                vBias/fontSize/fontWeight/textColor/radius(borderRadius)/bg/hasShadow
                direction/gap/childCount
  - ★ 排列方向按子元素实际位置推断,不信 flexDirection(block 时它恒为 row)
`);
        return;
    }

    const url = argValue(argv, '--url');
    const probesPath = argValue(argv, '--probes');
    const side = argValue(argv, '--side', 'actual');
    const preload = argValue(argv, '--preload');
    const waitSel = argValue(argv, '--wait');
    const outPath = argValue(argv, '--out');
    const vp = parseViewport(argValue(argv, '--viewport'));

    if (!url) throw new Error('--url required');
    if (!probesPath) throw new Error('--probes required');
    if (!['expected', 'actual'].includes(side)) throw new Error('--side must be expected|actual');

    const fs = await import('node:fs/promises');
    const cfg = JSON.parse(await fs.readFile(probesPath, 'utf8'));
    const probes = cfg.probes ?? [];

    const result = await withSession(async (session) => {
        await fixViewport(session, vp);
        // ★ 顺序:preload → 导航 → 采集(必须在同一 session)
        if (preload) await addPreload(session, preload);
        await navigateAndWait(session, url);
        if (waitSel) await waitForSelector(session, waitSel);
        await waitRAF(session);

        const items = [];
        for (const p of probes) {
            items.push(await collectProbe(session, p, side));
        }
        return {
            side,
            url,
            viewport: vp,
            collectedAt: new Date().toISOString(),
            count: items.length,
            items,
        };
    });

    const json = JSON.stringify(result, null, 2);
    if (outPath) {
        await fs.writeFile(outPath, json);
        console.log(`geo-collect: ${result.count} probes -> ${outPath} (side=${side})`);
        const missing = result.items.filter(i => i.missing);
        if (missing.length) {
            for (const m of missing) console.warn(`  ⚠ missing: ${m.name} — ${m.reason}`);
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
