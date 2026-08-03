// R-UX-P0の比較基準スクリーンショットを取得する補助スクリプト。
// 実行: npm run serve を別ターミナルで起動してから
//       node test/capture-rux-shots.mjs
// ブラウザを利用できない環境では実行せず、スクリプト作成のみでよい。

import fs from 'node:fs';
import path from 'node:path';
import { BASE_URL, OUTPUT_DIR, launchViewer, waitForViewerReady } from './harness.mjs';

const SHOT_DIR = path.join(OUTPUT_DIR, 'rux-baseline-shots');
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

fs.mkdirSync(SHOT_DIR, { recursive: true });

function outputPath(name) {
  return path.join(SHOT_DIR, name);
}

async function showDiagnosis(page) {
  await page.evaluate(async () => {
    await window.__nakano.diagnosis.runDiagnosisAt(139.6686, 35.7056, {
      title: '中野駅',
      fly: false,
      skipSunlight: true,
    });
  });
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 60000 });
  await page.waitForTimeout(500);
}

const desktopViewer = await launchViewer({ viewport: DESKTOP_VIEWPORT });
try {
  const { page } = desktopViewer;
  await waitForViewerReady(page);
  await showDiagnosis(page);

  await page.locator('#diagnosisPanel').screenshot({
    path: outputPath('01-desktop-diagnosis-card.png'),
  });
  console.log('取得: 01-desktop-diagnosis-card.png');

  await page.evaluate(() => {
    window.__nakano.diagnosis.close();
    document.getElementById('controlPanel').scrollTop = 0;
  });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: outputPath('03-left-panel-overview.png'),
    fullPage: false,
  });
  console.log('取得: 03-left-panel-overview.png');
} finally {
  await desktopViewer.close();
}

const mobileViewer = await launchViewer({
  viewport: MOBILE_VIEWPORT,
  contextOptions: { hasTouch: true, isMobile: true },
  url: BASE_URL + '?quality=light',
});
try {
  const { page } = mobileViewer;
  await page.waitForFunction(() => !!window.__nakano?.bottomSheet, null, { timeout: 180000 });
  await showDiagnosis(page);
  await page.evaluate(() => window.__nakano.bottomSheet.setState('half'));
  await page.waitForFunction(
    () => document.getElementById('diagnosisPanel')?.dataset.sheetState === 'half',
  );
  await page.waitForTimeout(350);
  await page.screenshot({
    path: outputPath('02-mobile-sheet-half.png'),
    fullPage: false,
  });
  console.log('取得: 02-mobile-sheet-half.png');
} finally {
  await mobileViewer.close();
}

console.log(`保存先: ${SHOT_DIR}`);
