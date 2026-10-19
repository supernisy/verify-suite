// verify-suite / adapters / web-cdp / playwright-driver.mjs
//
// Playwright 驱动层（验证引擎）。
// 替代 scripts/lib/cdp.mjs 的裸 CDP，提供：
//   - getAXTree:  AX 树为感知主源（page.accessibility.snapshot()）
//   - locate:     语义定位 + strict mode（多命中即报错，不盲选）
//   - drive:      auto-wait 交互（Playwright actionability 自动等待，无需手写 sleep）
//   - assert:     web-first 可重试断言（失败信息含定位器 / 实际 / 期望）
//   - trace:      可回放轨迹（context.tracing）
//   - measure:    运行时几何 + 计算样式（替代 CDP MEASURE_FN）
//
// 设计纪律：AX 仍是 ground truth，截图仅用于 AX 盲区补位（由调用方决定）。

import { chromium } from 'playwright';

export class PlaywrightDriver {
    constructor(opts = {}) {
        this.headless = opts.headless ?? true;
        this.viewport = opts.viewport ?? { width: 1440, height: 900 };
        this.executablePath = opts.executablePath ?? undefined;
        this.tracePath = opts.tracePath ?? null;
        this._browser = null;
        this._context = null;
        this._page = null;
    }

    async launch() {
        this._browser = await chromium.launch({
            headless: this.headless,
            executablePath: this.executablePath,
        });
        this._context = await this._browser.newContext({ viewport: this.viewport });
        this._page = await this._context.newPage();
        if (this.tracePath) {
            await this._context.tracing.start({ screenshots: true, snapshots: true });
        }
        return this;
    }

    async close() {
        if (this.tracePath) {
            try { await this._context.tracing.stop({ path: this.tracePath }); } catch (_) {}
        }
        await this._browser?.close();
    }

    async goto(url, { preload } = {}) {
        if (preload) await this._page.addInitScript(preload);
        await this._page.goto(url, { waitUntil: 'load' });
        await this._raf();
    }

    async _raf() {
        await this._page.evaluate(
            () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        );
    }

    async waitForSelector(sel, { timeout = 15000 } = {}) {
        await this._page.waitForSelector(sel, { timeout, state: 'attached' });
    }

    // ---- AX 树作为感知主源（等价 CDP Accessibility.getFullAXTree）----
    async getAXTree() {
        return await this._page.accessibility.snapshot();
    }

    // ---- 语义定位 + strict mode ----
    // 命中多个 → Playwright strict 模式在动作时抛错，明确告知数量，不静默选第一个。
    locate({ role, name, text, strict = true } = {}) {
        if (role && name) return this._page.getByRole(role, { name, exact: false });
        if (role) return this._page.getByRole(role);
        if (text) return this._page.getByText(text);
        throw new Error('locate 需要 role / name / text 之一');
    }

    // ---- drive：auto-wait 交互（Playwright actionability 自动等待）----
    async click(target) { await target.click(); }
    async fill(target, text) { await target.fill(text); }
    async hover(target) { await target.hover(); }

    // ---- assert：web-first 可重试断言 ----
    // 轻量重试实现（不引入 @playwright/test），失败信息含定位器 + 实际值。
    async assertVisible(target, { timeout = 5000 } = {}) {
        const start = Date.now();
        let lastErr = '';
        while (Date.now() - start < timeout) {
            try {
                const box = await target.boundingBox();
                if (box && box.width > 0 && box.height > 0) return;
                lastErr = 'boundingBox 为空（元素不可见或零尺寸）';
            } catch (e) { lastErr = e.message; }
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`assertVisible 超时（${timeout}ms）: ${lastErr}`);
    }

    async assertText(target, expected, { timeout = 5000 } = {}) {
        const start = Date.now();
        let lastText;
        while (Date.now() - start < timeout) {
            try {
                lastText = (await target.innerText()).trim();
                if (lastText === String(expected).trim()) return;
            } catch (_) {}
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`assertText 超时: 期望 "${expected}" 实际 "${lastText}"`);
    }

    async assertCount(target, n, { timeout = 5000 } = {}) {
        const start = Date.now();
        let last;
        while (Date.now() - start < timeout) {
            try {
                last = await target.count();
                if (last === n) return;
            } catch (_) {}
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`assertCount 超时: 期望 ${n} 实际 ${last}`);
    }

    // ---- trace：可回放证据 ----
    async startTrace(path) {
        this.tracePath = path;
        await this._context.tracing.start({ screenshots: true, snapshots: true });
    }
    async stopTrace() {
        if (this.tracePath) {
            await this._context.tracing.stop({ path: this.tracePath });
            this.tracePath = null;
        }
    }

    // ---- measure：替代 CDP MEASURE_FN ----
    async measure(target) {
        return await target.evaluate((el) => {
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

    // 便捷：从 AX 树取出匹配语义 role 的节点列表（枚举遍用）
    async collectSemantic(roles) {
        const tree = await this.getAXTree();
        const out = [];
        const walk = (node) => {
            if (!node) return;
            if (node.role && roles.has(node.role)) out.push(node);
            (node.children || []).forEach(walk);
        };
        walk(tree);
        return out;
    }
}
