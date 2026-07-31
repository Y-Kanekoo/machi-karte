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
 *          getBuildingState:()=>({tileset:object|null,layerKind:string|null})}} deps
 */
export function initShadeMap(deps) {
  const { viewer, getBuildingState } = deps;
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

  function maximumHours(result) {
    return result.slotCount > 0 ? result.slotCount / 3 : 10;
  }

  /**
   * 指定セルをブロック塗りする。boundsOuterが全セルの外周と一致するため、
   * (column,row)を等分割するだけで半セルずれなく矩形へ対応する。
   */
  function drawCells(result, cells) {
    const count = Math.round(result.grid.sizeM / result.grid.pitchM) + 1;
    const maxHours = maximumHours(result);
    context.save();
    context.globalAlpha = OVERLAY_ALPHA;
    for (const cell of cells) {
      const x0 = Math.floor(cell.column * CANVAS_SIZE / count);
      const x1 = Math.ceil((cell.column + 1) * CANVAS_SIZE / count);
      const canvasRow = count - 1 - cell.row;
      const y0 = Math.floor(canvasRow * CANVAS_SIZE / count);
      const y1 = Math.ceil((canvasRow + 1) * CANVAS_SIZE / count);
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
      viewer.scene.requestRender();
    });
  }

  /**
   * canvasのスナップショットを新規レイヤーとして追加し、1描画後に旧レイヤーを外す。
   * queuedIdが現行世代でない場合は、再実行・クリア後の古い描画なので反映しない。
   */
  async function replaceOverlay(dataUrl, boundsOuter, queuedId) {
    if (queuedId !== generation) return;
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

    if (queuedId !== generation) {
      pendingLayers.delete(nextLayer);
      viewer.imageryLayers.remove(nextLayer, true);
      return;
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
  }

  function queueOverlay(result, queuedId, force = false) {
    if (queuedId !== generation) return overlayQueue;
    if (!force && performance.now() - lastOverlayAt < FINE_REPLACE_INTERVAL_MS) {
      return overlayQueue;
    }
    const dataUrl = canvas.toDataURL('image/png');
    lastQueuedOverlay = `${queuedId}:${result.computedCount}`;
    overlayQueue = overlayQueue
      .catch(() => {})
      .then(() => replaceOverlay(dataUrl, result.grid.boundsOuter, queuedId))
      .catch((error) => {
        console.error('日影マップのオーバーレイ描画に失敗しました', error);
      });
    return overlayQueue;
  }

  function removeOverlay() {
    if (overlayLayer && viewer.imageryLayers.contains(overlayLayer)) {
      viewer.imageryLayers.remove(overlayLayer, true);
    }
    overlayLayer = null;
    for (const layer of pendingLayers) {
      if (viewer.imageryLayers.contains(layer)) viewer.imageryLayers.remove(layer, true);
    }
    pendingLayers.clear();
    state.layerPresent = false;
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

  async function executeRun(token, options) {
    const runId = token.id;
    if (runId !== generation) {
      if (activeToken === token) activeToken = null;
      return cancelledBeforeStart('再実行');
    }
    if (token.cancelled) {
      const result = cancelledBeforeStart(token.reason);
      state = {
        ...state,
        running: false,
        progress: 0,
        status: '中断（0%まで計算済み）',
        cacheHit: false,
        result,
      };
      if (activeToken === token) activeToken = null;
      updateUi();
      return result;
    }

    const building = getBuildingState();
    if (!building.tileset || !building.layerKind || building.tileset.show === false) {
      const result = {
        ...cancelledBeforeStart(null),
        error: '建物モデルを表示してください',
      };
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
      await queueOverlay(cached, runId, true);
      const time = new Date(cached.calculatedAt).toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const result = { ...cached, cacheHit: true };
      if (token.id !== generation) {
        if (activeToken === token) activeToken = null;
        return result;
      }
      state = {
        ...state,
        running: false,
        progress: 1,
        status: '計算完了',
        cacheHit: true,
        result,
        layerPresent: !!overlayLayer,
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
        onProgress: (fraction) => {
          if (token.id === generation) setProgress(fraction);
        },
        onLevelComplete: (level, partial) => {
          if (token.id !== generation) return;
          const currentLevel = partial.grid.levels.find((item) => item.level === level);
          if (!currentLevel) return;
          const completedCells = currentLevel.newCells.filter(
            (cell) => cell.index < partial.computedCount
          );
          drawCells(partial, completedCells);
          state.result = partial;
          // 最終ピッチは完了直後の最終描画で必ず反映するため、ここでは2秒制限を適用する。
          queueOverlay(partial, runId, level !== partial.grid.pitchM);
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

    if (token.id === generation && result.grid && result.computedCount > 0) {
      drawAll({
        ...result,
        grid: result.grid,
        cells: result.cells,
      });
      const finalOverlay = `${runId}:${result.computedCount}`;
      if (lastQueuedOverlay === finalOverlay) {
        await overlayQueue.catch(() => {});
      } else {
        await queueOverlay(result, runId, true);
      }
    } else {
      await overlayQueue.catch(() => {});
    }

    // 再実行・建物レイヤー切替・クリア後に完了した旧世代はUIへ反映しない。
    if (token.id !== generation) {
      if (activeToken === token) activeToken = null;
      return finalResult;
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
        layerPresent: !!overlayLayer,
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
        layerPresent: !!overlayLayer,
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
    }
  }

  function getState() {
    return {
      ...state,
      cacheSize: cache.size,
      layerPresent: !!overlayLayer && viewer.imageryLayers.contains(overlayLayer),
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
    abortForDiagnosis,
    onBuildingLayerChange,
    ensureTop,
  };
}
