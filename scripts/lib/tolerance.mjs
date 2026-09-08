/**
 * 判据层 · 容差策略
 *
 * 纯规则层：输入字段名与配置,输出该字段允许的差值。不碰 CDP、不碰 DOM。
 *
 * 核心原则(AGENTS.md 原则 7)：**容差按量纲分类**
 *   - 连续量(位置/尺寸)：±1px —— 亚像素与取整误差
 *   - 离散设计 token(字号/字重/圆角/图标尺寸)：零容差 —— 差 1 就是选错档
 *
 * 为什么离散量必须零容差：给 fontSize 设 ±1 会吞掉「13 vs 14」这类真实差异,
 * 而设计系统里 13 和 14 是两个不同档位,不是误差。
 *
 * 分层约束：本文件不得 import 任何 scripts/lib/cdp.mjs 的内容。
 */

/** 默认零容差的离散设计 token 字段 */
export const STRICT_FIELDS = new Set([
    'fontSize',
    'fontWeight',
    'radius',
    'borderRadius',
    'iconSize',
    'lineHeight',
]);

/**
 * 判断字段允许的容差。
 *
 * @param {string} field 字段名
 * @param {string[]} strictList 探针配置里显式声明的 strict 字段
 * @param {number} defaultTol 连续量的默认容差(默认 ±1px)
 * @returns {number} 允许的绝对差值
 */
export function toleranceFor(field, strictList = [], defaultTol = 1) {
    if (strictList.includes(field)) return 0;
    if (STRICT_FIELDS.has(field)) return 0;
    return defaultTol;
}

/**
 * 比较两个数值是否超出容差。
 * 集中在这里是为了让「超出」的判定方式只有一处,避免各比对器各写一套。
 *
 * @param {number|string|null|undefined} a
 * @param {number|string|null|undefined} b
 * @param {number} tol
 * @returns {{ changed: boolean, delta: number|null, direction: 'exp-larger'|'act-larger'|'equal'|'non-numeric' }}
 */
export function compareNumeric(a, b, tol) {
    const na = typeof a === 'number' ? a : Number(String(a ?? '').replace(/px$/, ''));
    const nb = typeof b === 'number' ? b : Number(String(b ?? '').replace(/px$/, ''));
    if (!Number.isFinite(na) || !Number.isFinite(nb)) {
        return { changed: String(a) !== String(b), delta: null, direction: 'non-numeric' };
    }
    const delta = nb - na;
    const changed = Math.abs(delta) > tol;
    let direction = 'equal';
    if (changed) direction = delta > 0 ? 'act-larger' : 'exp-larger';
    return { changed, delta, direction };
}
