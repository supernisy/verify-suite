/**
 * 判据层 · 命令行参数解析
 *
 * 这是**纯函数层**：不依赖 CDP、不依赖浏览器、不依赖文件系统。
 * 抽取目的(P0-2)：让比对器(ax-diff / geo-compare / trace-diff)可以不依赖
 * 驱动层独立运行 —— 判定能力是被保护资产,驱动能力是会被商品化的适配器。
 *
 * 分层约束：本文件不得 import 任何 scripts/lib/cdp.mjs 的内容。
 * 由 `npm run check:layering` 强制检查。
 */

/**
 * 取 `--name value` 形式的参数值。
 *
 * ★ 5.1 踩过的坑：indexOf 未命中时 -1+1=0 会取到第一个位置参数,
 *   parseInt 得 NaN,Math.abs(d) <= NaN 永远 false → 全量误报。
 *   必须先判 i >= 0。
 *
 * @param {string[]} argv
 * @param {string} name 形如 `--out`
 * @param {*} fallback
 */
export function argValue(argv, name, fallback) {
    const i = argv.indexOf(name);
    if (i < 0) return fallback;
    const v = argv[i + 1];
    return v === undefined ? fallback : v;
}

/**
 * 判断开关型参数是否存在,如 `--debug`。
 * @param {string[]} argv
 * @param {string} name
 */
export function hasFlag(argv, name) {
    return argv.includes(name);
}

/**
 * 数字型参数：取不到或非法时回退默认值。
 * 与 argValue 的区别：保证返回值一定是有限数字,避免 NaN 穿透到比较逻辑。
 *
 * @param {string[]} argv
 * @param {string} name
 * @param {number} fallback
 */
export function argNumber(argv, name, fallback) {
    const raw = argValue(argv, name, undefined);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}
