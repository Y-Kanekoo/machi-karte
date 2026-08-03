// R-UX-P0〜P3（計測・フィードバック・動線・モバイル磨き）の回帰検証。
// 実行: node test/e2e-rux.test.mjs（事前に `npm run serve` が必要）
// 性能値そのものはCIで合否判定せず、計測フックと記録形式だけを検証する。

import fs from 'node:fs';
import path from 'node:path';
import {
  BASE_URL,
  OUTPUT_DIR,
  launchViewer,
  waitForViewerReady,
  openSection,
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
const RENDER_REQUIRED_OPERATION_NAMES = new Set([
  'address-search',
  'map-tap',
  'floor-selector',
  'shade-map-start-abort',
  'building-layer-switch',
  'mobile-sheet-peek-half-full',
]);
const TOUCH_TARGET_EXCEPTIONS = [
  {
    selector: '.cesium-widget-credits a',
    reason: 'Cesium標準の地図クレジット内リンクは外部UIのため現状サイズを維持する',
  },
  {
    selector: '#attribution a',
    reason: '地図出典の固定表示内リンクは、表示領域を占有しない補助情報として現状サイズを維持する',
  },
  {
    selector: '.diag-source a',
    reason: '診断カード末尾の出典リンクは、本文の可読性を優先する補助情報として現状サイズを維持する',
  },
  {
    selector: '.diag-note a',
    reason: '診断注記内の公式資料リンクは、文章内リンクとして現状サイズを維持する',
  },
];

const styleSource = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const styleWithoutTokenDefinitions = styleSource.replace(/:root\s*\{[^}]*\}/g, '');
const motionDeclarations = [
  ...styleWithoutTokenDefinitions.matchAll(/\b(?:transition|animation)(?:-[\w-]+)?\s*:[^;]+;/g),
].map((match) => match[0]);
const directDurations = motionDeclarations.filter((declaration) =>
  /(?:^|[\s,(])\d*\.?\d+(?:ms|s)\b/.test(declaration)
);
const directEasings = motionDeclarations.filter((declaration) => {
  const withoutTokens = declaration.replace(/var\([^)]*\)/g, '');
  return /\b(?:linear|ease|ease-in|ease-out|ease-in-out)\b|cubic-bezier\(/.test(withoutTokens);
});

check(
  'transition/animationのdurationをトークン定義外で直書きしない',
  directDurations.length === 0,
  directDurations.join(' | '),
);
check(
  'transition/animationのeasingをトークン定義外で直書きしない',
  directEasings.length === 0,
  directEasings.join(' | '),
);
check(
  '全ボタン・ラジオ・チェックボックスに押下スタイルがある',
  /button:active:not\(:disabled\)/.test(styleSource)
    && /input\[type="radio"\]:active:not\(:disabled\)/.test(styleSource)
    && /input\[type="checkbox"\]:active:not\(:disabled\)/.test(styleSource)
    && /var\(--duration-instant\)/.test(styleSource),
);

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
    && isFiniteNumber(value?.interactionCount)
    && isFiniteNumber(value?.maxInteractionMs)
    && isFiniteNumber(value?.renderRequestCount)
    && isFiniteNumber(value?.renderRequestsSinceMark)
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

async function record(page, name, context, measurementKind) {
  await page.waitForTimeout(300);
  const summary = await page.evaluate(
    (operationName) => window.__nakano.perf.measure(operationName),
    name,
  );
  operations.push({ name, context, measurementKind, summary });
  check(`${name}: 計測サマリーを取得できる`, isSummary(summary), JSON.stringify(summary));
  if (RENDER_REQUIRED_OPERATION_NAMES.has(name)) {
    check(
      `${name}: 表示変更後にrequestRenderを要求する`,
      summary.renderRequestsSinceMark > 0,
      JSON.stringify(summary),
    );
  }
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

/** モバイルUIの全操作要素を機械抽出し、実効ヒット領域とpaddingを返す。 */
async function auditTouchTargets(page, { revealControls = false } = {}) {
  return page.evaluate(({ exceptions, reveal }) => {
    const restored = [];
    if (reveal) {
      document.querySelectorAll('[data-panel-section] > .panel-section-content').forEach((content) => {
        restored.push({ element: content, hidden: content.hidden, hadHiddenClass: false });
        content.hidden = false;
      });
      ['timeControl', 'overlayAlphaRow'].forEach((id) => {
        const element = document.getElementById(id);
        if (!element) return;
        restored.push({
          element,
          hidden: element.hidden,
          hadHiddenClass: element.classList.contains('hidden'),
        });
        element.hidden = false;
        element.classList.remove('hidden');
      });
    }

    const describe = (element) => {
      if (element.id) return `#${element.id}`;
      const classes = [...element.classList].slice(0, 2).map((name) => `.${name}`).join('');
      const type = element.getAttribute('type');
      const role = element.getAttribute('role');
      return `${element.tagName.toLowerCase()}${classes}`
        + `${type ? `[type=${type}]` : ''}${role ? `[role=${role}]` : ''}`;
    };
    const rectValue = (rect) => ({ width: rect.width, height: rect.height });
    const audit = [...document.querySelectorAll(
      'button, [role="button"], [role="option"], input, select, a, .sheet-handle',
    )].flatMap((element) => {
      const ownRect = element.getBoundingClientRect();
      if (ownRect.width === 0 || ownRect.height === 0) return [];
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return [];
      const label = element.matches('input[type="radio"], input[type="checkbox"]')
        ? element.closest('label')
        : null;
      const hitRect = (label || element).getBoundingClientRect();
      const exception = exceptions.find(({ selector }) => element.matches(selector));
      return [{
        target: describe(element),
        ownRect: rectValue(ownRect),
        hitRect: rectValue(hitRect),
        padding: {
          top: Number.parseFloat(style.paddingTop) || 0,
          right: Number.parseFloat(style.paddingRight) || 0,
          bottom: Number.parseFloat(style.paddingBottom) || 0,
          left: Number.parseFloat(style.paddingLeft) || 0,
        },
        exception: exception?.selector || null,
        reason: exception?.reason || null,
      }];
    });

    for (const { element, hidden, hadHiddenClass } of restored.reverse()) {
      element.hidden = hidden;
      element.classList.toggle('hidden', hadHiddenClass);
    }
    return {
      auditedCount: audit.length,
      exceptions: audit.filter(({ exception }) => exception),
      violations: audit.filter(({ hitRect, exception }) =>
        !exception && (hitRect.width < 43.5 || hitRect.height < 43.5)),
    };
  }, { exceptions: TOUCH_TARGET_EXCEPTIONS, reveal: revealControls });
}

/** scene.pickで実在建物と診断座標を取得する。 */
async function prepareBuildingTap(page) {
  return page.evaluate(() => {
    const scene = window.__nakano.viewer.scene;
    const canvas = scene.canvas;

    for (let fy = 0.28; fy <= 0.88; fy += 0.04) {
      for (let fx = 0.36; fx <= 0.88; fx += 0.04) {
        const x = Math.round(canvas.clientWidth * fx);
        const y = Math.round(canvas.clientHeight * fy);
        const point = new Cesium.Cartesian2(x, y);
        let feature;
        let position;
        try {
          feature = scene.pick(point);
          if (!(feature instanceof Cesium.Cesium3DTileFeature)) continue;
          const zmin = Number(feature.getProperty('_zmin'));
          const zmax = Number(feature.getProperty('_zmax'));
          if (!Number.isFinite(zmin) || !Number.isFinite(zmax) || zmax - zmin < 3) continue;
          if (scene.pickPositionSupported) position = scene.pickPosition(point);
        } catch (_) {
          continue;
        }
        if (!Cesium.defined(position)) continue;

        const carto = Cesium.Cartographic.fromCartesian(position);
        window.__ruxBuildingFeature = feature;
        return {
          found: true,
          lon: Cesium.Math.toDegrees(carto.longitude),
          lat: Cesium.Math.toDegrees(carto.latitude),
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
      measure: typeof perf?.measure,
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
  check(
    'window.__nakano.perfに操作差分を返すmeasureがある',
    hook.measure === 'function',
    JSON.stringify(hook),
  );

  // 1. 住所検索診断
  await page.fill('#searchInput', '中野区中野五丁目');
  await mark(page, 'address-search');
  await page.evaluate(() => {
    const button = document.getElementById('searchBtn');
    window.__ruxSearchButtonInitial = {
      html: button.innerHTML,
      ariaLabel: button.getAttribute('aria-label'),
    };
    button.addEventListener('click', () => {
      window.__ruxSearchFeedback = {
        disabled: button.disabled,
        busy: button.getAttribute('aria-busy'),
        text: button.textContent,
        ariaLabel: button.getAttribute('aria-label'),
      };
    }, { once: true });
  });
  await page.click('#searchBtn');
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 60000 });
  const searchFeedback = await page.evaluate(() => window.__ruxSearchFeedback);
  await page.waitForFunction(
    () => window.__nakano.diagnosis.getLastResult()?.title?.includes('中野'),
    null,
    { timeout: 60000, polling: 100 },
  );
  await page.waitForFunction(
    () => {
      const button = document.getElementById('searchBtn');
      const initial = window.__ruxSearchButtonInitial;
      return !button.disabled
        && button.getAttribute('aria-busy') === null
        && button.innerHTML === initial.html
        && button.getAttribute('aria-label') === initial.ariaLabel;
    },
    null,
    { timeout: 60000, polling: 100 },
  );
  const searchRestored = await page.evaluate(() => {
    const button = document.getElementById('searchBtn');
    return {
      disabled: button.disabled,
      busy: button.getAttribute('aria-busy'),
      html: button.innerHTML,
      ariaLabel: button.getAttribute('aria-label'),
    };
  });
  const searchInitial = await page.evaluate(() => window.__ruxSearchButtonInitial);
  check(
    '検索中は中断ボタンとaria-busyを表示する',
    !searchFeedback.disabled
      && searchFeedback.busy === 'true'
      && searchFeedback.text === '中断'
      && searchFeedback.ariaLabel === '住所検索を中断'
      && !searchRestored.disabled
      && searchRestored.busy === null
      && searchRestored.html === searchInitial.html
      && searchRestored.ariaLabel === searchInitial.ariaLabel,
    JSON.stringify({ searchFeedback, searchRestored, searchInitial }),
  );
  await record(page, 'address-search', 'desktop', 'user-input');

  // 2. scene.pickで取得した実在建物をフック経由で診断
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
  await page.evaluate(({ lon, lat }) => {
    window.__nakano.diagnosis
      .diagnose({ lon, lat, title: null, picked: window.__ruxBuildingFeature, fly: false })
      .catch((e) => console.warn('diagnose(picked) failed', e));
  }, { lon: tap.lon, lat: tap.lat });
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 30000 });
  await waitForSunlight(page);
  await record(page, 'map-tap', 'desktop', 'programmatic');

  // 3. 階数セレクタ変更
  const floorTarget = await page.evaluate(() => {
    const select = document.getElementById('sunFloorSelect');
    return [...select.options].at(-1)?.value || null;
  });
  check('階数セレクタに変更先がある', !!floorTarget, String(floorTarget));
  await mark(page, 'floor-selector');
  await page.evaluate((target) => {
    const select = document.getElementById('sunFloorSelect');
    select.value = target;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, floorTarget);
  await page.waitForFunction(
    () => !!document.querySelector('#secSun .sun-recalc-status'),
    null,
    { timeout: 3000 },
  ).catch(() => {});
  await page.waitForFunction(
    (target) => document.getElementById('sunFloorSelect')?.value === target
      && !document.querySelector('#secSun .sun-recalc-status'),
    floorTarget,
    { timeout: 60000, polling: 500 },
  );
  await record(page, 'floor-selector', 'desktop', 'programmatic');

  // 4. 日影マップ開始→中断（縮小グリッド）
  await openSection(page, 'shadeMapSection');
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
  await record(page, 'shade-map-start-abort', 'desktop', 'user-input');

  // 5. 建物レイヤー切替
  await openSection(page, 'buildingModelSection');
  await mark(page, 'building-layer-switch');
  await page.locator('input[name="bldg"][value="lod1"]').click();
  await page.waitForFunction(
    () => window.__nakano.getBuildingState().layerKind === 'lod1',
    null,
    { timeout: 180000, polling: 500 },
  );
  await record(page, 'building-layer-switch', 'desktop', 'user-input');

  // 7. エリアセレクタは開閉だけ行い、自治体変更によるreloadは発生させない
  const urlBeforeAreaSelector = page.url();
  await mark(page, 'area-selector-open-close');
  await page.locator('#areaPrefSelect').click();
  await page.keyboard.press('Escape');
  check('エリアセレクタ開閉でreloadしない', page.url() === urlBeforeAreaSelector);
  await record(page, 'area-selector-open-close', 'desktop', 'user-input');

  // P1: 同期区間で全スケルトンが揃い、各データの確定後に順次消える。
  const skeletonStart = await page.evaluate(() => {
    window.__ruxSkeletonRun = window.__nakano.diagnosis.runDiagnosisAt(139.6659, 35.7010, {
      title: 'スケルトン確認地点',
      fly: false,
    });
    const ids = ['secFlood', 'secLandslide', 'secShelter', 'secZoning', 'secSun'];
    return Object.fromEntries(ids.map((id) => [
      id,
      !!document.querySelector(`#${id} .diag-skeleton`),
    ]));
  });
  check(
    '診断開始直後は洪水・土砂・避難所・都市計画・日照にスケルトンがある',
    Object.values(skeletonStart).every(Boolean),
    JSON.stringify(skeletonStart),
  );
  await page.evaluate(() => window.__ruxSkeletonRun);
  const coreSkeletons = await page.evaluate(() => [
    'secFlood',
    'secLandslide',
    'secShelter',
    'secZoning',
  ].filter((id) => document.querySelector(`#${id} .diag-skeleton`)));
  check(
    'コアデータ到着後は対応するスケルトンが消える',
    coreSkeletons.length === 0,
    JSON.stringify(coreSkeletons),
  );
  await waitForSunlight(page);
  const finalSkeletonState = await page.evaluate(() => ({
    remaining: document.querySelectorAll('#diagBody .diag-skeleton').length,
    highlighted: document.querySelectorAll('#diagBody .diag-content.result-highlight').length,
  }));
  check(
    '全データ到着後はスケルトンが消える',
    finalSkeletonState.remaining === 0,
    JSON.stringify(finalSkeletonState),
  );
  check(
    '確定した5つの結果セクションに1回ハイライトを付ける',
    finalSkeletonState.highlighted === 5,
    JSON.stringify(finalSkeletonState),
  );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotion = await page.evaluate(() => {
    const buttonStyle = getComputedStyle(document.getElementById('searchBtn'));
    const probe = document.createElement('span');
    probe.className = 'spinner';
    document.body.append(probe);
    const spinnerStyle = getComputedStyle(probe);
    const skeletonProbe = document.createElement('div');
    skeletonProbe.className = 'diag-skeleton';
    document.body.append(skeletonProbe);
    const shimmerStyle = getComputedStyle(skeletonProbe, '::after');
    const state = {
      transitionDuration: buttonStyle.transitionDuration,
      animationName: spinnerStyle.animationName,
      animationDuration: spinnerStyle.animationDuration,
      shimmerAnimationName: shimmerStyle.animationName,
      shimmerAnimationDuration: shimmerStyle.animationDuration,
    };
    probe.remove();
    skeletonProbe.remove();
    return state;
  });
  check(
    'reduced-motionではcomputedStyleのtransition-durationが0ms相当',
    reducedMotion.transitionDuration
      .split(',')
      .every((duration) => Number.parseFloat(duration) === 0),
    JSON.stringify(reducedMotion),
  );
  check(
    'reduced-motionではスピナー・シマー系animationを停止する',
    reducedMotion.animationName === 'none'
      && Number.parseFloat(reducedMotion.animationDuration) === 0
      && reducedMotion.shimmerAnimationName === 'none'
      && Number.parseFloat(reducedMotion.shimmerAnimationDuration) === 0,
    JSON.stringify(reducedMotion),
  );
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

  const dragTransition = await page.evaluate(() => {
    const panel = document.getElementById('diagnosisPanel');
    panel.classList.add('sheet-dragging');
    const style = getComputedStyle(panel);
    const result = {
      hasDraggingClass: panel.classList.contains('sheet-dragging'),
      transitionDuration: style.transitionDuration,
      transitionProperty: style.transitionProperty,
    };
    panel.classList.remove('sheet-dragging');
    return result;
  });
  check(
    'シートドラッグ中はtransitionを無効化する',
    dragTransition.hasDraggingClass
      && dragTransition.transitionDuration.split(',').every(
        (duration) => Number.parseFloat(duration) === 0,
      ),
    JSON.stringify(dragTransition),
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
  await record(page, 'mobile-sheet-peek-half-full', 'mobile', 'user-input');

  // P3: canvasを操作せず、診断flyTo完了後の画面座標フックで地図連動を検証する。
  // 検証するのは不変条件「half表示後に診断地点がシートに隠れていない」のみ。
  // applyMapSync は補正不要（deltaY<=0）なら何もせず終了する正しい実装のため、
  // adjustmentCount の増加を条件にすると補正不要ケースで偽タイムアウトする。
  await page.evaluate(() => {
    window.__nakano.bottomSheet.setState('peek');
  });
  await page.evaluate(async () => {
    await window.__nakano.diagnosis.runDiagnosisAt(139.6686, 35.7056, {
      title: '中野駅',
      fly: true,
      skipSunlight: true,
    });
    window.__nakano.bottomSheet.setState('half');
  });
  await page.waitForFunction(
    () => {
      const state = window.__nakano.bottomSheet.getMapSyncTestState();
      return document.getElementById('diagnosisPanel')?.dataset.sheetState === 'half'
        && !state.pending
        && !state.cameraMoving
        && Number.isFinite(state.pointY)
        && Number.isFinite(state.sheetTop)
        && state.pointY < state.sheetTop;
    },
    null,
    { timeout: 60000, polling: 50 },
  );
  const mapSync = await page.evaluate(
    () => window.__nakano.bottomSheet.getMapSyncTestState(),
  );
  check(
    'half表示後は診断地点の画面Y座標がシート上端より上にある',
    mapSync.pointY < mapSync.sheetTop,
    JSON.stringify(mapSync),
  );

  // RC1: シート連動待機中にユーザーがカメラを動かした場合は、moveEnd後も再発火しない。
  const adjustmentCountBeforeUserMove = mapSync.adjustmentCount;
  await page.evaluate(() => window.__nakano.bottomSheet.setState('full'));
  await page.mouse.move(200, 50);
  await page.mouse.wheel(0, 180);
  await page.waitForTimeout(700);
  const afterUserMove = await page.evaluate(
    () => window.__nakano.bottomSheet.getMapSyncTestState(),
  );
  check(
    'ユーザーのカメラ操作で待機中のシート地図連動を破棄する',
    !afterUserMove.pending && afterUserMove.adjustmentCount === adjustmentCountBeforeUserMove,
    JSON.stringify(afterUserMove),
  );

  // RC1: 比較URLのfly:false診断で、先に復元したカメラをシート連動が上書きしない。
  const restoredCamera = { lon: 139.680321, lat: 35.690654 };
  const compareRestorePage = await mobileViewer.newPage(
    BASE_URL
      + '#v=1&city=13114&cam=139.680321,35.690654,900,33,-45'
      + '&compare=139.6686,35.7056;139.6659,35.701',
  );
  await compareRestorePage.waitForFunction(
    () => window.__nakano?.getRestored?.() instanceof Promise,
    null,
    { timeout: 180000, polling: 500 },
  );
  await compareRestorePage.evaluate(() => window.__nakano.getRestored());
  await compareRestorePage.waitForTimeout(500);
  const compareRestoreCamera = await compareRestorePage.evaluate(() => {
    const cartographic = window.__nakano.viewer.camera.positionCartographic;
    return {
      lon: Cesium.Math.toDegrees(cartographic.longitude),
      lat: Cesium.Math.toDegrees(cartographic.latitude),
      mapSync: window.__nakano.bottomSheet.getMapSyncTestState(),
    };
  });
  check(
    '比較URL復元後のカメラ位置をfly:false診断が上書きしない',
    Math.abs(compareRestoreCamera.lon - restoredCamera.lon) < 1e-5
      && Math.abs(compareRestoreCamera.lat - restoredCamera.lat) < 1e-5
      && compareRestoreCamera.mapSync.adjustmentCount === 0,
    JSON.stringify(compareRestoreCamera),
  );
  await compareRestorePage.close();
} finally {
  await mobileViewer.close();
}

console.log('\n=== R-UX-P2 動線 ===');
const p2DesktopViewer = await launchViewer({ viewport: { width: 1440, height: 900 } });
try {
  const { page } = p2DesktopViewer;
  await page.waitForFunction(() => !!window.__nakano?.panelSections, null, { timeout: 180000 });

  check('PC幅では現在地FABを表示しない', await page.isHidden('#geoFab'));

  const initialPanel = await page.evaluate(() => ({
    order: [...document.querySelectorAll('#controlPanel > [data-panel-section]')]
      .map((section) => section.id),
    open: [...document.querySelectorAll('#controlPanel > [data-panel-section]')]
      .filter((section) => section.querySelector('.panel-section-toggle')
        ?.getAttribute('aria-expanded') === 'true')
      .map((section) => section.id),
    headerHeights: [...document.querySelectorAll('.panel-section-toggle')]
      .map((button) => button.getBoundingClientRect().height),
  }));
  check(
    '左パネルを検索→エリア→建物→ハザード→日影→その他の順に配置する',
    initialPanel.order.join(',') === [
      'searchSection',
      'areaSection',
      'buildingModelSection',
      'hazardSection',
      'shadeMapSection',
      'zoningLayerSection',
      'basemapSection',
      'presetSection',
      'otherLayerSection',
    ].join(','),
    JSON.stringify(initialPanel.order),
  );
  check(
    '初期展開は検索とエリアだけ',
    initialPanel.open.join(',') === 'searchSection,areaSection',
    JSON.stringify(initialPanel.open),
  );
  check(
    '左パネル見出しのタッチ領域はすべて44px以上',
    initialPanel.headerHeights.every((height) => height >= 43.5),
    JSON.stringify(initialPanel.headerHeights),
  );
} finally {
  await p2DesktopViewer.close();
}

const p2MobileViewer = await launchViewer({
  viewport: { width: 390, height: 844 },
  contextOptions: {
    hasTouch: true,
    isMobile: true,
    geolocation: { longitude: 139.6686, latitude: 35.7056 },
  },
  permissions: ['geolocation'],
});
try {
  const { page } = p2MobileViewer;
  await page.waitForFunction(() => !!window.__nakano?.panelSections, null, { timeout: 180000 });

  const fab = await page.evaluate(() => {
    const button = document.getElementById('geoFab');
    const rect = button.getBoundingClientRect();
    return {
      visible: getComputedStyle(button).display !== 'none',
      width: rect.width,
      height: rect.height,
      bottom: getComputedStyle(button).bottom,
    };
  });
  check(
    'モバイル幅では56pxの現在地FABを地図右下に表示する',
    fab.visible && fab.width === 56 && fab.height === 56 && Number.parseFloat(fab.bottom) >= 44,
    JSON.stringify(fab),
  );

  const controlTouchAudit = await auditTouchTargets(page, { revealControls: true });
  check(
    '左パネルを含むモバイルUIのタッチ領域は許容リストを除き44px以上',
    controlTouchAudit.auditedCount > 0 && controlTouchAudit.violations.length === 0,
    JSON.stringify(controlTouchAudit),
  );

  await page.click('#geoFab');
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 60000 });
  await page.waitForFunction(
    () => {
      const result = window.__nakano.diagnosis.getLastResult();
      return Math.abs(result?.lon - 139.6686) < 1e-6
        && Math.abs(result?.lat - 35.7056) < 1e-6;
    },
    null,
    { timeout: 60000 },
  );
  check('現在地FABのタップで既存の現在地診断フローから診断カードを表示する', true);

  await page.evaluate(() => {
    window.__nakano.bottomSheet.setState('full');
    const body = document.getElementById('diagBody');
    body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(350);
  const stickyActions = await page.evaluate(() => {
    const panel = document.getElementById('diagnosisPanel');
    const header = panel.querySelector(':scope > .info-header');
    const panelRect = panel.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const actions = [...header.querySelectorAll('.card-actions button')].map((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(
        (rect.left + rect.right) / 2,
        (rect.top + rect.bottom) / 2,
      );
      return {
        width: rect.width,
        height: rect.height,
        visible: hit === button || button.contains(hit),
      };
    });
    return {
      position: getComputedStyle(header).position,
      withinPanel: headerRect.top >= panelRect.top && headerRect.bottom <= panelRect.bottom,
      actions,
    };
  });
  check(
    '診断カード上部アクションはスクロール後もstickyで見える',
    stickyActions.position === 'sticky'
      && stickyActions.withinPanel
      && stickyActions.actions.every(({ visible }) => visible),
    JSON.stringify(stickyActions),
  );
  check(
    '診断カード上部アクションのタッチ領域はすべて44px以上',
    stickyActions.actions.every(({ width, height }) => width >= 43.5 && height >= 43.5),
    JSON.stringify(stickyActions.actions),
  );

  await page.click('#compareAddBtn');
  await page.evaluate(() => window.__nakano.diagnosis.close());
  await page.waitForFunction(
    () => Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--compare-bar-offset'),
    ) > 0 && getComputedStyle(document.getElementById('geoFab')).display !== 'none',
  );
  const fabCompareHit = await page.evaluate(() => {
    const fab = document.getElementById('geoFab');
    const bar = document.getElementById('compareBar');
    const fabRect = fab.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const hit = document.elementFromPoint(
      (fabRect.left + fabRect.right) / 2,
      (fabRect.top + fabRect.bottom) / 2,
    );
    return {
      fabBottom: fabRect.bottom,
      compareTop: barRect.top,
      fabZIndex: Number(getComputedStyle(fab).zIndex),
      compareZIndex: Number(getComputedStyle(bar).zIndex),
      hitFab: hit === fab || fab.contains(hit),
    };
  });
  check(
    '比較バー表示中もFABの実効タッチ領域が重ならず最前面にある',
    fabCompareHit.fabBottom <= fabCompareHit.compareTop
      && fabCompareHit.fabZIndex > fabCompareHit.compareZIndex
      && fabCompareHit.hitFab,
    JSON.stringify(fabCompareHit),
  );
  await page.evaluate(async () => {
    await window.__nakano.diagnosis.runDiagnosisAt(139.6659, 35.7010, {
      title: '中野駅南口の比較地点',
      fly: false,
      skipSunlight: true,
    });
  });
  await page.click('#compareAddBtn');

  await openSection(page, 'shadeMapSection');
  await page.evaluate(async (center) => {
    const result = await window.__nakano.shadeMap.run({
      center,
      sizeM: 20,
      pitchM: 20,
      date: 'winter',
      frameBudgetMs: 40,
    });
    if (!result.completed) throw new Error('モバイルの日影マップ計算が完了しませんでした');
  }, STATION);

  await page.evaluate(() => window.__nakano.bottomSheet.setState('full'));
  await page.waitForTimeout(350);
  await page.click('#compareShowBtn');
  await page.waitForSelector('#compareModal:not(.hidden) .cmp-table');
  const resultTouchAudit = await auditTouchTargets(page);
  check(
    '診断シート・比較UIのタッチ領域は許容リストを除き44px以上',
    resultTouchAudit.auditedCount > 0 && resultTouchAudit.violations.length === 0,
    JSON.stringify(resultTouchAudit),
  );
  const mobileWidth = await page.evaluate(() => {
    const sheetRect = document.getElementById('diagnosisPanel').getBoundingClientRect();
    const compareScroll = document.querySelector('.cmp-scroll');
    return {
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      sheetWidth: sheetRect.width,
      sheetLeft: sheetRect.left,
      sheetRight: sheetRect.right,
      compareTableVisible: getComputedStyle(document.getElementById('compareModal')).display !== 'none',
      compareClientWidth: compareScroll.clientWidth,
      compareScrollWidth: compareScroll.scrollWidth,
    };
  });
  check(
    '390px幅で診断→比較追加→日影実行後も横オーバーフローがない',
    mobileWidth.compareTableVisible
      && mobileWidth.documentWidth <= mobileWidth.viewportWidth + 1,
    JSON.stringify(mobileWidth),
  );
  check(
    '比較テーブル表示中も診断シート幅をビューポート幅±1pxに固定する',
    Math.abs(mobileWidth.sheetWidth - mobileWidth.viewportWidth) <= 1,
    JSON.stringify(mobileWidth),
  );
  await page.evaluate(() => window.__nakano.compare.clearAll());

  await page.evaluate(() => window.__nakano.diagnosis.close());
  await openSection(page, 'buildingModelSection');
  await page.evaluate(() => {
    document.querySelector('#searchSection .panel-section-toggle').click();
  });
  await page.reload({ waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => !!window.__nakano?.panelSections, null, { timeout: 180000 });
  const restoredPanel = await page.evaluate(() => ({
    search: window.__nakano.panelSections.isOpen('searchSection'),
    building: window.__nakano.panelSections.isOpen('buildingModelSection'),
  }));
  check(
    '左パネルの折りたたみ状態をreload後も維持する',
    restoredPanel.search === false && restoredPanel.building === true,
    JSON.stringify(restoredPanel),
  );
} finally {
  await p2MobileViewer.close();
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
check(
  '各操作の計測種別をuser-inputまたはprogrammaticで記録する',
  operations.every(({ measurementKind }) =>
    measurementKind === 'user-input' || measurementKind === 'programmatic'),
  JSON.stringify(operations.map(({ name, measurementKind }) => ({ name, measurementKind }))),
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
  measurementMode: 'mark-measure-delta',
  measurementKinds: {
    'user-input': { primaryMetrics: ['loaf', 'event-timing'] },
    programmatic: { primaryMetrics: ['loaf'] },
  },
  operations,
}, null, 2)}\n`);
console.log(`ベースライン保存先: ${BASELINE_PATH}`);

report('R-UX-P0 e2e');
