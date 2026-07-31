// R3のリリース用スクリーンショットを取得する補助スクリプト。
// 実行: npm run serve を別ターミナルで起動してから
//       node test/capture-r3-shots.mjs
//
// npm testには含めない。canvas上のマウス操作は避け、既存E2Eと同じく
// window.__nakanoのテストフックとscene.pickを使う。

import fs from 'node:fs';
import path from 'node:path';
import { launchViewer, OUTPUT_DIR, waitForViewerReady } from './harness.mjs';

const SHOT_DIR = path.join(OUTPUT_DIR, 'r3-shots');
const STATION_CENTER = { lon: 139.6659, lat: 35.7010 };
const STATION_SHADE_VIEW = {
  ...STATION_CENTER,
  height: 500,
  heading: 0,
  pitch: -55,
};
const STATION_BUILDING_VIEW = {
  ...STATION_CENTER,
  height: 500,
  heading: 0,
  pitch: -40,
};
const SHADE_OPTIONS = {
  center: STATION_CENTER,
  sizeM: 200,
  pitchM: 10,
  date: 'winter',
  year: new Date().getFullYear(),
  // 撮影準備の所要時間を抑える。表示結果と段階描画の内容は既定値と同じ。
  frameBudgetMs: 40,
};

fs.mkdirSync(SHOT_DIR, { recursive: true });

function outputPath(name) {
  return path.join(SHOT_DIR, name);
}

async function runShadeMap(page) {
  const result = await page.evaluate(async (options) => {
    const value = await window.__nakano.shadeMap.run(options);
    return {
      completed: value?.completed,
      error: value?.error,
      computedCount: value?.computedCount,
      cacheHit: value?.cacheHit,
    };
  }, SHADE_OPTIONS);
  if (!result.completed) {
    throw new Error(`日影マップが完走しませんでした: ${JSON.stringify(result)}`);
  }
  return result;
}

async function pickStationBuilding(page) {
  return page.evaluate(() => {
    const scene = window.__nakano.viewer.scene;
    const canvas = scene.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    for (let fy = 0.28; fy <= 0.88; fy += 0.04) {
      for (let fx = 0.12; fx <= 0.88; fx += 0.04) {
        const point = new Cesium.Cartesian2(
          Math.round(width * fx),
          Math.round(height * fy)
        );
        let picked = null;
        try {
          picked = scene.pick(point);
        } catch {
          continue;
        }
        if (!(picked instanceof Cesium.Cesium3DTileFeature)) continue;

        const zmin = Number(picked.getProperty('_zmin'));
        const zmax = Number(picked.getProperty('_zmax'));
        if (!Number.isFinite(zmin) || !Number.isFinite(zmax) || zmax - zmin < 3) continue;

        let position = null;
        try {
          if (scene.pickPositionSupported) position = scene.pickPosition(point);
        } catch {
          continue;
        }
        if (!Cesium.defined(position)) continue;

        const cartographic = Cesium.Cartographic.fromCartesian(position);
        window.__r3CaptureFeature = picked;
        return {
          found: true,
          lon: Cesium.Math.toDegrees(cartographic.longitude),
          lat: Cesium.Math.toDegrees(cartographic.latitude),
          zmin,
          zmax,
        };
      }
    }
    return { found: false };
  });
}

const session = await launchViewer({ viewport: { width: 1440, height: 900 } });
const { page } = session;

try {
  await waitForViewerReady(page);
  await page.waitForTimeout(8000);

  // 1. 中野駅前の日影マップ全景
  await page.evaluate(async (destination) => {
    await window.__nakano.showBuildings('lod2');
    window.__nakano.flyTo(destination, 0);
  }, STATION_SHADE_VIEW);
  await page.waitForTimeout(5000);
  const firstShade = await runShadeMap(page);
  await page.evaluate(() => {
    const panel = document.getElementById('controlPanel');
    const section = document.getElementById('shadeMapSection');
    panel.scrollTop = Math.max(0, section.offsetTop - 70);
  });
  await page.waitForTimeout(500);
  await page.screenshot({
    path: outputPath('01-nakano-station-shademap.png'),
    fullPage: false,
  });
  console.log(`取得: 01-nakano-station-shademap.png（cacheHit=${firstShade.cacheHit}）`);

  // 2. 建物クリック後、屋上を選択した階数セレクタ付き診断カード
  await page.evaluate(() => window.__nakano.shadeMap.clear());
  await page.evaluate((destination) => window.__nakano.flyTo(destination, 0), STATION_BUILDING_VIEW);
  await page.waitForTimeout(6000);
  const building = await pickStationBuilding(page);
  if (!building.found) {
    throw new Error('中野駅前で撮影用の建物フィーチャを取得できませんでした');
  }

  await page.evaluate(({ lon, lat }) => {
    window.__nakano.diagnosis.diagnose({
      lon,
      lat,
      title: null,
      picked: window.__r3CaptureFeature,
      fly: false,
    }).catch((error) => console.error('撮影用の建物診断に失敗しました', error));
  }, building);
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 30000 });
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#secSun .sun-day').length === 3
      && !!document.getElementById('sunFloorSelect')
      && !document.querySelector('#secSun .spinner'),
    null,
    { timeout: 180000, polling: 500 }
  );
  await page.evaluate(() => {
    const select = document.getElementById('sunFloorSelect');
    if (![...select.options].some((option) => option.value === 'roof')) {
      throw new Error('撮影対象の建物に屋上の選択肢がありません');
    }
    select.value = 'roof';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    () => !!document.querySelector('#secSun .sun-recalc-status'),
    null,
    { timeout: 5000, polling: 50 }
  );
  await page.waitForFunction(
    () => {
      const state = window.__nakano.diagnosis.getSunlightTestState();
      return document.getElementById('sunFloorSelect')?.value === 'roof'
        && state.selectedKey === 'roof'
        && state.recalculationProgress === 1
        && !document.querySelector('#secSun .sun-recalc-status');
    },
    null,
    { timeout: 180000, polling: 500 }
  );
  await page.locator('#diagnosisPanel').screenshot({
    path: outputPath('02-building-rooftop-card.png'),
  });
  console.log('取得: 02-building-rooftop-card.png');

  // 3. 390px幅の日影マップセクション。最初の計算結果をキャッシュから再表示する。
  await page.evaluate(() => window.__nakano.diagnosis.close());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate((destination) => window.__nakano.flyTo(destination, 0), STATION_SHADE_VIEW);
  await page.waitForTimeout(1000);
  const mobileShade = await runShadeMap(page);
  await page.evaluate(() => {
    document.getElementById('shadeMapSection').scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(300);
  await page.locator('#shadeMapSection').screenshot({
    path: outputPath('03-mobile-shademap-section.png'),
  });
  console.log(`取得: 03-mobile-shademap-section.png（cacheHit=${mobileShade.cacheHit}）`);
  console.log(`保存先: ${SHOT_DIR}`);
} finally {
  await session.close();
}
