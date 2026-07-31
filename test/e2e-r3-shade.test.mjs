// R3-P4（日影マップ描画・UI統合）のブラウザ統合テスト
// 実行: node test/e2e-r3-shade.test.mjs （事前に localhost:8123 で配信）
//
// canvas上のマウス操作は行わず、DOM直叩きとwindow.__nakano.shadeMapを使う。

import { launchViewer, waitForViewerReady, check, report, shotPath } from './harness.mjs';

const COMPLETE_OPTIONS = {
  sizeM: 100,
  pitchM: 20,
  date: 'winter',
  frameBudgetMs: 40,
};
const STATION = {
  lon: 139.6659,
  lat: 35.7010,
  height: 500,
  heading: 0,
  pitch: -90,
};

const t = await launchViewer({ viewport: { width: 1440, height: 900 } });
const { page } = t;

/** Playwrightへ渡すため、計算結果を必要な値だけのプレーンオブジェクトへする。 */
async function resultOf(promiseName) {
  return page.evaluate(async (name) => {
    const result = await window[name];
    const values = Array.from(result?.cells || []);
    return {
      completed: result?.completed,
      error: result?.error,
      cacheHit: result?.cacheHit,
      cancelReason: result?.cancelReason,
      computedCount: result?.computedCount,
      raysCompleted: result?.raysCompleted,
      totalRays: result?.totalRays,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      nonzero: values.filter((value) => value > 0).length,
      cellCount: values.length,
      boundsOuter: result?.grid?.boundsOuter || null,
    };
  }, promiseName);
}

/** フックのrunを待たずに開始し、window上の指定名へPromiseを保持する。 */
async function startRun(promiseName, options) {
  await page.evaluate(({ name, opts }) => {
    window[name] = window.__nakano.shadeMap.run(opts);
  }, { name: promiseName, opts: options });
}

