#!/usr/bin/env node
/**
 * 分层守卫 · check:layering
 *
 * P0-2 的核心约束：**判定层必须能脱离驱动层独立运行**。
 *
 * 为什么要有这个检查：
 *   驱动能力(CDP / 浏览器 / 自动化框架)会被商品化、会被替换、会被更便宜的方案
 *   吃掉；判定能力(容差规则 / 对齐判据 / 断言语义)才是这个仓库真正的资产。
 *   一旦比对器顺手 import 了 lib/cdp.mjs 里的某个工具函数，判定层就被驱动层
 *   悄悄绑死了 —— 换驱动时就得重写判据。这种耦合是渐进发生的，靠人眼守不住。
 *
 * 规则：
 *   1. 判定层脚本(比对器)不得 import scripts/lib/cdp.mjs
 *   2. 判据层 lib(args.mjs / tolerance.mjs)不得 import 驱动层
 *   3. 判据层 lib 不得 import 任何 Node 内置之外的东西(保持纯函数)
 *
 * 退出码:0 = 分层健康 | 1 = 检出违规或执行错误
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'scripts');
const LIB = join(SCRIPTS, 'lib');

/** 判定层：只看数据、产出结论，不需要浏览器 */
const JUDGMENT_SCRIPTS = [
    'ax-diff.mjs',
    'geo-compare.mjs',
    'trace-diff.mjs',
    'behavior-diff.mjs',
];

/** 判据层 lib：纯函数，零驱动依赖 */
const JUDGMENT_LIBS = ['args.mjs', 'tolerance.mjs'];

const violations = [];

function checkNoRef(file, label, forbidden) {
    let src;
    try {
        src = readFileSync(file, 'utf8');
    } catch {
        return; // 文件还不存在(如 behavior-diff 未实现)则跳过
    }
    src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return; // 跳过注释
        for (const bad of forbidden) {
            if (line.includes(bad)) {
                violations.push(`  ✗ ${label} (${file.split(/[\\/]/).pop()}:${i + 1}) 引用了驱动层\n      ${line.trim()}`);
                break; // 同一行只报一次
            }
        }
    });
}

// 规则 1:判定层脚本不得依赖驱动层
for (const f of JUDGMENT_SCRIPTS) {
    checkNoRef(join(SCRIPTS, f), '判定层脚本', ['lib/cdp.mjs', "from './lib/cdp.mjs'"]);
}

// 规则 2:判据层 lib 不得依赖驱动层
for (const f of JUDGMENT_LIBS) {
    checkNoRef(join(LIB, f), '判据层 lib', ['cdp.mjs', 'node:child_process']);
}

// 规则 3:驱动层不得反向依赖判据层(保持单向:脚本 → 判据层 / 脚本 → 驱动层)
checkNoRef(join(LIB, 'cdp.mjs'), '驱动层 lib', ["from './args.mjs'", "from './tolerance.mjs'"]);

if (violations.length > 0) {
    console.error('分层检查未通过 —— 判定层被驱动层耦合:');
    console.error(violations.join('\n'));
    console.error('\n修复:把用到的纯函数迁到 scripts/lib/args.mjs 或 scripts/lib/tolerance.mjs,');
    console.error('      再从判据层 import,而不是从 lib/cdp.mjs。');
    process.exit(1);
}

const checked = [...JUDGMENT_SCRIPTS, ...JUDGMENT_LIBS.map(f => `lib/${f}`)];
console.log('分层检查通过 —— 判定层与驱动层解耦');
console.log(`  已检查: ${checked.join(', ')}`);
process.exit(0);
