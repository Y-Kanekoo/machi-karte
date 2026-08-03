// R-UX-P0（LoAF・Event Timing）の体感性能ベースライン取得。
// 実行: node test/e2e-rux.test.mjs（事前に `npm run serve` が必要）
// 性能値そのものはCIで合否判定せず、計測フックと記録形式だけを検証する。

import fs from 'node:fs';
import path from 'node:path';
import {
  BASE_URL,
  OUTPUT_DIR,
  launchViewer,
  waitForViewerReady,
  check,
  report,
} from './harness.mjs';

const BASELINE_PATH = path.join(OUTPUT_DIR, 'rux-baseline.json');
const STATION = { lon: 139.6659, lat: 35.7010 };
const OPERATION_NAMES = [
  'address-search',
  'map-tap',
  'floor-selector',
  'shade-map-start-abort',
  'building-layer-switch',
  'mobile-sheet-peek-half-full',
  'area-selector-open-close',
];

const operations = [];

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSummary(value) {
  return typeof value?.supported === 'boolean'
    && typeof value?.eventTimingSupported === 'boolean'
    && isFiniteNumber(value?.loafCount)
    && isFiniteNumber(value?.loafTotalMs)
    && isFiniteNumber(value?.worstLoafMs)
    && isFiniteNumber(value?.maxInteractionMs)
    && Array.isArray(value?.interactions)
    && value.interactions.every((interaction) =>
      (interaction.name === undefined || typeof interaction.name === 'string')
        && isFiniteNumber(interaction.startTime)
        && isFiniteNumber(interaction.duration)
        && isFiniteNumber(interaction.inputDelay)
        && isFiniteNumber(interaction.processingDuration)
        && isFiniteNumber(interaction.presentationDelay)
    );
}

async function mark(page, name) {
  await page.evaluate((operationName) => {
    window.__nakano.perf.mark(operationName);
  }, name);
}

async function record(page, name, context) {
  await page.waitForTimeout(300);
  const summary = await page.evaluate(() => window.__nakano.perf.getSummary());
  operations.push({ name, context, summary });
  check(`${name}: 計測サマリーを取得できる`, isSummary(summary), JSON.stringify(summary));
  return summary;
}

async function waitForSunlight(page) {
  await page.waitForFunction(
    () => !!document.getElementById('sunFloorSelect')
      && !document.querySelector('#secSun .spinner')
      && !document.querySelector('#secSun .sun-recalc-status'),
    null,
    { timeout: 180000, polling: 500 },
  );
}

/** scene.pickで実在建物を取得し、次のcanvasクリックだけ同じ結果へ固定する。 */
async function prepareBuildingTap(page) {
  return page.evaluate(() => {
    const scene = window.__nakano.viewer.scene;
    const canvas = scene.canvas;
    const rect = canvas.getBoundingClientRect();
    const originalPick = scene.pick.bind(scene);

    for (let fy = 0.28; fy <= 0.88; fy += 0.04) {
      for (let fx = 0.36; fx <= 0.88; fx += 0.04) {
        const x = Math.round(canvas.clientWidth * fx);
        const y = Math.round(canvas.clientHeight * fy);
        const point = new Cesium.Cartesian2(x, y);
        let feature;
        let position;
        try {
          feature = originalPick(point);
          if (!(feature instanceof Cesium.Cesium3DTileFeature)) continue;
          const zmin = Number(feature.getProperty('_zmin'));
          const zmax = Number(feature.getProperty('_zmax'));
          if (!Number.isFinite(zmin) || !Number.isFinite(zmax) || zmax - zmin < 3) continue;
          if (scene.pickPositionSupported) position = scene.pickPosition(point);
        } catch (_) {
          continue;
        }
        if (!Cesium.defined(position)) continue;

        let hooked = true;
        scene.pick = function pickOnce(nextPoint, ...args) {
          if (hooked) {
            hooked = false;
            scene.pick = originalPick;
            return feature;
          }
          return originalPick(nextPoint, ...args);
        };
        return {
          found: true,
          clientX: rect.left + x,
          clientY: rect.top + y,
        };
      }
    }
    return { found: false };
  });
}

