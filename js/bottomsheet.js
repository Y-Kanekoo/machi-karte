// モバイル幅の診断カードを3段階で開閉するボトムシート制御。

const MOBILE_QUERY = '(max-width: 767px)';
const STATE_ORDER = ['full', 'half', 'peek'];
const PEEK_HEIGHT = 140;
const FULL_RATIO = 0.88;
const HALF_RATIO = 0.5;
const VELOCITY_THRESHOLD = 0.45;
const CLOSE_DRAG_DISTANCE = 24;
const MAX_CLOSE_OVERSHOOT = 96;
const COMPARE_BAR_OFFSET_PROPERTY = '--compare-bar-offset';
const VIEWPORT_WIDTH_PROPERTY = '--mobile-viewport-width';
const VIEWPORT_LEFT_PROPERTY = '--mobile-viewport-left';
const VIEWPORT_RIGHT_PROPERTY = '--mobile-viewport-right';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 診断カードをモバイル用ボトムシートとして初期化する。 */
export function initBottomSheet({ diagnosis, requestRender = () => {} }) {
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

  function setState(nextState) {
    if (!STATE_ORDER.includes(nextState)) return false;
    state = nextState;
    panel.dataset.sheetState = nextState;
    if (mobileQuery.matches) applyOffset(offsets()[nextState]);
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
    const index = STATE_ORDER.indexOf(nearest);
    const nextIndex = velocity > 0
      ? Math.min(STATE_ORDER.length - 1, index + 1)
      : Math.max(0, index - 1);
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
    if (open && !wasOpen) requestAnimationFrame(() => setState('half'));
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
    if (mobileQuery.matches && document.body.classList.contains('sheet-open')) setState(state);
  };
  mobileQuery.addEventListener?.('change', syncSize);
  globalThis.visualViewport?.addEventListener('resize', syncSize);
  globalThis.visualViewport?.addEventListener('scroll', syncViewportMetrics);
  globalThis.addEventListener('resize', syncSize);

  panel.dataset.sheetState = state;
  syncViewportMetrics();
  measureCompareBarOffset();
  return {
    setState,
    getState: () => state,
    isMobile: () => mobileQuery.matches,
  };
}
