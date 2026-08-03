// モバイル幅の診断カードを3段階で開閉するボトムシート制御。

import { isShadeMapRunning, onShadeMapRunningChange } from './shademap-ui.js';

const MOBILE_QUERY = '(max-width: 767px)';
const STATE_ORDER = ['full', 'half', 'peek'];
const PEEK_HEIGHT = 140;
const FULL_RATIO = 0.88;
const HALF_RATIO = 0.5;
// 300px/s程度を「軽いフリック」、900px/s以上を「強いフリック」とする。
// 一般的な60Hz端末でそれぞれ約5px/frame・15px/frameに相当する。
const VELOCITY_THRESHOLD = 0.3;
const STRONG_VELOCITY_THRESHOLD = 0.9;
const CLOSE_DRAG_DISTANCE = 24;
const MAX_CLOSE_OVERSHOOT = 96;
const MAP_POINT_CLEARANCE = 8;
// 補正要否のサブピクセル許容。厳密な <=0 判定だと浮動小数点誤差（deltaY≒2.7e-6等）で
// マイクロ補正が無限に繰り返され pending が固着する（RC1.5実測）。
const MAP_SYNC_EPSILON_PX = 1;
const INTERNAL_CAMERA_MOVE_TIMEOUT_MS = 2000;
const COMPARE_BAR_OFFSET_PROPERTY = '--compare-bar-offset';
const VIEWPORT_WIDTH_PROPERTY = '--mobile-viewport-width';
const VIEWPORT_LEFT_PROPERTY = '--mobile-viewport-left';
const VIEWPORT_RIGHT_PROPERTY = '--mobile-viewport-right';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 診断カードをモバイル用ボトムシートとして初期化する。 */
export function initBottomSheet({ diagnosis, viewer = null, requestRender = () => {} }) {
  const panel = document.getElementById('diagnosisPanel');
  const handle = panel?.querySelector('.sheet-handle');
  const compareBar = document.getElementById('compareBar');
  const mobileQuery = globalThis.matchMedia?.(MOBILE_QUERY);
  if (!panel || !handle || !mobileQuery) return null;

  let state = 'half';
  let pointerId = null;
  let startY = 0;
  let startOffset = 0;
  let currentOffset = 0;
  let lastY = 0;
  let lastTime = 0;
  let velocity = 0;
  let moved = false;
  let wasOpen = document.body.classList.contains('sheet-open');
  let compareBarMeasureFrame = null;
  let mapSyncFrame = null;
  let mapSyncTimer = null;
  let mapSyncPending = false;
  let cameraMoving = false;
  let internalCameraMove = false;
  let internalCameraMoveTimer = null;
  let internalCameraRenderFrame = null;
  let internalCameraMoveGeneration = 0;
  let userCameraInput = false;
  let userCameraInputTimer = null;
  let mapAdjustmentCount = 0;
  let lastMapAdjustment = null;

  function viewportHeight() {
    return globalThis.visualViewport?.height || globalThis.innerHeight;
  }

  function viewportWidth() {
    return globalThis.visualViewport?.width || globalThis.innerWidth;
  }

  /** ピンチズーム中も固定UIをvisual viewportの左右端へ追従させる。 */
  function syncViewportMetrics() {
    const viewport = globalThis.visualViewport;
    const width = viewportWidth();
    const left = viewport?.offsetLeft || 0;
    const right = Math.max(0, globalThis.innerWidth - left - width);
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty(VIEWPORT_WIDTH_PROPERTY, `${width}px`);
    rootStyle.setProperty(VIEWPORT_LEFT_PROPERTY, `${left}px`);
    rootStyle.setProperty(VIEWPORT_RIGHT_PROPERTY, `${right}px`);
  }

  function measureCompareBarOffset() {
    compareBarMeasureFrame = null;
    let offset = 0;
    if (compareBar && !compareBar.classList.contains('hidden')) {
      const rect = compareBar.getBoundingClientRect();
      const style = globalThis.getComputedStyle(compareBar);
      const marginTop = Number.parseFloat(style.marginTop) || 0;
      // offsetHeightでborderを含む実高さを取り、rect.bottomとの差分から
      // CSSのbottomと下側marginを含む画面下端までの余白も実測する。
      const bottomClearance = Math.max(0, globalThis.innerHeight - rect.bottom);
      const measuredHeight = Math.max(compareBar.offsetHeight, rect.height);
      offset = Math.ceil(bottomClearance + measuredHeight + marginTop);
    }
    document.documentElement.style.setProperty(COMPARE_BAR_OFFSET_PROPERTY, `${offset}px`);
  }

  function scheduleCompareBarMeasurement() {
    if (compareBarMeasureFrame !== null) return;
    compareBarMeasureFrame = requestAnimationFrame(measureCompareBarOffset);
  }

  function offsets() {
    const height = panel.offsetHeight || viewportHeight() * FULL_RATIO;
    return {
      full: 0,
      half: Math.max(0, height - viewportHeight() * HALF_RATIO),
      peek: Math.max(0, height - PEEK_HEIGHT),
    };
  }

  function applyOffset(offset) {
    currentOffset = offset;
    panel.style.setProperty('--sheet-translate-y', `${offset}px`);
  }

  function sheetDurationMs() {
    const raw = globalThis.getComputedStyle(document.documentElement)
      .getPropertyValue('--duration-sheet')
      .trim();
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) return 0;
    return raw.endsWith('ms') ? value : value * 1000;
  }

  function clearMapSyncSchedule() {
    if (mapSyncTimer !== null) {
      clearTimeout(mapSyncTimer);
      mapSyncTimer = null;
    }
    if (mapSyncFrame !== null) {
      cancelAnimationFrame(mapSyncFrame);
      mapSyncFrame = null;
    }
  }

  /** requestRenderModeでもカメラ補間の次フレームを明示的に駆動する。 */
  function requestMapRender() {
    if (mobileQuery.matches) viewer?.scene?.requestRender?.();
    requestRender();
  }

  /** 待機中の連動を破棄し、後続のmoveEndから再発火しないようにする。 */
  function discardMapSync() {
    mapSyncPending = false;
    clearMapSyncSchedule();
  }

  /** pendingを保持する場合は、必ず次のapplyMapSync実行源も同時に確保する。 */
  function scheduleMapSyncAttempt(delayMs = 0) {
    if (!mapSyncPending || mapSyncTimer !== null || mapSyncFrame !== null) return;
    if (delayMs > 0) {
      mapSyncTimer = setTimeout(() => {
        mapSyncTimer = null;
        if (!mapSyncPending) return;
        mapSyncFrame = requestAnimationFrame(applyMapSync);
      }, delayMs);
      return;
    }
    mapSyncFrame = requestAnimationFrame(applyMapSync);
  }

  function stopInternalCameraRenderPump() {
    if (internalCameraRenderFrame === null) return;
    cancelAnimationFrame(internalCameraRenderFrame);
    internalCameraRenderFrame = null;
  }

  /** mapSyncのカメラ移動を完了し、必要なら最終位置を再計測する。 */
  function finishInternalCameraMove(generation, retryPending = true) {
    if (!internalCameraMove || generation !== internalCameraMoveGeneration) return;
    internalCameraMove = false;
    cameraMoving = false;
    if (internalCameraMoveTimer !== null) {
      clearTimeout(internalCameraMoveTimer);
      internalCameraMoveTimer = null;
    }
    stopInternalCameraRenderPump();
    requestMapRender();
    if (retryPending && mapSyncPending) scheduleMapSyncAttempt();
  }

  function pumpInternalCameraRender(generation) {
    internalCameraRenderFrame = null;
    if (!internalCameraMove || generation !== internalCameraMoveGeneration) return;
    requestMapRender();
    internalCameraRenderFrame = requestAnimationFrame(
      () => pumpInternalCameraRender(generation),
    );
  }

  /** moveEndやflyToコールバックが欠落しても、2秒後には必ず移動状態を解除する。 */
  function beginInternalCameraMove() {
    const generation = ++internalCameraMoveGeneration;
    internalCameraMove = true;
    internalCameraMoveTimer = setTimeout(() => {
      if (!internalCameraMove || generation !== internalCameraMoveGeneration) return;
      finishInternalCameraMove(generation);
      viewer?.camera?.cancelFlight?.();
    }, INTERNAL_CAMERA_MOVE_TIMEOUT_MS);
    internalCameraRenderFrame = requestAnimationFrame(
      () => pumpInternalCameraRender(generation),
    );
    return generation;
  }

  function cancelInternalCameraMove() {
    if (!internalCameraMove) return;
    const generation = internalCameraMoveGeneration;
    finishInternalCameraMove(generation, false);
    viewer?.camera?.cancelFlight?.();
  }

  /** 診断地点とシート上端を、同じ画面座標系で計測する。 */
  function measureMapSync() {
    const result = diagnosis.getLastResult?.();
    if (!viewer || !result || !Number.isFinite(result.lon) || !Number.isFinite(result.lat)) {
      return null;
    }
    const scene = viewer.scene;
    const canvasRect = scene.canvas.getBoundingClientRect();
    const world = Cesium.Cartesian3.fromDegrees(result.lon, result.lat, 0);
    const windowPoint = Cesium.SceneTransforms.worldToWindowCoordinates(scene, world);
    if (!Cesium.defined(windowPoint)) return null;
    const sheetRect = panel.getBoundingClientRect();
    return {
      world,
      canvasRect,
      windowPoint,
      pointX: canvasRect.left + windowPoint.x,
      pointY: canvasRect.top + windowPoint.y,
      sheetTop: sheetRect.top,
    };
  }

  /**
   * カメラの向きと距離を保ったまま平行移動し、診断地点をシート上端より上へ逃がす。
   * ユーザー操作や診断flyToの途中では実行せず、描画フレームとmoveEndで再試行する。
   */
  function applyMapSync() {
    mapSyncFrame = null;
    if (!mapSyncPending) return;
    if (isShadeMapRunning()) {
      discardMapSync();
      return;
    }
    if (!mobileQuery.matches
      || !document.body.classList.contains('sheet-open')
      || !['half', 'full'].includes(state)) {
      discardMapSync();
      return;
    }
    if (cameraMoving || internalCameraMove) {
      requestMapRender();
      scheduleMapSyncAttempt();
      return;
    }

    const measured = measureMapSync();
    if (!measured) {
      discardMapSync();
      return;
    }
    const targetY = measured.sheetTop - MAP_POINT_CLEARANCE;
    const deltaY = measured.pointY - targetY;
    if (deltaY <= MAP_SYNC_EPSILON_PX) {
      discardMapSync();
      if (mapAdjustmentCount === 0) {
        lastMapAdjustment = { deltaY: 0, durationMs: 0 };
      }
      return;
    }

    const camera = viewer.camera;
    const desiredCanvasY = targetY - measured.canvasRect.top;
    const ray = camera.getPickRay(new Cesium.Cartesian2(
      measured.windowPoint.x,
      desiredCanvasY,
    ));
    const plane = Cesium.Plane.fromPointNormal(measured.world, camera.directionWC);
    const desiredWorld = ray && Cesium.IntersectionTests.rayPlane(ray, plane);
    if (!Cesium.defined(desiredWorld)) {
      discardMapSync();
      return;
    }

    const translation = Cesium.Cartesian3.subtract(
      measured.world,
      desiredWorld,
      new Cesium.Cartesian3(),
    );
    const destination = Cesium.Cartesian3.add(
      camera.positionWC,
      translation,
      new Cesium.Cartesian3(),
    );
    const direction = Cesium.Cartesian3.clone(camera.directionWC);
    const up = Cesium.Cartesian3.clone(camera.upWC);
    const durationMs = sheetDurationMs();
    mapAdjustmentCount++;
    lastMapAdjustment = { deltaY, durationMs };

    if (durationMs === 0) {
      discardMapSync();
      camera.setView({ destination, orientation: { direction, up } });
      requestMapRender();
      return;
    }

    const generation = beginInternalCameraMove();
    camera.flyTo({
      destination,
      orientation: { direction, up },
      duration: durationMs / 1000,
      complete: () => finishInternalCameraMove(generation),
      cancel: () => finishInternalCameraMove(generation),
    });
    requestMapRender();
  }

  function queueMapSync(afterSheetTransition = false) {
    if (!viewer || !mobileQuery.matches || !['half', 'full'].includes(state)) {
      discardMapSync();
      return;
    }
    if (isShadeMapRunning()) {
      discardMapSync();
      return;
    }
    mapSyncPending = true;
    clearMapSyncSchedule();
    const delay = afterSheetTransition ? sheetDurationMs() : 0;
    scheduleMapSyncAttempt(delay);
    requestMapRender();
  }

  function setState(nextState, options = {}) {
    if (!STATE_ORDER.includes(nextState)) return false;
    state = nextState;
    panel.dataset.sheetState = nextState;
    if (mobileQuery.matches) applyOffset(offsets()[nextState]);
    if (nextState === 'peek') {
      discardMapSync();
    } else if (options.syncMap !== false) {
      queueMapSync(true);
    }
    requestRender();
    return true;
  }

  function nearestState(offset) {
    const stateOffsets = offsets();
    return STATE_ORDER.reduce((nearest, candidate) => (
      Math.abs(stateOffsets[candidate] - offset) < Math.abs(stateOffsets[nearest] - offset)
        ? candidate
        : nearest
    ), STATE_ORDER[0]);
  }

  function snapAfterDrag() {
    const nearest = nearestState(currentOffset);
    if (Math.abs(velocity) < VELOCITY_THRESHOLD) {
      setState(nearest);
      return;
    }
    const index = STATE_ORDER.indexOf(state);
    const steps = Math.abs(velocity) >= STRONG_VELOCITY_THRESHOLD ? 2 : 1;
    const nextIndex = velocity > 0
      ? Math.min(STATE_ORDER.length - 1, index + steps)
      : Math.max(0, index - steps);
    setState(STATE_ORDER[nextIndex]);
  }

  function endDrag(event, cancelled = false) {
    if (event.pointerId !== pointerId) return;
    if (event.timeStamp - lastTime > 80) velocity = 0;
    try {
      handle.releasePointerCapture(pointerId);
    } catch (_) { /* ポインターキャプチャ済みでない場合は何もしない */ }
    pointerId = null;
    panel.classList.remove('sheet-dragging');

    const peekOffset = offsets().peek;
    if (!cancelled && currentOffset > peekOffset + CLOSE_DRAG_DISTANCE) {
      diagnosis.close();
      return;
    }
    snapAfterDrag();
  }

  handle.addEventListener('pointerdown', (event) => {
    if (!mobileQuery.matches || pointerId !== null) return;
    pointerId = event.pointerId;
    startY = event.clientY;
    startOffset = offsets()[state];
    currentOffset = startOffset;
    lastY = event.clientY;
    lastTime = event.timeStamp;
    velocity = 0;
    moved = false;
    panel.classList.add('sheet-dragging');
    handle.setPointerCapture?.(pointerId);
    event.preventDefault();
  });

  handle.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    const now = event.timeStamp;
    const elapsed = Math.max(1, now - lastTime);
    velocity = (event.clientY - lastY) / elapsed;
    lastY = event.clientY;
    lastTime = now;
    const delta = event.clientY - startY;
    moved ||= Math.abs(delta) > 4;
    const peekOffset = offsets().peek;
    applyOffset(clamp(startOffset + delta, 0, peekOffset + MAX_CLOSE_OVERSHOOT));
    event.preventDefault();
  });

  handle.addEventListener('pointerup', (event) => endDrag(event));
  handle.addEventListener('pointercancel', (event) => endDrag(event, true));

  handle.addEventListener('click', () => {
    if (!mobileQuery.matches || moved) {
      moved = false;
      return;
    }
    setState(state === 'peek' ? 'half' : state === 'half' ? 'full' : 'half');
  });

  handle.addEventListener('keydown', (event) => {
    if (!mobileQuery.matches) return;
    const index = STATE_ORDER.indexOf(state);
    if (event.key === 'ArrowUp') {
      setState(STATE_ORDER[Math.max(0, index - 1)]);
    } else if (event.key === 'ArrowDown') {
      setState(STATE_ORDER[Math.min(STATE_ORDER.length - 1, index + 1)]);
    } else if (event.key === 'Home') {
      setState('full');
    } else if (event.key === 'End') {
      setState('peek');
    } else {
      return;
    }
    event.preventDefault();
  });

  function syncOpenState() {
    const open = document.body.classList.contains('sheet-open');
    if (open && !wasOpen) {
      requestAnimationFrame(() => setState('half', {
        syncMap: diagnosis.getLastResult?.()?.fly !== false,
      }));
    } else if (!open && wasOpen) {
      discardMapSync();
    }
    wasOpen = open;
  }

  const observer = new MutationObserver(syncOpenState);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  if (compareBar) {
    const compareBarObserver = new MutationObserver(scheduleCompareBarMeasurement);
    compareBarObserver.observe(compareBar, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      characterData: true,
      subtree: true,
    });
    if (typeof ResizeObserver === 'function') {
      const compareBarResizeObserver = new ResizeObserver(scheduleCompareBarMeasurement);
      compareBarResizeObserver.observe(compareBar);
    }
  }
  const syncSize = () => {
    syncViewportMetrics();
    scheduleCompareBarMeasurement();
    if (mobileQuery.matches && document.body.classList.contains('sheet-open')) {
      applyOffset(offsets()[state]);
      requestRender();
    }
  };
  mobileQuery.addEventListener?.('change', syncSize);
  globalThis.visualViewport?.addEventListener('resize', syncSize);
  globalThis.visualViewport?.addEventListener('scroll', syncViewportMetrics);
  globalThis.addEventListener('resize', syncSize);

  if (viewer?.camera) {
    onShadeMapRunningChange((running) => {
      if (!running) return;
      discardMapSync();
      cancelInternalCameraMove();
    });
    const canvas = viewer.scene?.canvas;
    const releaseUserCameraInput = () => {
      if (userCameraInputTimer !== null) clearTimeout(userCameraInputTimer);
      userCameraInputTimer = setTimeout(() => {
        userCameraInput = false;
        userCameraInputTimer = null;
      }, 250);
    };
    const markUserCameraInput = () => {
      userCameraInput = true;
      discardMapSync();
      cancelInternalCameraMove();
    };
    canvas?.addEventListener('pointerdown', markUserCameraInput, { capture: true });
    canvas?.addEventListener('mousedown', markUserCameraInput, { capture: true });
    canvas?.addEventListener('touchstart', markUserCameraInput, { capture: true, passive: true });
    canvas?.addEventListener('wheel', () => {
      markUserCameraInput();
      releaseUserCameraInput();
    }, { capture: true, passive: true });
    globalThis.addEventListener('pointerup', releaseUserCameraInput, { capture: true });
    globalThis.addEventListener('mouseup', releaseUserCameraInput, { capture: true });
    globalThis.addEventListener('touchend', releaseUserCameraInput, { capture: true, passive: true });
    viewer.camera.moveStart.addEventListener(() => {
      cameraMoving = true;
      if (!internalCameraMove) discardMapSync();
    });
    viewer.camera.changed.addEventListener(() => {
      if (userCameraInput) discardMapSync();
    });
    viewer.camera.moveEnd.addEventListener(() => {
      cameraMoving = false;
      requestMapRender();
      releaseUserCameraInput();
      if (mapSyncPending && !internalCameraMove && !userCameraInput) {
        scheduleMapSyncAttempt();
      }
    });
    diagnosis.onCameraFlightEnd?.(({ completed, lon, lat }) => {
      cameraMoving = false;
      if (mobileQuery.matches) requestMapRender();
      if (!completed || isShadeMapRunning()) return;
      const result = diagnosis.getLastResult?.();
      if (result?.fly !== true || result.lon !== lon || result.lat !== lat) return;
      // CesiumのmoveEndを同一ターンで処理し終えた後に、診断flyTo完了起点で連動する。
      setTimeout(() => queueMapSync(), 0);
    });
  }

  panel.dataset.sheetState = state;
  syncViewportMetrics();
  measureCompareBarOffset();
  return {
    setState,
    getState: () => state,
    isMobile: () => mobileQuery.matches,
    /** e2e用: canvasを操作せず診断地点とシートの画面座標を検証する。 */
    getMapSyncTestState: () => {
      const measured = measureMapSync();
      return {
        pointX: measured?.pointX ?? null,
        pointY: measured?.pointY ?? null,
        sheetTop: measured?.sheetTop ?? null,
        pending: mapSyncPending,
        cameraMoving,
        adjustmentCount: mapAdjustmentCount,
        lastAdjustment: lastMapAdjustment,
      };
    },
  };
}
