// PlaywrightのChromiumでSVGを指定サイズへ再ラスタライズする。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const iconDir = path.dirname(fileURLToPath(import.meta.url));
const configuredChromium = process.env.PW_CHROMIUM;
const bundledChromium = '/opt/pw-browsers/chromium';
const executablePath = configuredChromium || (fs.existsSync(bundledChromium) ? bundledChromium : null);
const browser = await chromium.launch({
  args: ['--no-sandbox'],
  ...(executablePath ? { executablePath } : {}),
});

try {
  const page = await browser.newPage();
  const variants = [
    { source: 'icon.svg', output: 'icon' },
    { source: 'icon-maskable.svg', output: 'icon-maskable' },
  ];
  for (const { source, output } of variants) {
    const sourceUrl = pathToFileURL(path.join(iconDir, source)).href;
    for (const size of [192, 512]) {
      await page.setViewportSize({ width: size, height: size });
      await page.goto(sourceUrl, { waitUntil: 'load' });
      await page.screenshot({
        path: path.join(iconDir, `${output}-${size}.png`),
        omitBackground: false,
      });
    }
  }
  console.log('PWAアイコンPNGを4枚生成しました。');
} finally {
  await browser.close();
}