try {
  await waitForViewerReady(page);
  await page.waitForTimeout(8000);
  await page.evaluate((destination) => window.__nakano.flyTo(destination, 0), STATION);
  await page.waitForTimeout(5000);

  // ==== 1. 縮小グリッド完走・描画・凡例・クリア ====
  console.log('\n--- F3-2: 縮小グリッドの完走とオーバーレイ ---');
  const imageryBefore = await page.evaluate(
    () => window.__nakano.viewer.imageryLayers.length
  );
  await startRun('__shadeComplete', COMPLETE_OPTIONS);
  const completed = await resultOf('__shadeComplete');
  const completedDom = await page.evaluate(() => ({
    imagery: window.__nakano.viewer.imageryLayers.length,
    legendItems: document.querySelectorAll('#shadeLegend .shade-legend-item').length,
    legendVisible: getComputedStyle(document.getElementById('shadeLegend')).display !== 'none',
    rooftopNote: document.querySelector('#shadeMapSection .shade-note')?.textContent || '',
    progress: document.getElementById('shadeProgress')?.value,
    status: document.getElementById('shadeStatus')?.textContent,
  }));
  console.log('  完走結果: ' + JSON.stringify({ completed, completedDom }));

  check('縮小グリッドが完走する', completed.completed === true, JSON.stringify(completed));
  check('36セル（100m/20m）の値が返る', completed.cellCount === 36,
    String(completed.cellCount));
  check('セルの日照時間に分散がある（min < max）',
    completed.min < completed.max, `min=${completed.min} max=${completed.max}`);
  check('日影マップ完走後にimageryLayersが1層増える',
    completedDom.imagery === imageryBefore + 1,
    `before=${imageryBefore} after=${completedDom.imagery}`);
  check('凡例が表示され5段ある',
    completedDom.legendVisible && completedDom.legendItems === 5,
    JSON.stringify(completedDom));
  check('屋上セルの注記が表示される',
    completedDom.rooftopNote.includes('建物屋上のセルは屋上面での値'),
    completedDom.rooftopNote);
  check('完走時の進捗が100%になる',
    completedDom.progress === 100 && completedDom.status.includes('計算完了'),
    JSON.stringify(completedDom));

  await page.evaluate(() => window.__nakano.shadeMap.clear());
  const imageryAfterClear = await page.evaluate(
    () => window.__nakano.viewer.imageryLayers.length
  );
  check('クリアで日影マップのimageryLayerが1層減る',
    imageryAfterClear === imageryBefore,
    `expected=${imageryBefore} actual=${imageryAfterClear}`);

  // ==== 2. 中断・部分結果・ボタン復帰・既存完走条件のキャッシュヒット ====
  console.log('\n--- F3-2: 中断とキャッシュヒット ---');
  await startRun('__shadeAbortRun', {
    sizeM: 100,
    pitchM: 10,
    date: 'winter',
    frameBudgetMs: 40,
  });
  await page.waitForFunction(
    () => {
      const state = window.__nakano.shadeMap.getState();
      return state.running && state.progress > 0.01;
    },
    null,
    { timeout: 180000, polling: 50 }
  );
  const runningButtons = await page.evaluate(() => ({
    runDisabled: document.getElementById('shadeRun').disabled,
    abortHidden: document.getElementById('shadeAbort').classList.contains('hidden'),
  }));
  await page.evaluate(() => window.__nakano.shadeMap.abort());
  const aborted = await resultOf('__shadeAbortRun');
  const abortedState = await page.evaluate(() => {
    const state = window.__nakano.shadeMap.getState();
    return {
      running: state.running,
      status: state.status,
      resultCount: state.result?.computedCount,
      runDisabled: document.getElementById('shadeRun').disabled,
      abortHidden: document.getElementById('shadeAbort').classList.contains('hidden'),
    };
  });
  console.log('  中断結果: ' + JSON.stringify({ aborted, abortedState }));

  check('計算中は「計算する」が無効で「中断」が表示される',
    runningButtons.runDisabled && !runningButtons.abortHidden,
    JSON.stringify(runningButtons));
  check('中断結果はcompleted:falseになる',
    aborted.completed === false && !aborted.error, JSON.stringify(aborted));
  check('中断時に計算済みの部分結果を保持する',
    aborted.computedCount > 0 && abortedState.resultCount === aborted.computedCount,
    JSON.stringify({ aborted, abortedState }));
  check('中断後に日本語の進捗メッセージが表示される',
    /^中断（\d+%まで計算済み）$/.test(abortedState.status),
    abortedState.status);
  check('中断後は「計算する」が有効に戻り「中断」が隠れる',
    !abortedState.runDisabled && abortedState.abortHidden && !abortedState.running,
    JSON.stringify(abortedState));

  const cacheStart = await page.evaluate(() => performance.now());
  await startRun('__shadeCached', COMPLETE_OPTIONS);
  const cached = await resultOf('__shadeCached');
  const cacheDisplay = await page.evaluate((started) => ({
    elapsed: performance.now() - started,
    notice: document.getElementById('shadeCacheNotice')?.textContent || '',
    noticeHidden: document.getElementById('shadeCacheNotice')?.classList.contains('hidden'),
  }), cacheStart);
  console.log('  キャッシュ結果: ' + JSON.stringify({ cached, cacheDisplay }));
  check('完走済み条件の再実行はキャッシュヒットになる',
    cached.completed === true && cached.cacheHit === true, JSON.stringify(cached));
  check('キャッシュヒットは1秒未満で再描画される',
    cacheDisplay.elapsed < 1000, `${cacheDisplay.elapsed.toFixed(1)}ms`);
  check('「キャッシュから表示」が小さく表示される',
    !cacheDisplay.noticeHidden && cacheDisplay.notice.includes('キャッシュから表示'),
    JSON.stringify(cacheDisplay));
  await page.evaluate(() => window.__nakano.shadeMap.clear());

  // ==== 3. rAF応答性・計算中の診断カード閉鎖 ====
  console.log('\n--- F3-2: rAF応答性と診断カード操作 ---');
  await page.evaluate(() => {
    window.__nakano.diagnosis.diagnose({
      lon: 139.6659,
      lat: 35.7010,
      title: '日影マップ応答性テスト',
      picked: null,
      fly: false,
      skipSunlight: true,
    }).catch((error) => console.warn('診断カード準備に失敗しました', error));
  });
  await page.waitForSelector('#diagnosisPanel:not(.hidden)', { timeout: 30000 });
  await page.evaluate(() => {
    window.__shadeRaf = { active: true, last: null, intervals: [] };
    const tick = (timestamp) => {
      const recorder = window.__shadeRaf;
      if (!recorder?.active) return;
      if (window.__nakano.shadeMap.getState().running) {
        if (recorder.last !== null) recorder.intervals.push(timestamp - recorder.last);
        recorder.last = timestamp;
      } else {
        recorder.last = null;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await startRun('__shadeResponsive', {
    sizeM: 100,
    pitchM: 10,
    date: 'spring',
    frameBudgetMs: 40,
  });
  await page.waitForFunction(
    () => {
      const state = window.__nakano.shadeMap.getState();
      return state.running && state.progress > 0.01 && window.__shadeRaf.intervals.length >= 3;
    },
    null,
    { timeout: 180000, polling: 50 }
  );
  const closeResponse = await page.evaluate(() => {
    const started = performance.now();
    window.__nakano.diagnosis.close();
    return {
      elapsed: performance.now() - started,
      hidden: document.getElementById('diagnosisPanel').classList.contains('hidden'),
    };
  });
  await page.evaluate(() => window.__nakano.shadeMap.abort());
  await resultOf('__shadeResponsive');
  const rafResult = await page.evaluate(() => {
    window.__shadeRaf.active = false;
    const values = [...window.__shadeRaf.intervals].sort((a, b) => a - b);
    return {
      count: values.length,
      median: values.length ? values[Math.floor(values.length / 2)] : null,
    };
  });
  console.log('  応答性: ' + JSON.stringify({ closeResponse, rafResult }));
  check('計算中のrAF間隔中央値が400ms未満',
    rafResult.count >= 3 && rafResult.median < 400, JSON.stringify(rafResult));
  check('計算中でも診断カードを2秒以内に閉じられる',
    closeResponse.hidden && closeResponse.elapsed < 2000,
    JSON.stringify(closeResponse));

  // ==== 4. 診断開始による日影マップ自動中断 ====
  console.log('\n--- F3-2: 診断開始との排他 ---');
  await startRun('__shadeDiagnosisAbort', {
    sizeM: 100,
    pitchM: 10,
    date: 'summer',
    frameBudgetMs: 40,
  });
  await page.waitForFunction(
    () => {
      const state = window.__nakano.shadeMap.getState();
      return state.running && state.progress > 0.005;
    },
    null,
    { timeout: 180000, polling: 50 }
  );
  await page.evaluate(() => {
    window.__nakano.diagnosis.diagnose({
      lon: 139.667,
      lat: 35.702,
      title: '日影マップを中断する診断',
      picked: null,
      fly: false,
      skipSunlight: true,
    }).catch((error) => console.warn('排他テストの診断に失敗しました', error));
  });
  const diagnosisAborted = await resultOf('__shadeDiagnosisAbort');
  console.log('  診断中断結果: ' + JSON.stringify(diagnosisAborted));
  check('診断開始で日影マップが自動中断される',
    diagnosisAborted.completed === false && diagnosisAborted.cancelReason === '診断開始',
    JSON.stringify(diagnosisAborted));
  await page.evaluate(() => window.__nakano.diagnosis.close());

  // ==== 5. モバイル幅390pxでのレイアウト ====
  console.log('\n--- F3-2: モバイルレイアウト ---');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => {
    const panel = document.getElementById('controlPanel');
    const section = document.getElementById('shadeMapSection');
    const legend = document.getElementById('shadeLegend');
    section.scrollIntoView({ block: 'start' });
    const panelRect = panel.getBoundingClientRect();
    const sectionRect = section.getBoundingClientRect();
    return {
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      panel: { left: panelRect.left, right: panelRect.right, width: panelRect.width },
      section: { left: sectionRect.left, right: sectionRect.right, width: sectionRect.width },
      legendClientWidth: legend.clientWidth,
      legendScrollWidth: legend.scrollWidth,
      legendItems: legend.querySelectorAll('.shade-legend-item').length,
      visible: getComputedStyle(section).display !== 'none',
    };
  });
  console.log('  モバイル寸法: ' + JSON.stringify(mobile));
  check('390px幅で日影マップセクションが表示領域内に収まる',
    mobile.visible
      && mobile.section.left >= mobile.panel.left
      && mobile.section.right <= mobile.panel.right + 1
      && mobile.documentWidth <= mobile.viewportWidth,
    JSON.stringify(mobile));
  check('390px幅で5段凡例が横にはみ出さない',
    mobile.legendItems === 5 && mobile.legendScrollWidth <= mobile.legendClientWidth + 1,
    JSON.stringify(mobile));
  await page.locator('#shadeMapSection').screenshot({
    path: shotPath('r3-shade-01-mobile-section.png'),
  });

  // ==== 6. 中野駅前の日影マップスクリーンショット ====
  console.log('\n--- F3-2: 駅前スクリーンショット ---');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate((destination) => window.__nakano.flyTo(destination, 0), STATION);
  await page.waitForTimeout(3000);
  await startRun('__shadeScreenshot', COMPLETE_OPTIONS);
  const screenshotResult = await resultOf('__shadeScreenshot');
  await page.evaluate(() => {
    const panel = document.getElementById('controlPanel');
    const section = document.getElementById('shadeMapSection');
    panel.scrollTop = Math.max(0, section.offsetTop - 70);
  });
  await page.waitForTimeout(500);
  await page.screenshot({
    path: shotPath('r3-shade-02-nakano-station.png'),
    fullPage: false,
  });
  check('駅前スクリーンショット用の日影マップが完走またはキャッシュ表示される',
    screenshotResult.completed === true, JSON.stringify(screenshotResult));

  const fatal = t.errors.filter(
    (error) =>
      error.startsWith('PAGEERROR')
      || /Failed to load module|SyntaxError|is not a function/.test(error)
  );
  check('致命的なJSエラーがない', fatal.length === 0, JSON.stringify(fatal.slice(0, 5)));
  if (t.errors.length) {
    console.log('\n(参考) console errors: ' + JSON.stringify(t.errors.slice(0, 8), null, 1));
  }
  console.log('中継: ' + JSON.stringify(t.relay));
} finally {
  await t.close();
}

report('e2e-r3-shade.test.mjs');
