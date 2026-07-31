// R3-P4（日影マップ描画・UI統合）のブラウザ統合テスト
// 実行: node test/e2e-r3-shade.test.mjs （事前に localhost:8123 で配信）
//
// canvas上のマウス操作は行わず、DOM直叩きとwindow.__nakano.shadeMapを使う。

import { launchViewer, waitForViewerReady, check, report, shotPath } from './harness.mjs';

const COMPLETE_OPTIONS = {
  sizeM: 80,
  pitchM: 10,
  date: 'winter',
  frameBudgetMs: 40,
};
const LAYER_CACHE_OPTIONS = {
  sizeM: 40,
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
      levels: result?.grid?.levels?.map((level) => level.level) || [],
      cacheKey: result?.cacheKey || null,
      layerKind: result?.layerKind || null,
    };
  }, promiseName);
}

/** フックのrunを待たずに開始し、window上の指定名へPromiseを保持する。 */
async function startRun(promiseName, options) {
  await page.evaluate(({ name, opts }) => {
    window[name] = window.__nakano.shadeMap.run(opts);
  }, { name: promiseName, opts: options });
}

/** 日影レイヤーのadd/removeと、その時点の総レイヤー数を記録する。 */
async function startImageryTrace() {
  await page.evaluate(() => {
    const layers = window.__nakano.viewer.imageryLayers;
    const ids = new WeakMap();
    const active = new Set();
    let nextId = 1;
    const trace = {
      baseLength: layers.length,
      events: [],
      maxActive: 0,
      stop: null,
    };
    const removeAdded = layers.layerAdded.addEventListener((layer) => {
      const id = nextId++;
      ids.set(layer, id);
      active.add(id);
      trace.maxActive = Math.max(trace.maxActive, active.size);
      trace.events.push({ type: 'add', id, length: layers.length, active: active.size });
    });
    const removeRemoved = layers.layerRemoved.addEventListener((layer) => {
      const id = ids.get(layer) || null;
      if (id !== null) active.delete(id);
      trace.events.push({ type: 'remove', id, length: layers.length, active: active.size });
    });
    trace.stop = () => {
      removeAdded();
      removeRemoved();
    };
    window.__shadeImageryTrace = trace;
  });
}

async function finishImageryTrace() {
  return page.evaluate(() => {
    const trace = window.__shadeImageryTrace;
    trace.stop();
    return {
      baseLength: trace.baseLength,
      events: trace.events,
      maxActive: trace.maxActive,
      finalActive: trace.events.at(-1)?.active || 0,
    };
  });
}

/** 次のpostRender listenerを保留し、pendingレイヤーを確実に作る。 */
async function holdNextPostRender() {
  await page.evaluate(() => {
    const event = window.__nakano.viewer.scene.postRender;
    const originalAddEventListener = event.addEventListener;
    const hold = {
      captured: false,
      removed: false,
      released: false,
      listener: null,
      restore: () => {
        event.addEventListener = originalAddEventListener;
      },
      release: null,
    };
    event.addEventListener = function addHeldListener(listener, scope) {
      if (hold.captured) {
        return originalAddEventListener.call(event, listener, scope);
      }
      hold.captured = true;
      hold.listener = () => listener.call(scope);
      return () => {
        hold.removed = true;
      };
    };
    hold.release = () => {
      if (hold.released) return;
      hold.released = true;
      hold.restore();
      if (!hold.removed) hold.listener?.();
    };
    window.__shadePostRenderHold = hold;
  });
}

async function waitForHeldPostRender() {
  await page.waitForFunction(
    () => window.__shadePostRenderHold?.captured === true,
    null,
    { timeout: 30000, polling: 10 }
  );
}

