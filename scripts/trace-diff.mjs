#!/usr/bin/env node
// verify-suite / scripts / trace-diff.mjs
//
// 轨迹比对:两侧各自对照同一份语义断言,再比达成情况。
//
// 用法:
//   node scripts/trace-diff.mjs <trace-expected.json> <trace-actual.json> <trace.json> [--verbose]
//
// ★★ 关键设计(付出过代价的教训):
//   ❌ 第一版:比较两侧每步的节点变化量是否一致
//      实际情况:demo 用 mock 10 条、产线真实 20 条
//      结果:demo 侧新增 57、产线侧新增 54 → 报"变化量不同"
//            82 项噪声把真实迁移差异完全掩盖
//      根因:两边数据量本来就不同时,"比总数"不是可判定命题
//   ✅ 修正:轨迹里写 expect 语义断言,两侧各自判定是否达成,再比达成情况
//      修正效果:82 项噪声 → 0 项差异
//
// 三种结果各有明确含义(第三行是自动化能否长期维护的分水岭):
//   两侧都达成    → 行为等价 ✓
//   仅一侧不达成  → 真差异,改代码 ✗
//   两侧都不达成  → ★ 断言本身写错了,改断言不是改代码 ⚠️
//
// 退出码: 0 全部两侧达成 | 1 执行错误 | 2 检出差异/断言未达成

import { argValue, hasFlag } from './lib/cdp.mjs';

async function main() {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, '--help') || argv.length < 2) {
        console.log(`trace-diff · 轨迹比对(两侧各对照同一份语义断言)

用法:
  node scripts/trace-diff.mjs <trace-expected.json> <trace-actual.json> <trace.json> [--verbose]

三种结果:
  两侧都达成    → 行为等价 ✓
  仅一侧不达成  → 真差异,改代码 ✗
  两侧都不达成  → 断言本身写错了,改断言不是改代码 ⚠️

★ 比的是"断言是否达成",不是"两侧变化量是否相同"
  (两侧数据量不同时,后者不是可判定命题)
`);
        return;
    }

    const [expPath, actPath, tracePath] = argv;
    const verbose = hasFlag(argv, '--verbose');
    const labelExp = argValue(argv, '--label-exp', 'demo');
    const labelAct = argValue(argv, '--label-act', '产线');

    const fs = await import('node:fs/promises');
    const exp = JSON.parse(await fs.readFile(expPath, 'utf8'));
    const act = JSON.parse(await fs.readFile(actPath, 'utf8'));
    let trace = null;
    if (tracePath) { try { trace = JSON.parse(await fs.readFile(tracePath, 'utf8')); } catch (_) {} }

    const expSteps = exp.steps ?? [];
    const actSteps = act.steps ?? [];
    const n = Math.max(expSteps.length, actSteps.length);

    let bothOk = 0, oneSideFail = 0, bothFail = 0;
    const lines = [];
    lines.push(`trace-diff: ${labelExp} (${expPath}) ←→ ${labelAct} (${actPath})`);
    lines.push('');

    for (let i = 0; i < n; i++) {
        const E = expSteps[i], A = actSteps[i];
        const label = E?.label ?? A?.label ?? `step ${i}`;
        lines.push(`步骤 [${i}] ${label}`);

        if (!E || !A) {
            lines.push(`  ⚠ 一侧缺少该步骤(${!E ? labelExp : labelAct} 没有),无法比对`);
            oneSideFail++;
            continue;
        }

        const eMap = new Map();
        for (const a of E.assertions) eMap.set(assertKey(a), a);
        const aMap = new Map();
        for (const a of A.assertions) aMap.set(assertKey(a), a);

        const keys = new Set([...eMap.keys(), ...aMap.keys()]);
        for (const k of keys) {
            const e = eMap.get(k), a = aMap.get(k);
            if (!e || !a) {
                lines.push(`  ⚠ ${k}  仅一侧存在该断言`);
                oneSideFail++;
                continue;
            }
            const name = e.target ?? e.expect ?? k;
            if (e.ok && a.ok) {
                bothOk++;
                if (verbose) lines.push(`  ✅ ${e.kind} ${name}   两侧都达成`);
            } else if (e.ok !== a.ok) {
                oneSideFail++;
                const badSide = e.ok ? labelAct : labelExp;
                const detail = (e.ok ? a : e).detail ?? '';
                lines.push(`  ❌ ${e.kind} ${name}   仅 ${badSide} 未达成 — ${detail}   ← 真差异,改代码`);
            } else {
                bothFail++;
                const detail = e.detail ?? a.detail ?? '';
                lines.push(`  ⚠️ ${e.kind} ${name}   两侧都不达成 — ${detail}   ← 断言本身写错了,改断言不是改代码`);
            }
        }
        lines.push('');
    }

    const total = bothOk + oneSideFail + bothFail;
    console.log(lines.join('\n'));
    console.log('─'.repeat(60));
    console.log(`汇总: 共 ${total} 条断言`);
    console.log(`  ✓ 两侧都达成      ${bothOk}   → 行为等价`);
    console.log(`  ✗ 仅一侧不达成    ${oneSideFail}   → 真差异,改代码`);
    console.log(`  ⚠ 两侧都不达成    ${bothFail}   → 断言写错了,改断言(不是改代码)`);

    if (bothFail > 0 && oneSideFail === 0) {
        console.log('');
        console.log(`⚠ 全部未达成都来自"两侧都不达成" —— 先改断言再重跑,不要去动被测代码`);
    }

    if (oneSideFail > 0 || bothFail > 0) {
        console.log('\n结论: 检出差异,退出码 2');
        process.exitCode = 2;
    } else {
        console.log('\n结论: 两侧断言全部达成,退出码 0');
        if (total === 0) {
            console.log('⚠ 0 条断言被比对 —— 检查 trace-run 是否真的执行了步骤');
        } else {
            console.log('⚠ 提醒:全绿不能证明等价 —— 请注入一条已知会失败的断言复核(文档 §6.1)');
        }
        process.exitCode = 0;
    }
}

function assertKey(a) {
    return `${a.kind}:${a.target ?? a.expect ?? ''}`;
}

main().catch(err => {
    console.error('error:', err.message ?? err);
    if (process.env.VERIFY_DEBUG) console.error(err.stack);
    process.exit(1);
});
