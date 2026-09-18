import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
const S = process.argv[2];
const browser = await chromium.launch({ channel: undefined, executablePath: undefined });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:8899/export-check.html');
for (const fn of ['execPdf', 'commPdf', 'commXls', 'emptyXls']) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch((e) => { throw new Error(`${fn}: sem download — ${e.message}`); }),
    page.evaluate((f) => window.exec[f](), fn),
  ]);
  const dest = path.join(S, 'dl', dl.suggestedFilename());
  await dl.saveAs(dest);
  console.log(fn, '->', dl.suggestedFilename(), fs.statSync(dest).size, 'bytes');
}
console.log('pageerrors:', errors);
await browser.close();
