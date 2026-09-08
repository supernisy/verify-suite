#!/usr/bin/env node
// verify-suite / scripts / ax-diff.mjs
//
// 通用比对器(路线 B / C 共用)。
//
// 用法:
//   node scripts/ax-diff.mjs <expected.json> <actual.json> [--tol 1]
//        [--include-nameless] [--label-exp <名称>] [--label-act <名称>]
//
// 四档对齐:
//   1. 精确:指纹完全相同
//   2. 模糊:role 相同 + 纵向位置接近(≤32px) + 文案相似度 ≥ 0.5
//   3. 单侧:仅基准有(实现缺失) / 仅实测有(实现多余)
//   4. 跳过:无名节点(指纹退化为 `role|`),默认跳过并单独统计
//
// 退出码: 0 无差异 | 1 执行错误 | 2 检出差异

import { argValue, hasFlag } from './lib/args.mjs';

/**
 * ★ 容器类 role 只能比自身尺寸。
 *   它们的"第一个文本/图标"距离很远,会算出 iconGap: -14、vBias: -417 这种垃圾值。
 */
const CONTAINER_ROLES = new Set([
    'navigation', 'complementary', 'main', 'banner', 'contentinfo', 'region',
    'form', 'group', 'article', 'section', 'toolbar', 'menu', 'menubar',
    'tablist', 'table', 'row', 'rowgroup', 'grid', 'tree', 'listbox', 'list',
]);

/** 容器只比这些字段 */
const CONTAINER_FIELDS = ['boxW', 'boxH', 'bg', 'radius', 'hasShadow'];

/** 要比对的度量字段(排除元数据) */
const MEASURE_FIELDS = [
    'boxW', 'boxH', 'inLeft', 'inRight', 'inTop',
    'iconGap', 'iconSize', 'vBias',
    'fontSize', 'fontWeight', 'textColor', 'radius', 'bg', 'hasShadow',
];

/** 离散设计 token —— 零容差(差 1 就是选错档,不是抖动) */
const DISCRETE_FIELDS = new Set(['fontSize', 'fontWeight', 'radius', 'iconSize']);

/** 模糊配对的纵向位置阈值 */
const FUZZY_DY = 32;
/** 模糊配对的文案相似度阈值(★ 不能放松,宁可报成缺失+多余) */
const FUZZY_SIM = 0.5;

/**
 * 字符级 Jaccard 相似度。
 * 中文短文本用 bigram 会过严 —— 实测「技能」vs「技能市场」bigram 只有 0.33,
 * 达不到 0.5 阈值,会漏掉真实的文案漂移;字符级为 2/4 = 0.5,正好命中。
 */
function similarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = new Set(a), B = new Set(b);
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    const uni = A.size + B.size - inter;
    return uni === 0 ? 0 : inter / uni;
}

function cmpField(field, ev, av, tol, labelExp, labelAct) {
    if (ev == null && av == null) return null;
    if (ev == null || av == null) {
        return { ok: false, line: `  ❌ ${field}  ${labelAct} ${JSON.stringify(av)} ←→ ${labelExp} ${JSON.stringify(ev)}  (一侧缺失)` };
    }
    if (typeof ev === 'number' && typeof av === 'number') {
        const t = DISCRETE_FIELDS.has(field) ? 0 : tol;
        const d = av - ev;
        const ok = Math.abs(d) <= t;
        const dir = d > 0 ? `${labelAct}偏大` : d < 0 ? `${labelAct}偏小` : '相等';
        const tolText = t === 0 ? 'strict' : `容差±${t}`;
        return {
            ok,
            line: `  ${ok ? '✅' : '❌'} ${field}  ${labelAct} ${av} ←→ ${labelExp} ${ev}  (${dir} ${d > 0 ? '+' : ''}${d}, ${tolText})`,
        };
    }
    const ok = String(ev) === String(av);
    return {
        ok,
        line: `  ${ok ? '✅' : '❌'} ${field}  ${labelAct} ${JSON.stringify(av)} ←→ ${labelExp} ${JSON.stringify(ev)}`,
    };
}

