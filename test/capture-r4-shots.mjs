// R4（マルチエリア展開）のリリース用スクリーンショットを取得する補助スクリプト。
// 実行: npm run serve を別ターミナルで起動してから
//       node test/capture-r4-shots.mjs
//
// npm testには含めない。診断は既存E2Eと同じくwindow.__nakanoの
// テストフックを使い、撮影結果はtest/output/r4-shots/へ保存する。

import fs from 'node:fs';
import path from 'node:path';
import { BASE_URL, launchViewer, OUTPUT_DIR } from './harness.mjs';

const SHOT_DIR = path.join(OUTPUT_DIR, 'r4-shots');
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const HACHIKO = {
  lon: 139.7006,
  lat: 35.6595,
  title: '渋谷駅ハチ公前付近',
};

fs.mkdirSync(SHOT_DIR, { recursive: true });

function outputPath(name) {
  return path.join(SHOT_DIR, name);
}

async function waitForArea(page, cityCode) {
  await page.waitForFunction(
    (code) => window.__nakano?.areaConfig?.code === code,
    cityCode,
    { timeout: 180000, polling: 500 },
  );
}

async function waitForBuilding(page, key) {
  await page.waitForFunction(
    (tilesetKey) => window.__nakano?.loaded?.[tilesetKey]?.tilesLoaded === true,
    key,
    { timeout: 180000, polling: 500 },
  );
}

async function diagnoseHachiko(page) {
  await page.evaluate(
    async ({ lon, lat, title }) => {
      await window.__nakano.diagnosis.runDiagnosisAt(lon, lat, {
        title,
        fly: true,
        skipSunlight: true,
      });
    },
    HACHIKO,
  );
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 120000 });
  await page.waitForFunction(
    () => {
      const result = window.__nakano?.diagnosis?.getLastResult?.();
      return result?.flood?.rank === '0.5〜3.0m'
        && result?.zoning?.use?.name === '商業地域'
        && result?.zoning?.use?.floorArea === 1000;
    },
    null,
    { timeout: 120000, polling: 500 },
  );
  await page.evaluate(() => {
    document.getElementById('diagnosisPanel').scrollTop = 0;
  });
  await page.waitForTimeout(1200);
}

// 1. 渋谷駅前の診断カードを含む全景
{
  const session = await launchViewer({
    viewport: DESKTOP_VIEWPORT,
    url: BASE_URL + '?city=13113',
  });
  try {
    const { page } = session;
    await waitForArea(page, '13113');
    await waitForBuilding(page, 'bldgLod2');
    await diagnoseHachiko(page);
    await page.screenshot({
      path: outputPath('01-shibuya-diagnosis-overview.png'),
      fullPage: false,
    });
    console.log('取得: 01-shibuya-diagnosis-overview.png');
  } finally {
    await session.close();
  }
}

// 2. 三島市のレイヤー欠損UI
{
  const session = await launchViewer({
    viewport: DESKTOP_VIEWPORT,
    url: BASE_URL + '?city=22206',
  });
  try {
    const { page } = session;
    await waitForArea(page, '22206');
    await waitForBuilding(page, 'bldgLod1');
    await page.waitForFunction(
      () =>
        document.getElementById('ov-fire')?.disabled === true
        && document.getElementById('ov-height')?.disabled === true
        && document.getElementById('tran')?.disabled === true
        && document.getElementById('wtr')?.disabled === true,
      null,
      { timeout: 30000, polling: 100 },
    );
    await page.evaluate(() => {
      const panel = document.getElementById('controlPanel');
      const section = document.getElementById('zoningLayers').closest('section');
      panel.scrollTop = Math.max(0, section.offsetTop - 18);
    });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: outputPath('02-mishima-missing-layers.png'),
      fullPage: false,
    });
    console.log('取得: 02-mishima-missing-layers.png');
  } finally {
    await session.close();
  }
}

// 3. エリアセレクタの展開状態
{
  const session = await launchViewer({ viewport: DESKTOP_VIEWPORT });
  try {
    const { page } = session;
    await waitForArea(page, '13114');
    await waitForBuilding(page, 'bldgLod2');
    await page.evaluate(() => {
      const panel = document.getElementById('controlPanel');
      const select = document.getElementById('areaPrefSelect');
      panel.scrollTop = 0;
      // ネイティブselectのポップアップはスクリーンショットに含まれないため、
      // 撮影時だけリスト表示にして展開状態を確実に残す。
      select.size = 12;
      select.setAttribute('aria-expanded', 'true');
      select.focus();
    });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: outputPath('03-area-selector-expanded.png'),
      fullPage: false,
    });
    console.log('取得: 03-area-selector-expanded.png');
  } finally {
    await session.close();
  }
}

// 4. 390px幅の渋谷駅前診断
{
  const session = await launchViewer({
    viewport: MOBILE_VIEWPORT,
    url: BASE_URL + '?city=13113',
  });
  try {
    const { page } = session;
    await waitForArea(page, '13113');
    await waitForBuilding(page, 'bldgLod2');
    await diagnoseHachiko(page);
    await page.screenshot({
      path: outputPath('04-mobile-shibuya-diagnosis.png'),
      fullPage: false,
    });
    console.log('取得: 04-mobile-shibuya-diagnosis.png');
  } finally {
    await session.close();
  }
}

console.log(`保存先: ${SHOT_DIR}`);
