/**
 * specgate demo 辅助工具 —— 把 review.md 渲染成 HTML 截图,用来在 README 里展示。
 * 用法: node render-review.mjs <md 路径> <out.png> <title>
 *
 * 与 shot.mjs 同样基于 scripts/lib/cdp.mjs,零额外依赖。
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { withSession, fixViewport } from '../../scripts/lib/cdp.mjs';

const [mdPath, outPng, title] = process.argv.slice(2);
if (!mdPath || !outPng) {
    console.error('usage: node render-review.mjs <md> <out.png> [title]');
    process.exit(1);
}

const mdSrc = readFileSync(mdPath, 'utf8');
// 极简 markdown → HTML(只够 specgate review 的语法:标题/列表/引用/加粗)
const escape = (s) => s.replace(/[<>&]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
const html = `<!doctype html><meta charset="utf-8">
<title>${escape(title ?? 'review')}</title>
<style>
  body { font: 14px/1.6 -apple-system, "Microsoft YaHei", sans-serif;
         background: #f8fafc; padding: 32px; max-width: 920px; margin: 0 auto; color: #0f172a; }
  h1 { font-size: 22px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin: 0 0 16px; }
  h2 { font-size: 17px; margin: 24px 0 8px; color: #b91c1c; }
  h3 { font-size: 15px; margin: 16px 0 8px; color: #1e293b; }
  ul { padding-left: 22px; margin: 8px 0; }
  li { margin: 4px 0; }
  blockquote { color: #475569; border-left: 3px solid #cbd5e1; padding: 4px 12px; margin: 0; }
  code { font-family: ui-monospace, Consolas, monospace; background: #f1f5f9; padding: 1px 6px; border-radius: 4px; }
  pre, .md { font-family: ui-monospace, Consolas, monospace;
             background: #0f172a; color: #e2e8f0; padding: 16px; border-radius: 8px;
             white-space: pre-wrap; word-break: break-word; font-size: 13px;
             line-height: 1.55; }
  em { font-style: normal; color: #64748b; }
  strong { color: #0f172a; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 16px 0; }
</style>
<body>
<div class="md">${escape(mdSrc)}</div>
</body>`;

const htmlPath = outPng.replace(/\.png$/, '.html');
writeFileSync(htmlPath, html);
const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/').replace(/^\/+/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await withSession(async (session) => {
    await fixViewport(session, { width: 980, height: 1200 });
    await session.send('Page.enable');
    await session.send('Page.navigate', { url: fileUrl });
    await sleep(500);
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(outPng, Buffer.from(data, 'base64'));
    console.log(`screenshot saved: ${outPng}`);
});