console.log('\n=== R-UX-P0 デスクトップ計測 ===');
const desktopViewer = await launchViewer({ viewport: { width: 1440, height: 900 } });
let browserVersion = '';
try {
  const { page, browser } = desktopViewer;
  browserVersion = browser.version();
  await waitForViewerReady(page);
  await page.waitForTimeout(5000);

  const hook = await page.evaluate(() => {
    const perf = window.__nakano?.perf;
    return {
      exists: !!perf,
      getSummary: typeof perf?.getSummary,
      mark: typeof perf?.mark,
      summary: perf?.getSummary(),
    };
  });
  check(
    'window.__nakano.perfにgetSummary/markがある',
    hook.exists && hook.getSummary === 'function' && hook.mark === 'function',
    JSON.stringify(hook),
  );
  check(
    '計測サマリーにsupportedフラグがある',
    typeof hook.summary?.supported === 'boolean',
    JSON.stringify(hook.summary),
  );

  // 1. 住所検索診断
  await page.fill('#searchInput', '中野区中野五丁目');
  await mark(page, 'address-search');
  await page.click('#searchBtn');
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 60000 });
  await page.waitForFunction(
    () => window.__nakano.diagnosis.getLastResult()?.title?.includes('中野'),
    null,
    { timeout: 60000, polling: 100 },
  );
  await record(page, 'address-search', 'desktop');

  // 2. scene.pickで取得した実在建物をcanvasタップして診断
  await page.evaluate(() => {
    window.__nakano.diagnosis.close();
    window.__nakano.flyTo({
      lon: 139.6659,
      lat: 35.7010,
      height: 500,
      heading: 0,
      pitch: -40,
    }, 0);
  });
  await page.waitForTimeout(6000);
  const tap = await prepareBuildingTap(page);
  check('地図タップ用の建物をscene.pickで取得できる', tap.found, JSON.stringify(tap));
  if (!tap.found) throw new Error('地図タップ診断用の建物を取得できませんでした');
  await mark(page, 'map-tap');
  await page.mouse.click(tap.clientX, tap.clientY);
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 30000 });
  await waitForSunlight(page);
  await record(page, 'map-tap', 'desktop');

  // 3. 階数セレクタ変更
  const floorTarget = await page.evaluate(() => {
    const select = document.getElementById('sunFloorSelect');
    return [...select.options].at(-1)?.value || null;
  });
  check('階数セレクタに変更先がある', !!floorTarget, String(floorTarget));
  await mark(page, 'floor-selector');
  await page.locator('#sunFloorSelect').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (target) => {
      const state = window.__nakano.diagnosis.getSunlightTestState();
      return document.getElementById('sunFloorSelect')?.value === target
        && state.recalculationProgress === 1
        && !document.querySelector('#secSun .sun-recalc-status');
    },
    floorTarget,
    { timeout: 180000, polling: 500 },
  );
  await record(page, 'floor-selector', 'desktop');

  // 4. 日影マップ開始→中断（縮小グリッド）
  await page.evaluate(({ center }) => {
    window.__ruxShadeRun = window.__nakano.shadeMap.run({
      center,
      sizeM: 100,
      pitchM: 10,
      date: 'winter',
      frameBudgetMs: 40,
    });
  }, { center: STATION });
  await page.waitForFunction(
    () => {
      const state = window.__nakano.shadeMap.getState();
      return state.running && state.progress > 0.005;
    },
    null,
    { timeout: 180000, polling: 50 },
  );
  await mark(page, 'shade-map-start-abort');
  await page.click('#shadeAbort');
  await page.evaluate(() => window.__ruxShadeRun);
  await record(page, 'shade-map-start-abort', 'desktop');

  // 5. 建物レイヤー切替
  await mark(page, 'building-layer-switch');
  await page.locator('input[name="bldg"][value="lod1"]').click();
  await page.waitForFunction(
    () => window.__nakano.getBuildingState().layerKind === 'lod1',
    null,
    { timeout: 180000, polling: 500 },
  );
  await record(page, 'building-layer-switch', 'desktop');

  // 7. エリアセレクタは開閉だけ行い、自治体変更によるreloadは発生させない
  const urlBeforeAreaSelector = page.url();
  await mark(page, 'area-selector-open-close');
  await page.locator('#areaPrefSelect').click();
  await page.keyboard.press('Escape');
  check('エリアセレクタ開閉でreloadしない', page.url() === urlBeforeAreaSelector);
  await record(page, 'area-selector-open-close', 'desktop');
} finally {
  await desktopViewer.close();
}

