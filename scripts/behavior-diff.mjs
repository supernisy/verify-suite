#!/usr/bin/env node
/**
 * 路线 E · 行为契约比对(behavior-diff)
 *
 * ★ 关键设计(与 trace-diff 同构):**两侧各自对照同一份断言**,
 *   而不是"比较两侧的变化量是否相同"。
 *   两侧业务数据量本来就不同,比变化量不是可判定命题。
 *
 * 三种结果:
 *   两侧都达成    → 通过 ✓
 *   仅一侧不达成  → 真差异,改代码 ✗
 *   两侧都不达成  → 断言本身写错了,改断言不是改代码 ⚠️
 *
 * ★ 只断言结构,不断言业务数值:字段存不存在、类型对不对可以判,
 *   id 等于几、金额多少不判(那是业务测试的事,不是还原度的事)。
 *
 * 用法:
 *   node scripts/behavior-diff.mjs <expected.json> <actual.json>
 *        --behavior <behavior.json> [--label-exp 设计稿] [--label-act 产线]
 *
 * 退出码: 0=全部达成 | 1=执行错误(输入空/缺字段) | 2=检出差异
 */
import { argValue, hasFlag } from './lib/args.mjs';
import { summarizeEvidence } from './lib/evidence.mjs';

const argv = process.argv.slice(2);

if (hasFlag(argv, '--help') || argv.length === 0) {
    console.log(`behavior-diff · 路线 E 行为契约比对

用法:
  node scripts/behavior-diff.mjs <expected.json> <actual.json> --behavior <behavior.json>
       [--label-exp 设计稿] [--label-act 产线]

三种结果:
  两侧都达成    → 通过 ✓
  仅一侧不达成  → 真差异,改代码 ✗
  两侧都不达成  → 断言本身写错了,改断言不是改代码 ⚠️

退出码: 0=全部达成 | 1=执行错误 | 2=检出差异
`);
    process.exit(0);
}

// ---------------------------------------------------------------------------
// 单侧对照:把一侧的观测事实对照同一份断言
// ---------------------------------------------------------------------------

function matchNetwork(obs, rule) {
    const re = rule.urlPattern ? new RegExp(rule.urlPattern) : null;
    const hit = obs.find(n => {
        if (rule.method && n.method !== rule.method) return false;
        if (re && !re.test(n.url)) return false;
        if (rule.bodyFields?.length) {
            if (!rule.bodyFields.every(f => (n.bodyFields ?? []).includes(f))) return false;
        }
        return true;
    });
    return hit
        ? { ok: true }
        : { ok: false, detail: `无匹配的${rule.method ?? ''}请求 ${rule.urlPattern ?? '*'}` };
}

function matchConsole(obs, rule) {
    const re = new RegExp(rule.pattern);
    const hit = obs.find(c => re.test(c.text));
    return hit ? { ok: true } : { ok: false, detail: `console 无匹配 /${rule.pattern}/` };
}

/** 响应 schema:只判存在性与类型,★ 不断言业务数值 */
function matchSchema(responses, rule) {
    const re = new RegExp(rule.urlPattern);
    const hit = responses.find(r => re.test(r.url));
    if (!hit) return { ok: false, detail: '未捕获到该响应' };
    if (!hit.types) return { ok: false, detail: '响应体未取到(非 JSON 或已被回收)' };
    for (const f of rule.fields ?? []) {
        const t = hit.types[f.path];
        if (t === undefined) return { ok: false, detail: `字段缺失 ${f.path}` };
        if (f.type && t !== f.type) {
            return { ok: false, detail: `字段 ${f.path} 类型 ${t} ≠ 期望 ${f.type}` };
        }
    }
    return { ok: true };
}

function matchArtifact(arts, rule) {
    const a = arts.find(x => x.path === rule.path);
    if (!a) return { ok: false, detail: '未记录该产物' };
    if (!a.exists) return { ok: false, detail: '产物文件不存在' };
    const min = rule.minBytes ?? a.minBytes ?? 1;
    if (a.bytes < min) return { ok: false, detail: `产物 ${a.bytes}B < 最小 ${min}B` };
    return { ok: true };
}

