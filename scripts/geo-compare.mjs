#!/usr/bin/env node
// verify-suite / scripts / geo-compare.mjs
//
// 路线 A 比对:逐字段差值,带容差策略 + 方向标注。
//
// 用法:
//   node scripts/geo-compare.mjs <expected.json> <actual.json> <probes.json>
//        [--label-exp <名称>] [--label-act <名称>] [--tol N]
//
// 退出码: 0 无差异 | 1 执行错误 | 2 检出差异

import { argValue, hasFlag } from './lib/args.mjs';
import { toleranceFor } from './lib/tolerance.mjs';

/**
 * ★★ 方向标注(文档 §4.4):必须写出哪边是哪边。
 *    早期输出 "inLeft 8 vs 12" 没标注方向,读的人把方向读反,
 *    一路怀疑到"是不是服务跑错了/产物过期了",白白损失整轮排查时间。
 */
function describeDiff(field, expVal, actVal, tol, labelExp, labelAct) {
    const d = actVal - expVal;
    const dir = d > 0 ? `${labelAct}偏大` : d < 0 ? `${labelAct}偏小` : '相等';
    const abs = Math.abs(d);
    const ok = abs <= tol;
    const tolText = tol === 0 ? 'strict(零容差)' : `容差±${tol}`;
    if (ok) {
        return { ok, line: `  ✅ ${field}  ${labelAct} ${actVal} ←→ ${labelExp} ${expVal}  (${dir} ${d > 0 ? '+' : ''}${d}, ${tolText})` };
    }
    return { ok, line: `  ❌ ${field}  ${labelAct} ${actVal} ←→ ${labelExp} ${expVal}  (${dir} ${d > 0 ? '+' : ''}${d}, ${tolText})` };
}

function compareValue(field, expVal, actVal, tol, labelExp, labelAct) {
    // 数值
    if (typeof expVal === 'number' && typeof actVal === 'number') {
        if (!Number.isFinite(expVal) || !Number.isFinite(actVal)) {
            return { ok: false, line: `  ⚠ ${field}  ${labelAct} ${actVal} ←→ ${labelExp} ${expVal}  (非有限值)` };
        }
        return describeDiff(field, expVal, actVal, tol, labelExp, labelAct);
    }
    // 布尔 / 字符串
    const ok = String(expVal) === String(actVal);
    return {
        ok,
        line: `  ${ok ? '✅' : '❌'} ${field}  ${labelAct} ${JSON.stringify(actVal)} ←→ ${labelExp} ${JSON.stringify(expVal)}${ok ? '' : '  (不相等, 零容差)'}`,
    };
}

async function main() {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, '--help') || argv.length < 3) {
        console.log(`geo-compare · 路线 A 比对

用法:
  node scripts/geo-compare.mjs <expected.json> <actual.json> <probes.json>
       [--label-exp <名称>] [--label-act <名称>] [--tol N]

说明:
  - strict 字段零容差;其余数值字段默认 ±1px(连续量抖动)
  - 输出带方向与修复提示,例:
      ❌ inLeft  产线 8 ←→ demo 12  (产线偏小 -4, strict)
  - 有 FAIL 时退出码 2(便于接 CI)
`);
        return;
    }

    const [expPath, actPath, probesPath] = argv;
    const labelExp = argValue(argv, '--label-exp', 'demo');
    const labelAct = argValue(argv, '--label-act', '产线');
    const globalTol = Number(argValue(argv, '--tol', '1'));

    const fs = await import('node:fs/promises');
    const exp = JSON.parse(await fs.readFile(expPath, 'utf8'));
    const act = JSON.parse(await fs.readFile(actPath, 'utf8'));
    const cfg = JSON.parse(await fs.readFile(probesPath, 'utf8'));
    const probeMap = new Map((cfg.probes ?? []).map(p => [p.name, p]));

    // ★ P0-1:任一侧输入快照为空或缺少必需字段 = 执行错误,绝不落到 0(无差异)或 2(检出差异)。
    if (!exp || !Array.isArray(exp.items) || !act || !Array.isArray(act.items)) {
        console.error('geo-compare: 输入快照缺少 items 字段 —— 执行错误(退出码 1),不是无差异');
        process.exit(1);
    }
    if (exp.items.length === 0 || act.items.length === 0) {
        console.error('geo-compare: 任一侧输入快照为空 —— 这是采集失败,不是无差异。执行错误(退出码 1)');
        process.exit(1);
    }

    const expMap = new Map(exp.items.map(i => [i.name, i]));
    const actMap = new Map(act.items.map(i => [i.name, i]));

    let failed = 0, passed = 0;
    const lines = [];

    lines.push(`geo-compare: ${labelExp} (${expPath}) ←→ ${labelAct} (${actPath})`);
    lines.push('');

    const names = new Set([...expMap.keys(), ...actMap.keys()]);
    for (const name of names) {
        const e = expMap.get(name);
        const a = actMap.get(name);
        const probe = probeMap.get(name) ?? {};
        const strict = probe.strict ?? [];
        const ignore = new Set(probe.ignore ?? []);
        const tol = probe.tolerance ?? globalTol;

        if (!e || e.missing) {
            lines.push(`  ⚠ ${name}: 基准侧未采集到(${e?.reason ?? 'missing'})`);
            failed++;
            continue;
        }
        if (!a || a.missing) {
            lines.push(`  ⚠ ${name}: 实测侧未采集到(${a?.reason ?? 'missing'})`);
            failed++;
            continue;
        }

        // 逐字段比对(取探针声明字段与实测字段的交集)
        const fields = (probe.fields ?? Object.keys(a)).filter(f => !ignore.has(f) && f in a && f in e && f !== '_rect');
        if (fields.length === 0) {
            lines.push(`  ⚠ ${name}: 无可比对字段`);
            continue;
        }

        const fieldResults = [];
        for (const f of fields) {
            const t = toleranceFor(f, strict, tol);
            fieldResults.push(compareValue(f, e[f], a[f], t, labelExp, labelAct));
        }
        const bad = fieldResults.filter(r => !r.ok);
        if (bad.length === 0) {
            passed++;
            const first = fieldResults.map(r => r.line.trim()).join(' | ');
            lines.push(`  ✅ ${name}  ${fields.length} 字段全部通过`);
            if (process.env.VERIFY_VERBOSE) lines.push(...fieldResults.map(r => '   ' + r.line));
        } else {
            failed++;
            lines.push(`  ❌ ${name}`);
            lines.push(...fieldResults.map(r => r.line));
        }
    }

    console.log(lines.join('\n'));
    console.log('');
    console.log(`汇总: 通过 ${passed} · 差异 ${failed}`);
    if (failed > 0) {
        console.log(`结论: 检出差异,退出码 2`);
        process.exitCode = 2;
    } else {
        console.log(`结论: 无差异,退出码 0`);
        // ⚠ 提示:全绿有两种可能 —— 两边确实等价,或检测器没工作(文档 §6.1)
        console.log(`⚠ 提醒:全绿不能证明等价,请用 --probes 故意注入一条已知故障复核检测器是否工作`);
        process.exitCode = 0;
    }
}

main().catch(err => {
    console.error('error:', err.message ?? err);
    if (process.env.VERIFY_DEBUG) console.error(err.stack);
    process.exit(1);
});