async function main() {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, '--help') || argv.length < 2) {
        console.log(`ax-diff · 通用比对器(路线 B / C 共用)

用法:
  node scripts/ax-diff.mjs <expected.json> <actual.json> [--tol 1]
       [--include-nameless] [--label-exp <名称>] [--label-act <名称>]
       [--json <file>]

四档对齐:
  精确  指纹完全相同
  模糊  role 相同 + 纵向位置 ≤32px + 文案相似度 ≥0.5
  单侧  仅基准有(实现缺失) / 仅实测有(实现多余)
  跳过  无名节点(指纹退化为 role|),默认跳过并单独统计

★ 模糊阈值不放松:宁可报成"缺失+多余"让人判断,也不要错配后输出一堆假度量差异
★ 容器 role(navigation/list/main...)只比 boxW/boxH/bg/radius/hasShadow
★★ 差值输出带方向标注(谁偏大/偏小),不写方向会让人读反
`);
        return;
    }

    const [expPath, actPath] = argv;
    const tol = Number(argValue(argv, '--tol', '1'));
    const labelExp = argValue(argv, '--label-exp', 'demo');
    const labelAct = argValue(argv, '--label-act', '产线');
    const includeNameless = hasFlag(argv, '--include-nameless');
    const jsonOut = argValue(argv, '--json');

    const fs = await import('node:fs/promises');
    const exp = JSON.parse(await fs.readFile(expPath, 'utf8'));
    const act = JSON.parse(await fs.readFile(actPath, 'utf8'));

    // ★ P0-1:任一侧输入快照为空或缺少必需字段 = 执行错误,绝不落到 0(无差异)或 2(检出差异)。
    if (!exp || !Array.isArray(exp.items) || !act || !Array.isArray(act.items)) {
        console.error('ax-diff: 输入快照缺少 items 字段 —— 执行错误(退出码 1),不是无差异');
        process.exit(1);
    }
    if (exp.items.length === 0 || act.items.length === 0) {
        console.error('ax-diff: 任一侧输入快照为空 —— 这是采集失败,不是无差异。执行错误(退出码 1)');
        process.exit(1);
    }

    const expItems = (exp.items ?? []).filter(i => includeNameless || i.normName);
    const actItems = (act.items ?? []).filter(i => includeNameless || i.normName);
    const namelessCount = (exp.items ?? []).length - expItems.length + ((act.items ?? []).length - actItems.length);

    // ---- 档 1:精确配对 ----
    const actByFp = new Map();
    for (const a of actItems) {
        const k = a.fp;
        if (!actByFp.has(k)) actByFp.set(k, []);
        actByFp.get(k).push(a);
    }
    // 同名多个:按网格顺序取用
    for (const [, arr] of actByFp) arr.sort((x, y) => (x.grid.gy - y.grid.gy) || (x.grid.gx - y.grid.gx));

    const usedAct = new Set();
    const exactPairs = [];
    const unmatchedExp = [];

    for (const e of expItems) {
        const arr = actByFp.get(e.fp);
        const pick = arr?.find(a => !usedAct.has(a));
        if (pick) {
            usedAct.add(pick);
            exactPairs.push([e, pick]);
        } else {
            unmatchedExp.push(e);
        }
    }
    const unmatchedAct = actItems.filter(a => !usedAct.has(a));

    // ---- 档 2:模糊配对 ----
    const fuzzyPairs = [];
    const stillExp = [];
    for (const e of unmatchedExp) {
        let best = null, bestScore = 0;
        for (const a of unmatchedAct) {
            if (a.__used) continue;
            if (a.role !== e.role) continue;
            const dy = Math.abs((a.grid.gy * 8) - (e.grid.gy * 8));
            if (dy > FUZZY_DY) continue;
            const sim = similarity(e.normName, a.normName);
            if (sim < FUZZY_SIM) continue;
            const score = sim - dy / 1000;
            if (score > bestScore) { bestScore = score; best = a; }
        }
        if (best) {
            best.__used = true;
            fuzzyPairs.push([e, best, bestScore]);
        } else {
            stillExp.push(e);
        }
    }
    const onlyAct = unmatchedAct.filter(a => !a.__used);

    // ---- 逐对比对度量 ----
    const out = [];
    let diffCount = 0;

    const diffPair = (e, a, kind) => {
        const isContainer = CONTAINER_ROLES.has(e.role) || CONTAINER_ROLES.has(a.role);
        const fields = isContainer ? CONTAINER_FIELDS : MEASURE_FIELDS;
        const results = [];
        for (const f of fields) {
            const r = cmpField(f, e[f], a[f], tol, labelExp, labelAct);
            if (r && !r.ok) results.push(r);
        }
        if (results.length === 0) return null;
        diffCount += results.length;
        const tag = isContainer ? '[容器]' : '';
        return `  ❌ [${kind}] ${tag} ${e.fp}\n` + results.map(r => '   ' + r.line.trim()).join('\n');
    };

    for (const [e, a] of exactPairs) {
        const s = diffPair(e, a, '精确');
        if (s) out.push(s);
    }
    for (const [e, a, score] of fuzzyPairs) {
        const s = diffPair(e, a, `模糊 ${score.toFixed(2)}`);
        const drift = e.normName !== a.normName
            ? `  ⚠ [文案漂移] ${labelExp} "${e.name}" ←→ ${labelAct} "${a.name}" (相似度 ${(similarity(e.normName, a.normName)).toFixed(2)})`
            : null;
        if (s || drift) {
            out.push([s, drift].filter(Boolean).join('\n'));
            if (drift) diffCount++;
        }
    }

    // ---- 输出 ----
    const lines = [];
    lines.push(`ax-diff: ${labelExp} (${expPath}) ←→ ${labelAct} (${actPath})`);
    lines.push('');
    lines.push(`档位统计: 精确 ${exactPairs.length} · 模糊 ${fuzzyPairs.length} · 仅基准 ${stillExp.length} · 仅实测 ${onlyAct.length}` + (namelessCount ? ` · 跳过(无名) ${namelessCount}` : ''));
    lines.push('');

    if (stillExp.length) {
        lines.push(`— 仅基准侧存在(实现缺失,${stillExp.length}) —`);
        for (const e of stillExp.slice(0, 40)) {
            const nm = e.name ? ` "${e.name.slice(0, 40)}"` : '';
            lines.push(`  ⚠ ${e.fp}${nm}  @${e.rect.left},${e.rect.top}`);
        }
        if (stillExp.length > 40) lines.push(`  ... 还有 ${stillExp.length - 40} 项`);
        lines.push('');
    }
    if (onlyAct.length) {
        lines.push(`— 仅实测侧存在(实现多余,${onlyAct.length}) —`);
        for (const a of onlyAct.slice(0, 40)) {
            const nm = a.name ? ` "${a.name.slice(0, 40)}"` : '';
            lines.push(`  ⚠ ${a.fp}${nm}  @${a.rect.left},${a.rect.top}`);
        }
        if (onlyAct.length > 40) lines.push(`  ... 还有 ${onlyAct.length - 40} 项`);
        lines.push('');
    }
    if (out.length) {
        lines.push(`— 度量差异(${out.length} 组) —`);
        lines.push(...out.slice(0, 60));
        if (out.length > 60) lines.push(`  ... 还有 ${out.length - 60} 组`);
        lines.push('');
    }

    console.log(lines.join('\n'));
    console.log(`汇总: 差异项 ${diffCount} · 仅基准 ${stillExp.length} · 仅实测 ${onlyAct.length}`);

    if (jsonOut) {
        await fs.writeFile(jsonOut, JSON.stringify({
            exact: exactPairs.length, fuzzy: fuzzyPairs.length,
            onlyExpected: stillExp.map(e => ({ fp: e.fp, name: e.name, rect: e.rect })),
            onlyActual: onlyAct.map(a => ({ fp: a.fp, name: a.name, rect: a.rect })),
            diffs: out,
        }, null, 2));
        console.log(`JSON 报告: ${jsonOut}`);
    }

    const hasDiff = diffCount > 0 || stillExp.length > 0 || onlyAct.length > 0;
    if (hasDiff) {
        console.log('结论: 检出差异,退出码 2');
        process.exitCode = 2;
    } else {
        console.log('结论: 无差异,退出码 0');
        console.log('⚠ 提醒:全绿不能证明等价 —— 请注入一条已知故障复核检测器是否工作(文档 §6.1)');
        process.exitCode = 0;
    }
}

main().catch(err => {
    console.error('error:', err.message ?? err);
    if (process.env.VERIFY_DEBUG) console.error(err.stack);
    process.exit(1);
});
