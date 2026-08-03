// 日影マップのUI・canvas描画・SingleTileImageryProvider統合
//
// 計算エンジンはrun()の多重呼び出しを防がないため、このモジュールで実行世代と
// 直列キューを持つ。再実行・建物レイヤー切替・診断開始は実行中トークンを中断する。

import {
  buildShadeGrid,
  createShadeMapEngine,
  hoursToColor,
  shadeCacheKey,
  SHADE_LEGEND,
  ShadeMapCache,
} from './shademap.js';

const CANVAS_SIZE = 512;
const DEFAULT_SIZE_M = 200;
const DEFAULT_PITCH_M = 10;
const DEFAULT_DATE = 'winter';
const OVERLAY_ALPHA = 0.65;
const FINE_REPLACE_INTERVAL_MS = 2000;
// ページ内で実行条件をまたいで共有するLRU。再実行やオーバーレイのクリアでは破棄しない。
const shadeMapCache = new ShadeMapCache(4);

/**
 * 日影マップUIを初期化する。
 *
 * @param {{viewer:object,
 *          getBuildingState:()=>({tileset:object|null,layerKind:string|null}),
 *          cancelDiagnosisSunlight?:(()=>void), requestRender?:(()=>void)}} deps
 */
export function initShadeMap(deps) {
  const {
    viewer,
    getBuildingState,
    cancelDiagnosisSunlight = null,
    requestRender = () => viewer.scene.requestRender(),
  } = deps;
  const runButton = document.getElementById('shadeRun');
  const abortButton = document.getElementById('shadeAbort');
  const clearButton = document.getElementById('shadeClear');
  const dateSelect = document.getElementById('shadeDate');
  const pitchSelect = document.getElementById('shadePitch');
  const progress = document.getElementById('shadeProgress');
  const progressLabel = document.getElementById('shadeProgressLabel');
  const status = document.getElementById('shadeStatus');
  const cacheNotice = document.getElementById('shadeCacheNotice');
  const legend = document.getElementById('shadeLegend');

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const context = canvas.getContext('2d');
  const cache = shadeMapCache;
  const pendingLayers = new Set();

  let overlayLayer = null;
  let activeToken = null;
  let generation = 0;
  let runQueue = Promise.resolve();
  let overlayQueue = Promise.resolve();
  let lastOverlayAt = 0;
  let lastOverlayQueuedAt = 0;
  let lastQueuedOverlay = null;
  let state = {
    running: false,
    progress: 0,
    status: '未計算',
    cacheHit: false,
    result: null,
    layerPresent: false,
    layerKind: null,
  };

  renderLegend();
  updateUi();

  function renderLegend() {
    legend.innerHTML = SHADE_LEGEND.map((item) =>
      `<span class="shade-legend-item"><i style="background:${item.hex}"></i>${item.label}</span>`
    ).join('');
  }

  function updateUi() {
    const percent = Math.round(state.progress * 100);
    runButton.disabled = state.running;
    dateSelect.disabled = state.running;
    pitchSelect.disabled = state.running;
    abortButton.classList.toggle('hidden', !state.running);
    progress.value = percent;
    progressLabel.textContent = percent + '%';
    status.textContent = state.status;
    cacheNotice.classList.toggle('hidden', !state.cacheHit);
  }

  function setProgress(fraction) {
    state.progress = Math.min(1, Math.max(0, Number(fraction) || 0));
    if (state.running) state.status = `計算中… ${Math.round(state.progress * 100)}%`;
    updateUi();
  }

  function clearCanvas() {
    context.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  }

  function canvasBoundaries(count) {
    return Array.from(
      { length: count + 1 },
      (_, index) => Math.round(index * CANVAS_SIZE / count)
    );
  }

  function maximumHours(result) {
    return result.slotCount > 0 ? result.slotCount / 3 : 10;
  }

  /**
   * 指定セルをレベルのピッチ相当のブロックで塗る。細レベルは同じ領域を
   * clear後に上塗りするため、未計算領域には直前レベルの粗ブロックが残る。
   * 共有境界を使い、隣接ブロックの1px重複を避ける。
   */
  function drawCells(result, cells, levelPitchM = null) {
    const count = Math.round(result.grid.sizeM / result.grid.pitchM) + 1;
    const boundaries = canvasBoundaries(count);
    const maxHours = maximumHours(result);
    context.save();
    context.globalAlpha = OVERLAY_ALPHA;
    for (const cell of cells) {
      const blockPitchM = Number(levelPitchM ?? cell.level ?? result.grid.pitchM);
      const factor = Math.max(1, Math.round(blockPitchM / result.grid.pitchM));
      const columnStart = Math.max(0, Math.round(cell.column - factor / 2));
      const columnEnd = Math.min(count, Math.round(cell.column + factor / 2));
      const rowStart = Math.max(0, Math.round(cell.row - factor / 2));
      const rowEnd = Math.min(count, Math.round(cell.row + factor / 2));
      const x0 = boundaries[columnStart];
      const x1 = boundaries[columnEnd];
      const y0 = boundaries[count - rowEnd];
      const y1 = boundaries[count - rowStart];
      context.clearRect(x0, y0, x1 - x0, y1 - y0);
      context.fillStyle = hoursToColor(result.cells[cell.index], maxHours);
      context.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    context.restore();
  }

  function drawAll(result) {
    clearCanvas();
    const computedCount = Number.isInteger(result.computedCount)
      ? result.computedCount
      : result.grid.cells.length;
    drawCells(
      result,
      result.grid.cells.filter((cell) => cell.index < computedCount)
    );
  }

  function isTokenCurrent(token) {
    return !!token && token.id === generation && !token.cancelled;
  }

  function hasOverlay() {
    return !!overlayLayer && viewer.imageryLayers.contains(overlayLayer);
  }

  function removePendingLayer(layer) {
    pendingLayers.delete(layer);
    if (viewer.imageryLayers.contains(layer)) {
      viewer.imageryLayers.remove(layer, true);
      requestRender();
    }
  }

  function waitForPostRender() {
    return new Promise((resolve) => {
      let settled = false;
      let removeListener = () => {};
      const finish = () => {
        if (settled) return;
        settled = true;
        removeListener();
        clearTimeout(timeout);
        resolve();
      };
      removeListener = viewer.scene.postRender.addEventListener(finish);
      const timeout = setTimeout(finish, 2000);
      requestRender();
    });
  }

  /**
   * canvasのスナップショットを新規レイヤーとして追加し、1描画後に旧レイヤーを外す。
   * tokenが現行要求でない場合は、再実行・クリア・中断後の古い描画なので反映しない。
   */
  async function replaceOverlay(dataUrl, boundsOuter, token) {
    // add前の検査。キャッシュヒット中の手動中断もここで止める。
    if (!isTokenCurrent(token)) return false;
    const rectangle = Cesium.Rectangle.fromDegrees(
      boundsOuter.west,
      boundsOuter.south,
      boundsOuter.east,
      boundsOuter.north
    );
    const provider = new Cesium.SingleTileImageryProvider({
      url: dataUrl,
      rectangle,
      tileWidth: CANVAS_SIZE,
      tileHeight: CANVAS_SIZE,
    });
    const nextLayer = viewer.imageryLayers.addImageryProvider(provider);
    pendingLayers.add(nextLayer);
    viewer.imageryLayers.raiseToTop(nextLayer);
    await waitForPostRender();

    // postRender後の検査。待機中にclear・診断・レイヤー切替された場合はpendingを除く。
    if (!isTokenCurrent(token)) {
      removePendingLayer(nextLayer);
      return false;
    }
    // 状態確定直前にも検査し、旧要求がoverlayLayerを上書きしないようにする。
    if (!isTokenCurrent(token)) {
      removePendingLayer(nextLayer);
      return false;
    }

    const previous = overlayLayer;
    overlayLayer = nextLayer;
    pendingLayers.delete(nextLayer);
    if (previous && previous !== nextLayer && viewer.imageryLayers.contains(previous)) {
      viewer.imageryLayers.remove(previous, true);
    }
    viewer.imageryLayers.raiseToTop(nextLayer);
    state.layerPresent = true;
    lastOverlayAt = performance.now();
    requestRender();
    return true;
  }

  function queueOverlay(result, token, force = false) {
    if (!isTokenCurrent(token)) return overlayQueue;
    const queuedAt = performance.now();
    const previousReplacementAt = Math.max(lastOverlayAt, lastOverlayQueuedAt);
    if (!force && queuedAt - previousReplacementAt < FINE_REPLACE_INTERVAL_MS) {
      return overlayQueue;
    }
    const dataUrl = canvas.toDataURL('image/png');
    lastQueuedOverlay = `${token.id}:${result.computedCount}`;
    lastOverlayQueuedAt = queuedAt;
    overlayQueue = overlayQueue
      .catch(() => false)
      .then(() => replaceOverlay(dataUrl, result.grid.boundsOuter, token))
      .catch((error) => {
        console.error('日影マップのオーバーレイ描画に失敗しました', error);
        return false;
      });
    return overlayQueue;
  }

  function removeOverlay() {
    let changed = false;
    if (overlayLayer && viewer.imageryLayers.contains(overlayLayer)) {
      viewer.imageryLayers.remove(overlayLayer, true);
      changed = true;
    }
    overlayLayer = null;
    for (const layer of pendingLayers) {
      if (viewer.imageryLayers.contains(layer)) {
        viewer.imageryLayers.remove(layer, true);
        changed = true;
      }
    }
    pendingLayers.clear();
    state.layerPresent = false;
    lastOverlayAt = 0;
    lastOverlayQueuedAt = 0;
    lastQueuedOverlay = null;
    if (changed) requestRender();
  }

  function pickMapCenter() {
    const scene = viewer.scene;
    const point = new Cesium.Cartesian2(
      scene.canvas.clientWidth / 2,
      scene.canvas.clientHeight / 2
    );
    const position = viewer.camera.pickEllipsoid(point, scene.globe.ellipsoid);
    if (!Cesium.defined(position)) return null;
    const cartographic = Cesium.Cartographic.fromCartesian(position);
    return {
      lon: Cesium.Math.toDegrees(cartographic.longitude),
      lat: Cesium.Math.toDegrees(cartographic.latitude),
    };
  }

  function abortInternal(reason = 'manual') {
    if (!activeToken || activeToken.cancelled) return false;
    activeToken.cancelled = true;
    activeToken.reason = reason;
    return true;
  }

  function cancelledBeforeStart(reason) {
    return {
      cells: new Float32Array(),
      grid: null,
      completed: false,
      error: null,
      computedCount: 0,
      raysCompleted: 0,
      totalRays: 0,
      cacheHit: false,
      cancelReason: reason,
    };
  }

  function finishInterrupted(token, sourceResult, options = {}) {
    const forceZero = options.forceZero === true;
    const computedCount = forceZero
      ? 0
      : Number.isInteger(sourceResult.computedCount) ? sourceResult.computedCount : 0;
    const raysCompleted = forceZero ? 0 : Number(sourceResult.raysCompleted) || 0;
    const totalRays = Number(sourceResult.totalRays) || 0;
    const fraction = totalRays > 0 ? raysCompleted / totalRays : 0;
    const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    const result = {
      ...sourceResult,
      completed: false,
      computedCount,
      raysCompleted,
      cacheHit: options.cacheHit === true,
      cancelReason: token.reason || sourceResult.cancelReason || '中断',
    };

    if (token.id !== generation) {
      if (activeToken === token) activeToken = null;
      return result;
    }
    if (computedCount === 0) {
      removeOverlay();
      clearCanvas();
    }
    state = {
      ...state,
      running: false,
      progress: fraction,
      status: `中断（${percent}%まで計算済み）`,
      cacheHit: false,
      result,
      layerPresent: hasOverlay(),
    };
    if (activeToken === token) activeToken = null;
    updateUi();
    return result;
  }

  async function executeRun(token, options) {
    const runId = token.id;
    if (runId !== generation) {
      if (activeToken === token) activeToken = null;
      return cancelledBeforeStart('再実行');
    }
    if (token.cancelled) {
      const result = cancelledBeforeStart(token.reason);
      return finishInterrupted(token, result, { forceZero: true });
    }

    const building = getBuildingState();
    if (!building.tileset || !building.layerKind || building.tileset.show === false) {
      const result = {
        ...cancelledBeforeStart(null),
        error: '建物モデルを表示してください',
      };
      removeOverlay();
      clearCanvas();
      state = {
        ...state,
        running: false,
        progress: 0,
        status: result.error,
        cacheHit: false,
        result,
        layerKind: null,
      };
      if (activeToken === token) activeToken = null;
      updateUi();
      return result;
    }

    const center = options.center || pickMapCenter();
    if (!center) {
      const result = {
        ...cancelledBeforeStart(null),
        error: '画面中心の位置を取得できませんでした',
      };
      removeOverlay();
      clearCanvas();
      state = {
        ...state,
        running: false,
        progress: 0,
        status: result.error,
        cacheHit: false,
        result,
        layerKind: building.layerKind,
      };
      if (activeToken === token) activeToken = null;
      updateUi();
      return result;
    }

    const sizeM = Number(options.sizeM ?? DEFAULT_SIZE_M);
    const pitchM = Number(options.pitchM ?? DEFAULT_PITCH_M);
    const date = options.date ?? DEFAULT_DATE;
    const year = options.year ?? new Date().getFullYear();
    const keyGrid = buildShadeGrid({
      centerLon: center.lon,
      centerLat: center.lat,
      sizeM,
      pitchM,
    });
    const key = shadeCacheKey({
      date,
      pitchM,
      sizeM,
      centerId: keyGrid.centerId,
      layerKind: building.layerKind,
      year,
    });
    state = {
      ...state,
      running: true,
      progress: 0,
      status: '計算を準備中…',
      cacheHit: false,
      result: null,
      layerKind: building.layerKind,
    };
    updateUi();

    const cached = cache.get(key);
    if (cached) {
      drawAll(cached);
      await queueOverlay(cached, token, true);
      const result = { ...cached, cacheHit: true };
      if (!isTokenCurrent(token)) {
        return finishInterrupted(token, result, {
          forceZero: true,
          cacheHit: true,
        });
      }
      const time = new Date(cached.calculatedAt).toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
      });
      // 状態確定直前にも世代とキャンセルを確認する。
      if (!isTokenCurrent(token)) {
        return finishInterrupted(token, result, {
          forceZero: true,
          cacheHit: true,
        });
      }
      state = {
        ...state,
        running: false,
        progress: 1,
        status: '計算完了',
        cacheHit: true,
        result,
        layerPresent: hasOverlay(),
      };
      cacheNotice.textContent = `キャッシュから表示（${time}）`;
      if (activeToken === token) activeToken = null;
      updateUi();
      return result;
    }

    clearCanvas();
    const engine = createShadeMapEngine({
      viewer,
      tileset: building.tileset,
    });
    let fineDrawnCount = 0;
    let result;
    try {
      result = await engine.run({
        center,
        sizeM,
        pitchM,
        date,
        year,
        frameBudgetMs: options.frameBudgetMs,
        isCancelled: () =>
          token.cancelled || token.id !== generation
          || getBuildingState().tileset !== building.tileset,
        onProgress: (fraction, partial) => {
          if (!isTokenCurrent(token)) return;
          setProgress(fraction);
          if (!partial?.grid || !Number.isInteger(partial.computedCount)) return;
          const finalLevel = partial.grid.levels.at(-1);
          if (!finalLevel) return;
          const finalLevelStart = finalLevel.cumulativeCount - finalLevel.count;
          if (
            partial.computedCount < finalLevelStart
            || partial.computedCount <= fineDrawnCount
          ) {
            return;
          }
          const completedFineCells = partial.grid.cells.filter(
            (cell) =>
              cell.index >= fineDrawnCount
              && cell.index < partial.computedCount
          );
          drawCells(partial, completedFineCells, finalLevel.pitchM);
          fineDrawnCount = partial.computedCount;
          state.result = partial;
          queueOverlay(partial, token);
        },
        onLevelComplete: (level, partial) => {
          if (!isTokenCurrent(token)) return;
          const currentLevel = partial.grid.levels.find((item) => item.level === level);
          if (!currentLevel) return;
          const completedCells = partial.grid.cells.filter(
            (cell) => cell.index < partial.computedCount
          );
          drawCells(partial, completedCells, currentLevel.pitchM);
          if (level === partial.grid.pitchM) {
            fineDrawnCount = partial.computedCount;
          }
          state.result = partial;
          // 最終ピッチは完了直後の最終描画で必ず反映するため、ここでは2秒制限を適用する。
          queueOverlay(partial, token, level !== partial.grid.pitchM);
        },
      });
    } catch (error) {
      console.error('日影マップの計算に失敗しました', error);
      result = {
        ...cancelledBeforeStart(null),
        error: '日影マップを計算できませんでした',
      };
    }

    const cancelReason = token.reason || (token.id !== generation ? '再実行' : null);
    const finalResult = {
      ...result,
      layerKind: building.layerKind,
      cacheKey: key,
      cacheHit: false,
      cancelReason,
    };

    if (isTokenCurrent(token) && result.grid && result.computedCount > 0) {
      drawAll({
        ...result,
        grid: result.grid,
        cells: result.cells,
      });
      const finalOverlay = `${runId}:${result.computedCount}`;
      if (lastQueuedOverlay === finalOverlay) {
        await overlayQueue.catch(() => {});
      } else {
        await queueOverlay(result, token, true);
      }
    } else {
      if (token.id === generation && result.computedCount === 0) {
        removeOverlay();
        clearCanvas();
      }
      await overlayQueue.catch(() => {});
    }

    // 再実行・建物レイヤー切替・クリア後の旧世代、または描画待ち中に
    // 中断された現行世代は完了状態へ進めない。
    if (!isTokenCurrent(token)) {
      return finishInterrupted(token, finalResult);
    }

    if (result.completed) {
      const calculatedAt = Date.now();
      cache.set(key, { ...finalResult, calculatedAt });
      state = {
        ...state,
        running: false,
        progress: 1,
        status: '計算完了',
        cacheHit: false,
        result: finalResult,
        layerPresent: hasOverlay(),
      };
    } else {
      const fraction = result.totalRays > 0
        ? result.raysCompleted / result.totalRays
        : state.progress;
      const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      state = {
        ...state,
        running: false,
        progress: fraction,
        status: result.error || `中断（${percent}%まで計算済み）`,
        cacheHit: false,
        result: finalResult,
        layerPresent: hasOverlay(),
      };
    }
    if (activeToken === token) activeToken = null;
    updateUi();
    return finalResult;
  }

  /**
   * 呼び出しごとに世代を進め、実行中の計算を中断してから直列キューへ積む。
   * エンジンrun()が重なることはない。
   */
  function run(options = {}) {
    if (typeof cancelDiagnosisSunlight === 'function') {
      try {
        cancelDiagnosisSunlight();
      } catch (error) {
        console.warn('診断日照計算の中断に失敗しました', error);
      }
    }
    abortInternal('再実行');
    const token = { id: ++generation, cancelled: false, reason: null };
    activeToken = token;
    const task = runQueue
      .catch(() => {})
      .then(() => executeRun(token, options));
    runQueue = task;
    return task;
  }

  function abort() {
    return abortInternal('手動中断');
  }

  function clear() {
    abortInternal('クリア');
    generation++;
    removeOverlay();
    clearCanvas();
    state = {
      running: false,
      progress: 0,
      status: '未計算',
      cacheHit: false,
      result: null,
      layerPresent: false,
      layerKind: getBuildingState().layerKind,
    };
    updateUi();
  }

  function abortForDiagnosis() {
    abortInternal('診断開始');
  }

  function onBuildingLayerChange() {
    abortInternal('建物レイヤー切替');
    generation++;
    removeOverlay();
    clearCanvas();
    state = {
      running: false,
      progress: 0,
      status: '未計算',
      cacheHit: false,
      result: null,
      layerPresent: false,
      layerKind: null,
    };
    updateUi();
  }

  function ensureTop() {
    if (overlayLayer && viewer.imageryLayers.contains(overlayLayer)) {
      viewer.imageryLayers.raiseToTop(overlayLayer);
      requestRender();
    }
  }

  function getState() {
    return {
      ...state,
      cacheSize: cache.size,
      layerPresent: hasOverlay(),
    };
  }

  /** e2eで描画色とhoursToColorの対応を検証するためのcanvasスナップショット。 */
  function getCanvasState() {
    const result = state.result;
    if (!result?.grid) {
      return {
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
        legendHex: SHADE_LEGEND.map((item) => item.hex),
        transparentPixels: CANVAS_SIZE * CANVAS_SIZE,
        samples: [],
      };
    }
    const count = Math.round(result.grid.sizeM / result.grid.pitchM) + 1;
    const boundaries = canvasBoundaries(count);
    const computedCount = Number.isInteger(result.computedCount)
      ? result.computedCount
      : result.grid.cells.length;
    const samples = result.grid.cells
      .filter((cell) => cell.index < computedCount)
      .map((cell) => {
        const x = Math.floor((boundaries[cell.column] + boundaries[cell.column + 1]) / 2);
        const canvasRow = count - 1 - cell.row;
        const y = Math.floor((boundaries[canvasRow] + boundaries[canvasRow + 1]) / 2);
        const pixel = [...context.getImageData(x, y, 1, 1).data];
        const actualHex = '#' + pixel.slice(0, 3)
          .map((channel) => channel.toString(16).padStart(2, '0'))
          .join('');
        return {
          index: cell.index,
          hours: result.cells[cell.index],
          expectedHex: hoursToColor(result.cells[cell.index], maximumHours(result)),
          actualHex,
          alpha: pixel[3],
        };
      });
    const image = context.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
    let transparentPixels = 0;
    for (let index = 3; index < image.length; index += 4) {
      if (image[index] === 0) transparentPixels++;
    }
    return {
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      legendHex: SHADE_LEGEND.map((item) => item.hex),
      transparentPixels,
      samples,
    };
  }

  runButton.addEventListener('click', () => {
    run({
      date: dateSelect.value,
      pitchM: Number(pitchSelect.value),
    }).catch((error) => console.error('日影マップの実行に失敗しました', error));
  });
  abortButton.addEventListener('click', abort);
  clearButton.addEventListener('click', clear);

  return {
    run,
    clear,
    abort,
    getState,
    getCanvasState,
    abortForDiagnosis,
    onBuildingLayerChange,
    ensureTop,
  };
}
