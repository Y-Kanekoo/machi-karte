// requestRenderMode相当のスタブで、mapSyncの待機再開と補間描画を検証する。

import assert from 'node:assert/strict';
import { initBottomSheet } from '../js/bottomsheet.js';

class EventSignal {
  handlers = [];

  addEventListener(handler) {
    this.handlers.push(handler);
  }

  raise(...args) {
    for (const handler of this.handlers) handler(...args);
  }
}

class ClassList {
  values = new Set();

  constructor(...values) {
    this.values = new Set(values);
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }

  toggle(value, force) {
    if (force === undefined ? !this.values.has(value) : force) this.values.add(value);
    else this.values.delete(value);
  }
}

function createElement({ rect = {}, classNames = [] } = {}) {
  const listeners = new Map();
  return {
    classList: new ClassList(...classNames),
    dataset: {},
    offsetHeight: rect.height || 0,
    style: { setProperty() {} },
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      ...rect,
    }),
    querySelector: () => null,
    setPointerCapture() {},
    releasePointerCapture() {},
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('ボトムシート地図連動の待機がタイムアウトしました');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const root = createElement();
const body = createElement({ classNames: ['sheet-open'] });
const handle = createElement();
const panel = createElement({ rect: { top: 422, bottom: 844, width: 390, height: 742 } });
panel.querySelector = (selector) => (selector === '.sheet-handle' ? handle : null);
const canvas = createElement({ rect: { left: 0, top: 0, width: 390, height: 844 } });

globalThis.innerWidth = 390;
globalThis.innerHeight = 844;
globalThis.addEventListener = () => {};
globalThis.matchMedia = () => ({ matches: true, addEventListener() {} });
globalThis.getComputedStyle = (element) => ({
  getPropertyValue: (property) => (
    element === root && property === '--duration-sheet' ? '12ms' : ''
  ),
  marginTop: '0px',
});
globalThis.document = {
  body,
  documentElement: root,
  getElementById: (id) => (id === 'diagnosisPanel' ? panel : null),
};
globalThis.MutationObserver = class {
  observe() {}
};

let nextAnimationFrameId = 1;
const animationFrames = new Map();
globalThis.requestAnimationFrame = (callback) => {
  const id = nextAnimationFrameId++;
  const timer = setTimeout(() => {
    animationFrames.delete(id);
    callback(Date.now());
  }, 1);
  animationFrames.set(id, timer);
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  const timer = animationFrames.get(id);
  if (timer !== undefined) clearTimeout(timer);
  animationFrames.delete(id);
};

class Cartesian2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
}

class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static fromDegrees(lon, lat, height) {
    return new Cartesian3(lon, lat, height);
  }

  static subtract(left, right, result) {
    result.x = left.x - right.x;
    result.y = left.y - right.y;
    result.z = left.z - right.z;
    return result;
  }

  static add(left, right, result) {
    result.x = left.x + right.x;
    result.y = left.y + right.y;
    result.z = left.z + right.z;
    return result;
  }

  static clone(value) {
    return new Cartesian3(value.x, value.y, value.z);
  }
}

const moveStart = new EventSignal();
const moveEnd = new EventSignal();
const changed = new EventSignal();
let activeFlight = null;
let flightRenderCount = 0;
let sceneRenderCount = 0;

const camera = {
  positionWC: new Cartesian3(),
  directionWC: new Cartesian3(0, 0, -1),
  upWC: new Cartesian3(0, 1, 0),
  moveStart,
  moveEnd,
  changed,
  getPickRay: (point) => ({ point }),
  setView({ destination }) {
    this.positionWC = Cartesian3.clone(destination);
  },
  flyTo(options) {
    activeFlight = options;
    flightRenderCount = 0;
    moveStart.raise();
  },
  cancelFlight() {
    const flight = activeFlight;
    activeFlight = null;
    flight?.cancel?.();
    moveEnd.raise();
  },
};

const scene = {
  canvas,
  requestRender() {
    sceneRenderCount++;
    if (!activeFlight || ++flightRenderCount < 3) return;
    const flight = activeFlight;
    activeFlight = null;
    camera.positionWC = Cartesian3.clone(flight.destination);
    changed.raise();
    moveEnd.raise();
    flight.complete?.();
  },
};

globalThis.Cesium = {
  Cartesian2,
  Cartesian3,
  defined: (value) => value !== null && value !== undefined,
  SceneTransforms: {
    worldToWindowCoordinates: () => new Cartesian2(195, 600 - camera.positionWC.y),
  },
  Plane: {
    fromPointNormal: (point) => ({ point }),
  },
  IntersectionTests: {
    rayPlane: (ray, plane) => {
      const currentPointY = 600 - camera.positionWC.y;
      const translationY = currentPointY - ray.point.y;
      return new Cartesian3(plane.point.x, plane.point.y - translationY, plane.point.z);
    },
  },
};

const result = { lon: 139.6686, lat: 35.7056, fly: true };
let cameraFlightEndHandler = null;
const diagnosis = {
  close() {},
  getLastResult: () => result,
  onCameraFlightEnd(handler) {
    cameraFlightEndHandler = handler;
  },
};
const viewer = { camera, scene };
const bottomSheet = initBottomSheet({ diagnosis, viewer });

assert.ok(bottomSheet, 'ボトムシートを初期化できる');
moveStart.raise();
bottomSheet.setState('half');

await waitFor(() => sceneRenderCount >= 3);
const waitingState = bottomSheet.getMapSyncTestState();
assert.equal(waitingState.pending, true, '診断flyTo中もpendingを保持する');
assert.equal(waitingState.cameraMoving, true, '診断flyTo中のカメラ移動を認識する');
assert.equal(waitingState.adjustmentCount, 0, '診断flyTo中はmapSyncを適用しない');

moveEnd.raise();
cameraFlightEndHandler?.({ completed: true, lon: result.lon, lat: result.lat });
await waitFor(() => !bottomSheet.getMapSyncTestState().pending);

const completedState = bottomSheet.getMapSyncTestState();
assert.ok(
  completedState.pointY < completedState.sheetTop,
  `診断地点をシート上端より上へ移動する: ${JSON.stringify(completedState)}`,
);
assert.equal(completedState.cameraMoving, false, 'mapSync完了後にカメラ移動状態を解除する');
assert.equal(completedState.adjustmentCount, 1, '必要な補正を1回だけ適用する');
assert.ok(sceneRenderCount >= 6, '待機中と補間中の各段階でscene.requestRenderを発火する');

camera.positionWC = new Cartesian3();
const adjustmentCountBeforeUserMove = completedState.adjustmentCount;
bottomSheet.setState('full');
assert.equal(
  bottomSheet.getMapSyncTestState().pending,
  true,
  'ユーザー操作前はmapSyncを待機する',
);

moveStart.raise();
assert.equal(
  bottomSheet.getMapSyncTestState().pending,
  false,
  'ユーザー起因のmoveStartで待機中のmapSyncを即時破棄する',
);
moveEnd.raise();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(
  bottomSheet.getMapSyncTestState().adjustmentCount,
  adjustmentCountBeforeUserMove,
  'ユーザー操作後のmoveEndからmapSyncを再発火しない',
);

console.log('bottomsheet.test.mjs: パス');
