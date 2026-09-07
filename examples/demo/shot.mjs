/**
 * demo 截图工具 —— 用受控标签页打开页面(可选点击某个元素后)并截图。
 * 与 verify-suite 主体共用 scripts/lib/cdp.mjs,不引入任何依赖。
 *
 * 用法: node examples/demo/shot.mjs <url> <out.png> [clickSelector]
 */
import { writeFileSync } from 'node:fs';
import { withSession, fixViewport } from '../../scripts/lib/cdp.mjs';

const [url, out, clickSel] = process.argv.slice(2);
if (!url || !out) {
    console.error('usage: node shot.mjs <url> <out.png> [clickSelector]');
    process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await withSession(async (session) => {
    await fixViewport(session, { width: 520, height: 400 });
    await session.send('Page.enable');
    await session.send('Page.navigate', { url });
    await sleep(900);
    if (clickSel) {
        await session.send('Runtime.evaluate', {
            expression: `(() => { const el = document.querySelector(${JSON.stringify(clickSel)}); if (el) el.click(); return !!el; })()`,
        });
        await sleep(500);
    }
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(out, Buffer.from(data, 'base64'));
    console.log(`screenshot saved: ${out}`);
});