async function releaseHeldPostRender() {
  await page.evaluate(() => window.__shadePostRenderHold?.release());
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
  await startImageryTrace();
  await startRun('__shadeComplete', COMPLETE_OPTIONS);
  const completed = await resultOf('__shadeComplete');
  const imageryTrace = await finishImageryTrace();
  const canvasState = await page.evaluate(() => window.__nakano.shadeMap.getCanvasState());
  const completedDom = await page.evaluate(() => ({
    imagery: window.__nakano.viewer.imageryLayers.length,
    legendItems: document.querySelectorAll('#shadeLegend .shade-legend-item').length,
    legendHex: [...document.querySelectorAll('#shadeLegend .shade-legend-item i')]
      .map((item) => item.getAttribute('style')?.match(/#[0-9a-f]{6}/i)?.[0].toLowerCase()),
    legendVisible: getComputedStyle(document.getElementById('shadeLegend')).display !== 'none',
    rooftopNote: document.querySelector('#shadeMapSection .shade-note')?.textContent || '',
    progress: document.getElementById('shadeProgress')?.value,
    status: document.getElementById('shadeStatus')?.textContent,
  }));
  const addedLayers = imageryTrace.events.filter((event) => event.type === 'add');
  const removedLayerIds = new Set(
    imageryTrace.events
      .filter((event) => event.type === 'remove')
      .map((event) => event.id)
  );
  const finalLayerId = addedLayers.at(-1)?.id;
  const oldLayersRemoved = addedLayers
    .slice(0, -1)
    .every((event) => removedLayerIds.has(event.id));
  const canvasSample = canvasState.samples.find(
    (sample) => sample.actualHex === sample.expectedHex && sample.alpha > 0
  );
  const canvasMismatches = canvasState.samples.filter(
    (sample) => sample.actualHex !== sample.expectedHex || sample.alpha === 0
  );
  console.log('  完走結果: ' + JSON.stringify({
    completed,
    completedDom,
    imageryTrace,
    canvasSample,
  }));

  check('縮小グリッドが完走する', completed.completed === true, JSON.stringify(completed));
  check('81セル（80m/10m）の値が返る', completed.cellCount === 81,
    String(completed.cellCount));
  check('40m→20m→10mの3レベルで完走する',
    JSON.stringify(completed.levels) === JSON.stringify([40, 20, 10]),
    JSON.stringify(completed.levels));
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
  check('各レベル完了で日影レイヤーが差し替えられる',
    addedLayers.length >= completed.levels.length,
    JSON.stringify(imageryTrace));
  check('差し替え中も日影レイヤーは最大2層、完了後は1層になる',
    imageryTrace.maxActive === 2
      && imageryTrace.finalActive === 1
      && imageryTrace.events.every((event) =>
        event.length <= imageryBefore + 2
      ),
    JSON.stringify(imageryTrace));
  check('差し替え済みの旧日影レイヤーがすべて除去され最終層だけ残る',
    oldLayersRemoved && finalLayerId !== undefined && !removedLayerIds.has(finalLayerId),
    JSON.stringify(imageryTrace));
  check('粗→精の最終canvasは透明な未計算領域を残さず全面を塗る',
    canvasState.transparentPixels === 0,
    `transparentPixels=${canvasState.transparentPixels}`);
  check('代表セルのcanvas色がhoursToColorの結果と一致する',
    !!canvasSample
      && canvasState.samples.length === completed.cellCount
      && canvasMismatches.length === 0,
    JSON.stringify(canvasMismatches.slice(0, 5)));
  check('canvasが参照する凡例HEXと表示中の5段凡例が一致する',
    JSON.stringify(canvasState.legendHex) === JSON.stringify(completedDom.legendHex),
    JSON.stringify({ canvas: canvasState.legendHex, dom: completedDom.legendHex }));

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

  // ==== 3. 連続runとpending中clear ====
  console.log('\n--- F3-2: 連続runとpending中clear ---');
  await startRun('__shadeContinuousFirst', {
    sizeM: 80,
    pitchM: 10,
    date: 'spring',
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
  await startRun('__shadeContinuousSecond', {
    sizeM: 40,
    pitchM: 20,
    date: 'summer',
    frameBudgetMs: 40,
  });
  const continuousFirst = await resultOf('__shadeContinuousFirst');
  const continuousSecond = await resultOf('__shadeContinuousSecond');
  const continuousState = await page.evaluate(() => {
    const state = window.__nakano.shadeMap.getState();
    return {
      status: state.status,
      cacheKey: state.result?.cacheKey,
      layerKind: state.result?.layerKind,
      running: state.running,
    };
  });
  check('連続runでは先行runが再実行理由で中断される',
    continuousFirst.completed === false && continuousFirst.cancelReason === '再実行',
    JSON.stringify(continuousFirst));
  check('連続runの最終状態は後続runの完走結果になる',
    continuousSecond.completed === true
      && continuousState.status === '計算完了'
      && continuousState.cacheKey === continuousSecond.cacheKey
      && !continuousState.running,
    JSON.stringify({ continuousSecond, continuousState }));
  await page.evaluate(() => window.__nakano.shadeMap.clear());

  await holdNextPostRender();
  await startRun('__shadePendingClear', COMPLETE_OPTIONS);
  await waitForHeldPostRender();
  const pendingBeforeClear = await page.evaluate(
    () => window.__nakano.viewer.imageryLayers.length
  );
  await page.evaluate(() => window.__nakano.shadeMap.clear());
  await releaseHeldPostRender();
  const pendingCleared = await resultOf('__shadePendingClear');
  const pendingClearState = await page.evaluate(() => ({
    imagery: window.__nakano.viewer.imageryLayers.length,
    status: window.__nakano.shadeMap.getState().status,
    layerPresent: window.__nakano.shadeMap.getState().layerPresent,
  }));
  check('postRender待ちのclearはpendingレイヤーを直ちに除去する',
    pendingBeforeClear === imageryBefore + 1
      && pendingClearState.imagery === imageryBefore
      && !pendingClearState.layerPresent,
    JSON.stringify({ pendingBeforeClear, pendingClearState }));
  check('pending中clear後に旧runが計算完了へ戻さない',
    pendingCleared.completed === false
      && pendingCleared.cancelReason === 'クリア'
      && pendingClearState.status === '未計算',
    JSON.stringify({ pendingCleared, pendingClearState }));

  // ==== 4. 建物レイヤー切替とlayerKind別キャッシュ ====
  console.log('\n--- F3-2: 建物レイヤー切替とlayerKind別キャッシュ ---');
  await startRun('__shadeBeforeLayerSwitch', COMPLETE_OPTIONS);
  await resultOf('__shadeBeforeLayerSwitch');
  await page.evaluate(() => {
    window.__shadeLayerSwitch = window.__nakano.showBuildings('lod2notex');
  });
  const switchCleared = await page.evaluate(() => ({
    imagery: window.__nakano.viewer.imageryLayers.length,
    state: window.__nakano.shadeMap.getState(),
  }));
  check('建物レイヤー切替の確定時に日影オーバーレイが消える',
    switchCleared.imagery === imageryBefore
      && !switchCleared.state.layerPresent
      && switchCleared.state.status === '未計算',
    JSON.stringify(switchCleared));
  await page.evaluate(() => window.__shadeLayerSwitch);
  await page.waitForFunction(
    () => window.__nakano.loaded.bldgLod2NoTex?.show === true,
    null,
    { timeout: 180000, polling: 100 }
  );

  await startRun('__shadeNoTexMiss', LAYER_CACHE_OPTIONS);
  const noTexMiss = await resultOf('__shadeNoTexMiss');
  await startRun('__shadeNoTexHit', LAYER_CACHE_OPTIONS);
  const noTexHit = await resultOf('__shadeNoTexHit');
  check('lod2notex条件はキャッシュmiss→hitになる',
    noTexMiss.completed === true
      && noTexMiss.cacheHit === false
      && noTexMiss.layerKind === 'lod2notex'
      && noTexHit.cacheHit === true,
    JSON.stringify({ noTexMiss, noTexHit }));

  await page.evaluate(() => window.__nakano.showBuildings('lod2'));
  await startRun('__shadeLod2Miss', LAYER_CACHE_OPTIONS);
  const lod2Miss = await resultOf('__shadeLod2Miss');
  await startRun('__shadeLod2Hit', LAYER_CACHE_OPTIONS);
  const lod2Hit = await resultOf('__shadeLod2Hit');
  check('lod2条件も独立したキャッシュmiss→hitになる',
    lod2Miss.completed === true
      && lod2Miss.cacheHit === false
      && lod2Miss.layerKind === 'lod2'
      && lod2Hit.cacheHit === true,
    JSON.stringify({ lod2Miss, lod2Hit }));
  check('layerKindが異なるキャッシュキーは一致しない',
    noTexMiss.cacheKey !== lod2Miss.cacheKey,
    JSON.stringify({ noTex: noTexMiss.cacheKey, lod2: lod2Miss.cacheKey }));

  await page.evaluate(async () => {
    const stale = window.__nakano.showBuildings('lod2notex');
    const latest = window.__nakano.showBuildings('lod2');
    await Promise.all([stale, latest]);
  });
  const rapidBuildingSwitch = await page.evaluate(() => ({
    lod2: window.__nakano.loaded.bldgLod2?.show,
    lod2notex: window.__nakano.loaded.bldgLod2NoTex?.show,
  }));
  check('連続した建物レイヤー要求では最新世代だけが表示される',
    rapidBuildingSwitch.lod2 === true && rapidBuildingSwitch.lod2notex === false,
    JSON.stringify(rapidBuildingSwitch));

  // ==== 5. キャッシュpending中の診断開始と0セル終了 ====
  console.log('\n--- F3-2: キャッシュpending中断と0セル終了 ---');
  await holdNextPostRender();
  await startRun('__shadeCachedDiagnosisAbort', LAYER_CACHE_OPTIONS);
  await waitForHeldPostRender();
  await page.evaluate(() => {
    window.__nakano.diagnosis.diagnose({
      lon: 139.6659,
      lat: 35.7010,
      title: 'キャッシュ描画を中断する診断',
      picked: null,
      fly: false,
      skipSunlight: true,
    }).catch((error) => console.warn('キャッシュ中断診断に失敗しました', error));
  });
  await releaseHeldPostRender();
  const cachedDiagnosisAbort = await resultOf('__shadeCachedDiagnosisAbort');
  const cachedDiagnosisState = await page.evaluate(() => {
    const state = window.__nakano.shadeMap.getState();
    return {
      status: state.status,
      running: state.running,
      layerPresent: state.layerPresent,
      imagery: window.__nakano.viewer.imageryLayers.length,
    };
  });
  check('キャッシュヒットのpostRender待機中に診断を始めると中断される',
    cachedDiagnosisAbort.completed === false
      && cachedDiagnosisAbort.cancelReason === '診断開始',
    JSON.stringify(cachedDiagnosisAbort));
  check('診断によるキャッシュ中断は「計算完了」表示やpending層を残さない',
    !cachedDiagnosisState.running
      && !cachedDiagnosisState.status.includes('計算完了')
      && !cachedDiagnosisState.layerPresent
      && cachedDiagnosisState.imagery === imageryBefore,
    JSON.stringify(cachedDiagnosisState));
  await page.evaluate(() => window.__nakano.diagnosis.close());

  await startRun('__shadeBeforeZeroCells', COMPLETE_OPTIONS);
  const beforeZeroCells = await resultOf('__shadeBeforeZeroCells');
  const beforeZeroLayerState = await page.evaluate(() => ({
    layerPresent: window.__nakano.shadeMap.getState().layerPresent,
    imagery: window.__nakano.viewer.imageryLayers.length,
  }));
  await page.evaluate(() => {
    const scene = window.__nakano.viewer.scene;
    window.__shadePickFromRayDescriptor = Object.getOwnPropertyDescriptor(scene, 'pickFromRay');
    Object.defineProperty(scene, 'pickFromRay', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });
  let zeroCells;
  try {
    await startRun('__shadeZeroCells', {
      sizeM: 40,
      pitchM: 10,
      date: 'spring',
      year: 2037,
      frameBudgetMs: 40,
    });
    zeroCells = await resultOf('__shadeZeroCells');
  } finally {
    await page.evaluate(() => {
      const scene = window.__nakano.viewer.scene;
      const descriptor = window.__shadePickFromRayDescriptor;
      if (descriptor) Object.defineProperty(scene, 'pickFromRay', descriptor);
      else delete scene.pickFromRay;
    });
  }
  const zeroCellState = await page.evaluate(() => {
    const state = window.__nakano.shadeMap.getState();
    return {
      status: state.status,
      layerPresent: state.layerPresent,
      imagery: window.__nakano.viewer.imageryLayers.length,
    };
  });
  check('0セル終了の前には旧オーバーレイが表示されている',
    beforeZeroCells.completed === true
      && beforeZeroLayerState.layerPresent
      && beforeZeroLayerState.imagery === imageryBefore + 1,
    JSON.stringify({ beforeZeroCells, beforeZeroLayerState }));
  check('レイキャスト非対応の0セル終了はエラー結果になる',
    zeroCells.completed === false
      && zeroCells.computedCount === 0
      && zeroCells.error?.includes('レイキャスト'),
    JSON.stringify(zeroCells));
  check('0セル終了で旧オーバーレイが除去されUIと地図が一致する',
    !zeroCellState.layerPresent
      && zeroCellState.imagery === imageryBefore
      && zeroCellState.status.includes('レイキャスト'),
    JSON.stringify(zeroCellState));

  // ==== 6. rAF応答性・計算中の診断カード閉鎖 ====
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

  // ==== 7. 診断開始による日影マップ自動中断 ====
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

  // ==== 8. モバイル幅390pxでのレイアウト ====
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

  // ==== 9. 中野駅前の日影マップスクリーンショット ====
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