console.log('\n=== R-UX-P0 モバイル計測 ===');
const mobileViewer = await launchViewer({
  viewport: { width: 390, height: 844 },
  contextOptions: { hasTouch: true, isMobile: true },
  url: BASE_URL + '?quality=light',
});
try {
  const { page } = mobileViewer;
  await page.waitForFunction(() => !!window.__nakano?.bottomSheet, null, { timeout: 180000 });
  await page.evaluate(async () => {
    await window.__nakano.diagnosis.runDiagnosisAt(139.6686, 35.7056, {
      title: '中野駅',
      fly: false,
      skipSunlight: true,
    });
    window.__nakano.bottomSheet.setState('peek');
  });
  await page.waitForFunction(
    () => document.getElementById('diagnosisPanel')?.dataset.sheetState === 'peek',
  );

  // 6. モバイルシート peek→half→full
  await mark(page, 'mobile-sheet-peek-half-full');
  await page.locator('.sheet-handle').click();
  await page.waitForFunction(
    () => document.getElementById('diagnosisPanel')?.dataset.sheetState === 'half',
  );
  await page.waitForTimeout(350);
  await page.locator('.sheet-handle').click();
  await page.waitForFunction(
    () => document.getElementById('diagnosisPanel')?.dataset.sheetState === 'full',
  );
  await record(page, 'mobile-sheet-peek-half-full', 'mobile');
} finally {
  await mobileViewer.close();
}

const allSummaries = operations.map(({ summary }) => summary);
const loafSummaries = allSummaries.filter(({ supported }) => supported);
const eventSummaries = allSummaries.filter(({ eventTimingSupported }) => eventTimingSupported);
const namedInteractions = allSummaries.flatMap(({ interactions }) => interactions)
  .filter(({ name }) => name);

check(
  'LoAF対応時はLoAFを1件以上観測できる',
  loafSummaries.length === 0 || loafSummaries.some(({ loafCount }) => loafCount > 0),
);
check(
  'Event Timing対応時はinteractionを1件以上観測できる',
  eventSummaries.length === 0 || eventSummaries.some(({ interactions }) => interactions.length > 0),
);
check(
  'markした操作名をEvent Timingへ紐づけられる',
  eventSummaries.length === 0
    || namedInteractions.some(({ name }) => OPERATION_NAMES.includes(name)),
  JSON.stringify(namedInteractions.map(({ name }) => name)),
);
check(
  '主要7操作をベースラインへ記録する',
  OPERATION_NAMES.every((name) => operations.some((operation) => operation.name === name)),
  JSON.stringify(operations.map(({ name }) => name)),
);

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(BASELINE_PATH, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  browser: {
    name: 'Chromium',
    version: browserVersion,
    renderer: 'SwiftShader',
  },
  eventDurationThresholdMs: 40,
  operations,
}, null, 2)}\n`);
console.log(`ベースライン保存先: ${BASELINE_PATH}`);

report('R-UX-P0 e2e');