/** 对一侧的一个步骤,算出每条断言的结果 */
function evaluateStep(step, expect) {
    const out = [];
    for (const rule of expect.network ?? []) {
        const name = `${rule.method ?? '*'} ${rule.urlPattern ?? '*'}`;
        out.push({ kind: 'network', name, ...matchNetwork(step.network ?? [], rule) });
    }
    for (const rule of expect.console ?? []) {
        out.push({ kind: 'console', name: `/${rule.pattern}/`, ...matchConsole(step.console ?? [], rule) });
    }
    for (const rule of expect.schema ?? []) {
        const name = `${rule.urlPattern} {${(rule.fields ?? []).map(f => f.path).join(',')}}`;
        out.push({ kind: 'schema', name, ...matchSchema(step.responses ?? [], rule) });
    }
    for (const rule of expect.artifacts ?? []) {
        out.push({ kind: 'artifact', name: rule.path, ...matchArtifact(step.artifacts ?? [], rule) });
    }
    return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
    const pos = argv.filter(a => !a.startsWith('--') && !a.startsWith('-'));
    const behaviorPath = argValue(argv, '--behavior');
    const labelExp = argValue(argv, '--label-exp', '基准');
    const labelAct = argValue(argv, '--label-act', '实测');

    if (pos.length < 2 || !behaviorPath) {
        console.error('用法: behavior-diff <expected.json> <actual.json> --behavior <behavior.json>');
        process.exitCode = 1;
        return;
    }

    const fs = await import('node:fs/promises');
    const exp = JSON.parse(await fs.readFile(pos[0], 'utf8'));
    const act = JSON.parse(await fs.readFile(pos[1], 'utf8'));
    const behavior = JSON.parse(await fs.readFile(behaviorPath, 'utf8'));

    // P0-1 原则 8:空结果不是无差异,是执行错误
    for (const [label, doc] of [[labelExp, exp], [labelAct, act]]) {
        if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
            console.error(`执行错误: ${label} 侧没有 steps —— 空结果不等于"没有行为差异",拒绝给出结论`);
            process.exitCode = 1;
            return;
        }
    }

    const cfgSteps = behavior.steps ?? [];
    const n = Math.max(exp.steps.length, act.steps.length, cfgSteps.length);

    console.log('行为契约 · 两侧各自对照同一份断言');
    console.log(`  ${labelExp}: ${pos[0]}`);
    console.log(`  ${labelAct}: ${pos[1]}`);
    console.log('');

    let total = 0, bothOk = 0, oneSideFail = 0, bothFail = 0;

    for (let i = 0; i < n; i++) {
        const eStep = exp.steps[i];
        const aStep = act.steps[i];
        const cfgStep = cfgSteps[i] ?? {};
        const label = cfgStep.label ?? eStep?.label ?? aStep?.label ?? `step-${i}`;
        console.log(`步骤 ${i}: ${label}`);

        if (!eStep || !aStep) {
            console.log(`  ⚠ 仅一侧存在该步骤(${eStep ? labelAct : labelExp} 缺失)`);
            oneSideFail++;
            total++;
            console.log('');
            continue;
        }

        const expect = cfgStep.expect ?? {};
        const eRes = evaluateStep(eStep, expect);
        const aRes = evaluateStep(aStep, expect);

        for (let k = 0; k < eRes.length; k++) {
            const e = eRes[k], a = aRes[k];
            total++;
            if (e.ok && a.ok) {
                bothOk++;
                console.log(`  ✓ ${e.kind} ${e.name}`);
            } else if (!e.ok && !a.ok) {
                bothFail++;
                console.log(`  ⚠️ ${e.kind} ${e.name}   两侧都不达成 — ${e.detail}   ← 断言本身写错了,改断言不是改代码`);
            } else {
                oneSideFail++;
                const bad = e.ok ? labelAct : labelExp;
                const detail = e.ok ? a.detail : e.detail;
                console.log(`  ✗ ${e.kind} ${e.name}   仅 ${bad} 未达成 — ${detail}   ← 真差异,改代码`);
            }
        }
        console.log('');
    }

    console.log(`汇总: 共 ${total} 条断言`);
    console.log(`  ✓ 两侧都达成     ${bothOk}`);
    console.log(`  ✗ 仅一侧不达成   ${oneSideFail}   → 真差异,改代码`);
    console.log(`  ⚠️ 两侧都不达成  ${bothFail}   → 断言本身写错了,改断言不是改代码`);

    // P1-5:结论必须标注它依据的最低证据档位,以及是否发生过降级
    console.log(summarizeEvidence([
        { ...exp, items: exp.steps },
        { ...act, items: act.steps },
    ]).line);

    if (oneSideFail > 0 || bothFail > 0) {
        console.log('\n结论: 检出差异,退出码 2');
        process.exitCode = 2;
    } else if (total === 0) {
        console.log('\n执行错误: 一条断言都没执行');
        process.exitCode = 1;
    } else {
        console.log('\n结论: 两侧断言全部达成,退出码 0');
        console.log('注意: 全绿只说明断言都过了,不代表两侧等价 —— 断言覆盖不到的行为仍然可能不同。');
        process.exitCode = 0;
    }
}

try {
    await main();
} catch (err) {
    console.error(`执行错误: ${err.message}`);
    process.exitCode = 1;
}
