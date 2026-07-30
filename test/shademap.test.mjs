// 日影マップ計算エンジンのNode単体テスト
// 実行: node test/shademap.test.mjs（ブラウザ・外部ネットワーク不要）

let passed = 0;
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
    return;
  }
  const message = name + (detail ? ` — ${detail}` : '');
  failures.push(message);
  console.log(`  FAIL ${message}`);
}

function equal(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function near(name, actual, expected, tolerance = 1e-9) {
  ok(
    name,
    typeof actual === 'number' && Math.abs(actual - expected) <= tolerance,
    `expected ${expected}±${tolerance}, got ${actual}`
  );
}

function report() {
  console.log(`\nshademap.test.mjs: ${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  if (failures.length) process.exitCode = 1;
}

// ---- Cesium最小スタブ ------------------------------------------------------------

let matrixDirectionCalls = 0;

class FakeCartesian3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static fromDegrees(lon, lat, height = 0) {
    const value = new FakeCartesian3(lon, lat, height);
    value.lon = lon;
    value.lat = lat;
    value.height = height;
    return value;
  }

  static normalize(value, result) {
    const length = Math.hypot(value.x, value.y, value.z) || 1;
    result.x = value.x / length;
    result.y = value.y / length;
    result.z = value.z / length;
    return result;
  }
}

class FakeRay {
  constructor(origin, direction) {
    this.origin = origin;
    this.direction = direction;
  }
}

class FakeCartographic {
  static fromDegrees(lon, lat, height = 0) {
    return { longitude: lon, latitude: lat, lon, lat, height };
  }
}

globalThis.Cesium = {
  Cartesian3: FakeCartesian3,
  Ray: FakeRay,
  Cartographic: FakeCartographic,
  Transforms: {
    eastNorthUpToFixedFrame(origin) {
      return { origin };
    },
  },
  Matrix4: {
    multiplyByPointAsVector(_matrix, point, result) {
      matrixDirectionCalls++;
      result.x = point.x;
      result.y = point.y;
      result.z = point.z;
      return result;
    },
  },
  defined(value) {
    return value !== undefined && value !== null;
  },
};

const {
  SHADE_GRID_ORIGIN,
  SHADE_LEGEND,
  ShadeMapCache,
  buildShadeGrid,
  createShadeMapEngine,
  hoursToColor,
  shadeCacheKey,
} = await import('../js/shademap.js');
const { sampleDay, solarKeyDates } = await import('../js/solar.js');

// ---- グリッド --------------------------------------------------------------------

const grid = buildShadeGrid({
  centerLon: SHADE_GRID_ORIGIN.lon,
  centerLat: SHADE_GRID_ORIGIN.lat,
});

equal('既定グリッドは441点', grid.cells.length, 441);
equal('グリッドは3レベル', grid.levels.length, 3);
equal('40mレベルの新規点は36点', grid.levels[0].count, 36);
equal('40mレベルの累積は36点', grid.levels[0].cumulativeCount, 36);
equal('20mレベルの新規点は85点', grid.levels[1].count, 85);
equal('20mレベルまでの累積は121点', grid.levels[1].cumulativeCount, 121);
equal('10mレベルの新規点は320点', grid.levels[2].count, 320);
equal('10mレベルまでの累積は441点', grid.levels[2].cumulativeCount, 441);
ok(
  'グリッドの全点が一意',
  new Set(grid.cells.map((cell) => `${cell.column}:${cell.row}`)).size === 441
);
ok(
  'セルindexは計算順と一致',
  grid.cells.every((cell, index) => cell.index === index)
);
const lowResolutionGrid = buildShadeGrid({
  centerLon: SHADE_GRID_ORIGIN.lon,
  centerLat: SHADE_GRID_ORIGIN.lat,
  sizeM: 100,
  pitchM: 20,
});
equal('100m/20mの縮小グリッドは36点', lowResolutionGrid.cells.length, 36);
ok(
  '20mモードは40m→20mの2レベル',
  JSON.stringify(lowResolutionGrid.levels.map((level) => level.level))
    === JSON.stringify([40, 20])
);

const nearCenter = buildShadeGrid({
  centerLon: SHADE_GRID_ORIGIN.lon + 2 / (111320 * Math.cos(SHADE_GRID_ORIGIN.lat * Math.PI / 180)),
  centerLat: SHADE_GRID_ORIGIN.lat + 3 / 111320,
});
equal('10m未満の近傍中心は同じcenterIdへスナップ', nearCenter.centerId, grid.centerId);
near('同一centerIdのスナップ済み経度が一致', nearCenter.center.lon, grid.center.lon);
near('同一centerIdのスナップ済み緯度が一致', nearCenter.center.lat, grid.center.lat);

for (const index of [0, 35, 120, 440]) {
  const cell = grid.cells[index];
  const eastM = (cell.lon - grid.center.lon)
    * 111320
    * Math.cos(grid.center.lat * Math.PI / 180);
  const northM = (cell.lat - grid.center.lat) * 111320;
  near(`セル${index}の経度→東西m往復`, eastM, cell.eastM, 1e-6);
  near(`セル${index}の緯度→南北m往復`, northM, cell.northM, 1e-6);
}

// ---- 色スケール ------------------------------------------------------------------

equal('0時間の色', hoursToColor(0, 10), '#1e2a5a');
equal('2時間の色', hoursToColor(2, 10), '#5b4a9e');
equal('4時間の色', hoursToColor(4, 10), '#a86fae');
equal('6時間の色', hoursToColor(6, 10), '#e8a86a');
equal('最大時間の色', hoursToColor(10, 10), '#ffe08a');
equal('0未満は0時間へクランプ', hoursToColor(-1, 10), '#1e2a5a');
equal('最大超過は最大時間へクランプ', hoursToColor(99, 10), '#ffe08a');
equal('maxH=8でも端点は最大色', hoursToColor(8, 8), '#ffe08a');
equal('maxH=12でも端点は最大色', hoursToColor(12, 12), '#ffe08a');
ok('maxH変更で同じ8時間の色が変わる', hoursToColor(8, 8) !== hoursToColor(8, 12));
equal('maxHが6時間未満でも端点は最大色', hoursToColor(4, 4), '#ffe08a');
equal('凡例は5段', SHADE_LEGEND.length, 5);
ok(
  '凡例は各段にラベル・HEX・RGBを持つ',
  SHADE_LEGEND.every((item) =>
    typeof item.label === 'string'
    && /^#[0-9a-f]{6}$/.test(item.hex)
    && Array.isArray(item.rgb)
    && item.rgb.length === 3
  )
);

function brightness(hex) {
  const rgb = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

const colorSamples = Array.from({ length: 21 }, (_, index) => hoursToColor(index / 2, 10));
ok(
  '時間増加で色の明るさが単調増加する',
  colorSamples.every((color, index) =>
    index === 0 || brightness(color) >= brightness(colorSamples[index - 1])
  )
);
ok('補間区間で複数の色へ変化する', new Set(colorSamples).size > 10);

// ---- キャッシュキーとLRU ----------------------------------------------------------

const closeA = buildShadeGrid({
  centerLon: SHADE_GRID_ORIGIN.lon + 1 / (111320 * Math.cos(SHADE_GRID_ORIGIN.lat * Math.PI / 180)),
  centerLat: SHADE_GRID_ORIGIN.lat,
});
const closeB = buildShadeGrid({
  centerLon: SHADE_GRID_ORIGIN.lon + 4 / (111320 * Math.cos(SHADE_GRID_ORIGIN.lat * Math.PI / 180)),
  centerLat: SHADE_GRID_ORIGIN.lat,
});
const keyParams = {
  date: 'winter',
  pitchM: 10,
  sizeM: 200,
  centerId: closeA.centerId,
  layerKind: 'lod2',
};
const baseKey = shadeCacheKey(keyParams);
equal(
  '同じスナップ中心なら同じキャッシュキー',
  shadeCacheKey({ ...keyParams, centerId: closeB.centerId }),
  baseKey
);
for (const [name, changed] of [
  ['日付', { date: 'summer' }],
  ['ピッチ', { pitchM: 20 }],
  ['範囲', { sizeM: 100 }],
  ['中心ID', { centerId: 'e1:n0' }],
  ['建物レイヤー', { layerKind: 'lod1' }],
]) {
  ok(`${name}が違えば別キャッシュキー`, shadeCacheKey({ ...keyParams, ...changed }) !== baseKey);
}
ok('キャッシュキーに高精度モード項目を含めない', !baseKey.includes('highPrecision'));

const cache = new ShadeMapCache();
equal('LRUの既定容量は4', cache.capacity, 4);
const cacheValue = (number, completed = true) => ({
  cells: new Float32Array([number]),
  completed,
  meta: { number },
});
cache.set('a', cacheValue(1));
cache.set('b', cacheValue(2));
cache.set('c', cacheValue(3));
cache.set('d', cacheValue(4));
equal('4件まで保持する', cache.size, 4);
equal('getで値を取得できる', cache.get('a').meta.number, 1);
cache.set('e', cacheValue(5));
equal('容量超過でも4件を維持', cache.size, 4);
equal('最も使われていないbを追い出す', cache.has('b'), false);
equal('getしたaは追い出されない', cache.has('a'), true);
ok(
  'LRU順は最古からc,d,a,e',
  JSON.stringify(cache.keys()) === JSON.stringify(['c', 'd', 'a', 'e']),
  JSON.stringify(cache.keys())
);
equal('未完走結果はsetを拒否する', cache.set('partial', cacheValue(9, false)), false);
equal('未完走結果は格納されない', cache.has('partial'), false);
equal('Float32Array以外はsetを拒否する', cache.set('bad', { cells: [1], completed: true }), false);
equal('拒否後も容量は変わらない', cache.size, 4);

// ---- 計算エンジン: 完走・進捗・方向共有 -------------------------------------------

const originalCacheBytes = 512 * 1024 * 1024;
const fullTileset = { cacheBytes: originalCacheBytes };
const fullProgress = [];
const fullLevels = [];
const fullDirections = new Set();
let fullRafCalls = 0;
let detailedCalls = 0;
let sampleCalls = 0;
const cacheBytesDuringWarmUp = [];
let clock = 0;

const fullScene = {
  async sampleHeightMostDetailed(items) {
    sampleCalls++;
    return items.map((item) => ({ ...item, height: 10 }));
  },
  pickFromRayMostDetailed() {
    detailedCalls++;
    cacheBytesDuringWarmUp.push(fullTileset.cacheBytes);
    return Promise.resolve(undefined);
  },
  pickFromRay(ray) {
    fullDirections.add(ray.direction);
    return undefined;
  },
};
const fullEngine = createShadeMapEngine({
  scene: fullScene,
  tileset: fullTileset,
  viewer: { scene: fullScene },
  now: () => {
    clock += 4;
    return clock;
  },
  raf: (callback) => {
    fullRafCalls++;
    callback();
  },
});

matrixDirectionCalls = 0;
const fullResult = await fullEngine.run({
  center: SHADE_GRID_ORIGIN,
  sizeM: 40,
  pitchM: 10,
  date: 'winter',
  onProgress: (fraction) => fullProgress.push(fraction),
  onLevelComplete: (level, partial) => fullLevels.push({ level, partial }),
  isCancelled: () => false,
});

const winterDate = solarKeyDates(new Date().getFullYear()).find((item) => item.key === 'winter');
const activeWinterSlots = sampleDay(
  winterDate.year,
  winterDate.month,
  winterDate.day,
  fullResult.grid.center.lon,
  fullResult.grid.center.lat,
  { hourStart: 7, hourEnd: 17, stepMinutes: 20 }
).filter((slot) => slot.elevationDeg >= 5).length;
const expectedHours = activeWinterSlots * 20 / 60;

equal('完走結果はcompleted:true', fullResult.completed, true);
ok('セル値はFloat32Array', fullResult.cells instanceof Float32Array);
equal('縮小グリッドは25セル', fullResult.cells.length, 25);
ok(
  '全セルに日照時間が入る',
  [...fullResult.cells].every((hours) => Math.abs(hours - expectedHours) < 1e-5)
);
equal('有効スロット数を返す', fullResult.slotCount, activeWinterSlots);
equal('全レイを完了する', fullResult.raysCompleted, 25 * activeWinterSlots);
equal('多原点warm-upは5点×3方向の15本', detailedCalls, 15);
equal('中心高さ取得+25点屋上判定の2回サンプル', sampleCalls, 2);
equal('本計算の共有方向オブジェクト数はスロット数だけ', fullDirections.size, activeWinterSlots);
equal(
  '方向変換はwarm-up15回+本計算のスロット数だけ',
  matrixDirectionCalls,
  15 + activeWinterSlots
);
ok('8ms予算超過でrAFへ処理を譲る', fullRafCalls > 0);
ok('進捗コールバックが呼ばれる', fullProgress.length > 1);
ok(
  '進捗値は厳密に単調増加する',
  fullProgress.every((value, index) => index === 0 || value > fullProgress[index - 1])
);
equal('完走時の最終進捗は1', fullProgress.at(-1), 1);
ok('進捗値は0より大きく1以下', fullProgress.every((value) => value > 0 && value <= 1));
ok(
  '40m→20m→10mのレベル完了順',
  JSON.stringify(fullLevels.map((item) => item.level)) === JSON.stringify([40, 20, 10])
);
ok(
  'レベル完了の部分結果は同じcells/gridを持つ',
  fullLevels.every((item) =>
    item.partial.cells === fullResult.cells && item.partial.grid === fullResult.grid
  )
);
near('レイ時間中央値はnowスタブどおり4ms', fullResult.msPerRayMedian, 4);
ok(
  'run全体でcacheBytesが引き上げられる',
  cacheBytesDuringWarmUp.every((bytes) => bytes > originalCacheBytes)
);
equal('完走後にcacheBytesを復元する', fullTileset.cacheBytes, originalCacheBytes);

// ---- 計算エンジン: 8ms境界での中途キャンセル -------------------------------------

let cancelClock = 0;
let cancelled = false;
let cancelRafCalls = 0;
const cancelTileset = { cacheBytes: originalCacheBytes };
const cancelScene = {
  async sampleHeightMostDetailed(items) {
    return items.map((item) => ({ ...item, height: 10 }));
  },
  pickFromRayMostDetailed() {
    return Promise.resolve(undefined);
  },
  pickFromRay() {
    return undefined;
  },
};
const cancelEngine = createShadeMapEngine({
  scene: cancelScene,
  tileset: cancelTileset,
  viewer: { scene: cancelScene },
  now: () => {
    cancelClock += 4;
    return cancelClock;
  },
  raf: (callback) => {
    cancelRafCalls++;
    cancelled = true;
    callback();
  },
});
const cancelProgress = [];
const cancelResult = await cancelEngine.run({
  center: SHADE_GRID_ORIGIN,
  sizeM: 40,
  pitchM: 10,
  onProgress: (fraction) => cancelProgress.push(fraction),
  isCancelled: () => cancelled,
});

equal('中途キャンセルはcompleted:false', cancelResult.completed, false);
ok('キャンセル前の部分レイ結果を返す', cancelResult.raysCompleted > 0);
ok('キャンセル時は全レイ未満で停止', cancelResult.raysCompleted < cancelResult.totalRays);
ok('キャンセル結果もFloat32Array', cancelResult.cells instanceof Float32Array);
equal('予算超過後のrAFでキャンセルを検出', cancelRafCalls, 1);
ok('キャンセル時の進捗は1未満', cancelProgress.at(-1) < 1);
equal('キャンセル後もcacheBytesを復元する', cancelTileset.cacheBytes, originalCacheBytes);

// ---- 計算エンジン: 屋上セル判定 ---------------------------------------------------

let rooftopSampleCalls = 0;
const rayOrigins = [];
const rooftopScene = {
  async sampleHeightMostDetailed(items) {
    rooftopSampleCalls++;
    if (rooftopSampleCalls === 1) {
      return items.map((item) => ({ ...item, height: 10 }));
    }
    return items.map((item, index) => ({
      ...item,
      // 1点目は中心+4m超、2点目はちょうど+4m、残りは楕円体0m相当。
      height: index === 0 ? 15 : index === 1 ? 14 : 0,
    }));
  },
  pickFromRayMostDetailed() {
    return Promise.resolve(undefined);
  },
  pickFromRay(ray) {
    rayOrigins.push(ray.origin);
    return undefined;
  },
};
const rooftopEngine = createShadeMapEngine({
  scene: rooftopScene,
  tileset: { cacheBytes: originalCacheBytes },
  viewer: { scene: rooftopScene },
  now: () => 0,
  raf: (callback) => callback(),
});
const rooftopResult = await rooftopEngine.run({
  center: SHADE_GRID_ORIGIN,
  sizeM: 40,
  pitchM: 10,
});

equal('屋上検出の中心高さは10m', rooftopResult.baseHeight, 10);
equal('中心+4m超の1セルだけ屋上扱い', rooftopResult.rooftopCells, 1);
equal('屋上セルはサンプル高さ15mを採用', rooftopResult.cellHeights[0], 15);
equal('中心+4mちょうどは中心高さへ戻す', rooftopResult.cellHeights[1], 10);
equal('楕円体0mは破棄して中心高さへ戻す', rooftopResult.cellHeights[2], 10);
near('屋上セルのレイ原点は15m+1.2m', rayOrigins[0].height, 16.2);
near(
  '非屋上セルのレイ原点は中心10m+1.2m',
  rayOrigins[activeWinterSlots].height,
  11.2
);

// ---- 計算エンジン: 非公開API・高さバッチのgraceful degradation -------------------

let fallbackSampleCalls = 0;
const fallbackScene = {
  async sampleHeightMostDetailed(items) {
    fallbackSampleCalls++;
    if (fallbackSampleCalls === 1) {
      return items.map((item) => ({ ...item, height: 12 }));
    }
    throw new Error('テスト用の高さバッチ失敗');
  },
  pickFromRayMostDetailed() {
    throw new Error('テスト用のwarm-up失敗');
  },
  pickFromRay() {
    throw new Error('テスト用のpick失敗');
  },
};
const fallbackEngine = createShadeMapEngine({
  scene: fallbackScene,
  tileset: { cacheBytes: originalCacheBytes },
  viewer: { scene: fallbackScene },
  now: () => 0,
  raf: (callback) => callback(),
});
const fallbackResult = await fallbackEngine.run({
  center: SHADE_GRID_ORIGIN,
  sizeM: 10,
  pitchM: 10,
});

equal('非公開API例外でも計算は完走する', fallbackResult.completed, true);
ok('pick例外のスロットをlit扱いにしない', [...fallbackResult.cells].every((hours) => hours === 0));
equal(
  'pick例外数を全レイ分記録する',
  fallbackResult.pickErrors,
  fallbackResult.totalRays
);
ok(
  '高さバッチ失敗時は全セルで中心高さを使う',
  [...fallbackResult.cellHeights].every((height) => height === 12)
);

report();
