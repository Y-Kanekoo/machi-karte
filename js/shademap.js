// 日影マップ計算エンジン
//
// 画面中心を中野駅基準の10m格子へスナップし、40m→20m→10mの順で
// 入れ子グリッドを計算する。UI・DOM・描画処理は次フェーズ（R3-P4）の責務とし、
// このモジュールはグリッド、色、キャッシュ、レイ計算だけを提供する。
//
// 非公開API（pickFromRay / pickFromRayMostDetailed）は機能検出と try/catch で包み、
// 利用できない場合も計算全体を例外終了させない。
//
import { jstDate, sampleDay, solarKeyDates, sunPosition } from './solar.js';
import { MIN_PLAUSIBLE_BASE_HEIGHT, resolveBaseHeight } from './floodviz.js';
import {
  boostTilesetCache,
  DEFAULT_BASE_HEIGHT,
  estimateBaseHeight,
  EYE_HEIGHT,
  HOUR_END,
  HOUR_START,
  MIN_SUN_ELEVATION,
  SAMPLE_STEP_MIN,
  WARM_UP_CONCURRENCY,
  WARM_UP_TIMEOUT_MS,
} from './sunlight.js';

const RAD = Math.PI / 180;
const METERS_PER_DEGREE = 111320;
const CENTER_SNAP_M = 10;
const DEFAULT_FRAME_BUDGET_MS = 8;
const SAMPLE_BATCH_SIZE = 64;
const HEIGHT_SAMPLE_TIMEOUT_MS = 15000;
/** 日影マップでは多原点になるため、朝・南中・夕へ意図的に間引いた専用時刻を使う。 */
const SHADE_WARM_UP_HOURS_JST = [8, 12, 16];
const STANDARD_LEVEL_PITCHES_M = [40, 20, 10];

/** 中野駅。日影マップ中心の10mスナップに使う固定原点 */
export const SHADE_GRID_ORIGIN = Object.freeze({ lon: 139.6659, lat: 35.7010 });

const COLOR_DEFINITIONS = [
  { hours: 0, label: '0時間', hex: '#1e2a5a', rgb: [30, 42, 90] },
  { hours: 2, label: '2時間', hex: '#5b4a9e', rgb: [91, 74, 158] },
  { hours: 4, label: '4時間', hex: '#a86fae', rgb: [168, 111, 174] },
  { hours: 6, label: '6時間', hex: '#e8a86a', rgb: [232, 168, 106] },
  { hours: null, label: '最大', hex: '#ffe08a', rgb: [255, 224, 138] },
];

/** 凡例5段のラベル・HEX・RGB定義 */
export const SHADE_LEGEND = Object.freeze(
  COLOR_DEFINITIONS.map((item) => Object.freeze({
    ...item,
    rgb: Object.freeze([...item.rgb]),
  }))
);

/**
 * 中野駅を原点に、中心座標を10m格子へスナップする。
 * @returns {{lon:number, lat:number, eastIndex:number, northIndex:number, centerId:string}}
 */
function snapCenter(centerLon, centerLat) {
  const northM = (centerLat - SHADE_GRID_ORIGIN.lat) * METERS_PER_DEGREE;
  const northIndex = Math.round(northM / CENTER_SNAP_M);
  const lat = SHADE_GRID_ORIGIN.lat
    + (northIndex * CENTER_SNAP_M) / METERS_PER_DEGREE;
  const centerCos = Math.cos(lat * RAD);
  const eastM = (centerLon - SHADE_GRID_ORIGIN.lon) * METERS_PER_DEGREE * centerCos;
  const eastIndex = Math.round(eastM / CENTER_SNAP_M);
  return {
    lon: SHADE_GRID_ORIGIN.lon
      + (eastIndex * CENTER_SNAP_M) / (METERS_PER_DEGREE * centerCos),
    lat,
    eastIndex,
    northIndex,
    centerId: `e${eastIndex}:n${northIndex}`,
  };
}

/** スナップ済み中心からメートルオフセットした地点を経緯度へ変換する。 */
function offsetToLonLat(center, eastM, northM) {
  const cosLat = Math.cos(center.lat * RAD);
  return {
    lon: center.lon + eastM / (METERS_PER_DEGREE * cosLat),
    lat: center.lat + northM / METERS_PER_DEGREE,
  };
}

/**
 * 40m→20m→10mの入れ子グリッドを構築する。
 *
 * `pitchM` は最終レベルのピッチ。既定の10mでは40m / 20m / 10m、
 * 低速機向けの20mでは40m / 20mの順とし、前レベルに無かった点だけを
 * `level.newCells` に列挙する。`newCells` はそのレベルで新しく加わるセルだけであり、
 * それ以前のレベルで計算済みのセルは含まない。
 *
 * @returns {object} `bounds` はセル中心のbbox（計算・検証用）。
 *   `boundsOuter` は外周セルの半ピッチ外側まで含むbboxで、描画矩形にはこちらを使う。
 */
export function buildShadeGrid({
  centerLon,
  centerLat,
  sizeM = 200,
  pitchM = 10,
}) {
  const lon = Number(centerLon);
  const lat = Number(centerLat);
  const size = Number(sizeM);
  const pitch = Number(pitchM);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new TypeError('日影マップの中心座標が不正です');
  }
  if (!(Number.isFinite(size) && size > 0) || !(Number.isFinite(pitch) && pitch > 0)) {
    throw new RangeError('日影マップの範囲とピッチは正の数で指定してください');
  }

  const intervalCount = Math.round(size / pitch);
  if (intervalCount < 1 || Math.abs(intervalCount * pitch - size) > 1e-7) {
    throw new RangeError('日影マップの範囲はピッチで割り切れる値にしてください');
  }

  const snappedCenter = snapCenter(lon, lat);
  const half = size / 2;
  const cells = [];
  const levels = [];
  const seen = new Set();

  const levelPitches = STANDARD_LEVEL_PITCHES_M
    .filter((levelPitchM) =>
      levelPitchM >= pitch && Math.abs(levelPitchM / pitch - Math.round(levelPitchM / pitch)) < 1e-9
      && Math.abs(size / levelPitchM - Math.round(size / levelPitchM)) < 1e-9
    );
  if (!levelPitches.includes(pitch)) levelPitches.push(pitch);

  for (const levelPitchM of levelPitches) {
    const factor = Math.max(1, Math.round(levelPitchM / pitch));
    const axisIndices = [];
    for (let i = 0; i <= intervalCount; i++) {
      if (i % factor === 0) axisIndices.push(i);
    }

    const levelCells = [];
    for (const row of axisIndices) {
      for (const column of axisIndices) {
        const pointKey = `${column}:${row}`;
        if (seen.has(pointKey)) continue;
        seen.add(pointKey);
        const eastM = -half + column * pitch;
        const northM = -half + row * pitch;
        const position = offsetToLonLat(snappedCenter, eastM, northM);
        const cell = {
          index: cells.length,
          lon: position.lon,
          lat: position.lat,
          eastM,
          northM,
          level: levelPitchM,
          column,
          row,
        };
        cells.push(cell);
        levelCells.push(cell);
      }
    }

    levels.push({
      level: levelPitchM,
      pitchM: levelPitchM,
      newCells: levelCells,
      count: levelCells.length,
      cumulativeCount: cells.length,
    });
  }

  const southWest = offsetToLonLat(snappedCenter, -half, -half);
  const northEast = offsetToLonLat(snappedCenter, half, half);
  const outerHalf = half + pitch / 2;
  const outerSouthWest = offsetToLonLat(snappedCenter, -outerHalf, -outerHalf);
  const outerNorthEast = offsetToLonLat(snappedCenter, outerHalf, outerHalf);
  return {
    requestedCenter: { lon, lat },
    center: { lon: snappedCenter.lon, lat: snappedCenter.lat },
    snappedCenter: { lon: snappedCenter.lon, lat: snappedCenter.lat },
    centerId: snappedCenter.centerId,
    centerIndex: {
      east: snappedCenter.eastIndex,
      north: snappedCenter.northIndex,
    },
    sizeM: size,
    pitchM: pitch,
    cells,
    levels,
    // セル中心のbbox。セル座標の検証・計算用であり、描画矩形には使わない。
    bounds: {
      west: southWest.lon,
      south: southWest.lat,
      east: northEast.lon,
      north: northEast.lat,
    },
    // 外周セルの端まで含むbbox。P4の描画矩形は必ずこちらを使う。
    boundsOuter: {
      west: outerSouthWest.lon,
      south: outerSouthWest.lat,
      east: outerNorthEast.lon,
      north: outerNorthEast.lat,
    },
  };
}

/**
 * 日照時間を凡例色へ変換する。
 *
 * maxH が6時間以下でも最大値の色を保証するため、maxH以上の固定中間点は省き、
 * 最後の有効な固定色から最大色へ補間する。
 */
export function hoursToColor(h, maxH) {
  const maximum = Number(maxH);
  const safeMax = Number.isFinite(maximum) && maximum > 0 ? maximum : 10;
  const value = Math.min(safeMax, Math.max(0, Number.isFinite(Number(h)) ? Number(h) : 0));
  const stops = COLOR_DEFINITIONS
    .slice(0, -1)
    .filter((stop) => stop.hours < safeMax)
    .map((stop) => ({ hours: stop.hours, rgb: stop.rgb }));
  stops.push({ hours: safeMax, rgb: COLOR_DEFINITIONS.at(-1).rgb });

  if (value <= stops[0].hours) return rgbToHex(stops[0].rgb);
  for (let i = 1; i < stops.length; i++) {
    const upper = stops[i];
    if (value > upper.hours) continue;
    const lower = stops[i - 1];
    const width = upper.hours - lower.hours;
    const ratio = width > 0 ? (value - lower.hours) / width : 1;
    const rgb = lower.rgb.map((channel, index) =>
      Math.round(channel + (upper.rgb[index] - channel) * ratio)
    );
    return rgbToHex(rgb);
  }
  return COLOR_DEFINITIONS.at(-1).hex;
}

function rgbToHex(rgb) {
  return '#' + rgb.map((value) =>
    Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, '0')
  ).join('');
}

/**
 * 日付キーをsolar.jsの内部キーへ正規化する。
 * springはコードベース既定のequinoxと同一条件として扱う。
 */
function normalizeDateKey(date) {
  if (date === 'spring' || date === 'equinox') return 'equinox';
  if (date === 'winter' || date === 'summer') return date;
  throw new RangeError(
    '日影マップの日付キーは winter、spring、equinox、summer のいずれかを指定してください'
  );
}

/**
 * 日影マップのLRUキャッシュキーを返す。高精度モードはR3スコープ外。
 * spring/equinoxは正規化し、計算年を含めて年跨ぎの誤ヒットを防ぐ。
 */
export function shadeCacheKey(params = {}) {
  const required = ['date', 'pitchM', 'sizeM', 'centerId', 'layerKind'];
  for (const field of required) {
    const value = params?.[field];
    if (value === undefined || value === null || value === '') {
      throw new TypeError(`日影マップのキャッシュキーに必須項目「${field}」がありません`);
    }
  }
  const year = params.year ?? new Date().getFullYear();
  if (!Number.isInteger(year)) {
    throw new RangeError('日影マップの計算年は整数で指定してください');
  }
  return [
    normalizeDateKey(params.date),
    String(year),
    String(params.pitchM),
    String(params.sizeM),
    String(params.centerId),
    String(params.layerKind),
  ].join('|');
}

/** 完走結果だけを保持する、容量4件のメモリLRUキャッシュ。 */
export class ShadeMapCache {
  constructor(capacity = 4) {
    const n = Number(capacity);
    this.capacity = Number.isInteger(n) && n > 0 ? n : 4;
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  get(key) {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key);
    // getした項目を末尾（最新）へ移す。
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key, value) {
    if (!value || value.completed !== true || !(value.cells instanceof Float32Array)) {
      return false;
    }
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, {
      ...value,
      // run結果のcellsは共有配列なので、呼び出し側の後続変更からキャッシュを隔離する。
      cells: new Float32Array(value.cells),
    });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    return true;
  }

  has(key) {
    return this.entries.has(key);
  }

  delete(key) {
    return this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  /** テスト・診断用。最古→最新の順でキーを返す。 */
  keys() {
    return [...this.entries.keys()];
  }
}

/**
 * 日影マップ計算エンジンを作る。
 *
 * `deps.viewer` は中心地盤高取得とsceneアクセスの両方に使うため実質必須。
 * `run()` の多重呼び出しはエンジン内でガードしないため、呼び出し側で直列化すること。
 *
 * @param {{tileset:object|null, viewer:object,
 *          raf?:(callback:Function)=>unknown, now?:()=>number}} deps
 * @returns {{run:(options:{
 *   center:{lon:number,lat:number}, sizeM?:number, pitchM?:number,
 *   date?:'winter'|'spring'|'equinox'|'summer', year?:number, frameBudgetMs?:number,
 *   onProgress?:((fraction:number, partial?:object)=>void)|null,
 *   onLevelComplete?:((level:number, partial:object)=>void)|null,
 *   isCancelled?:(()=>boolean)|null
 * })=>Promise<{
 *   cells:Float32Array, grid:object, completed:boolean, error:string|null,
 *   date:'winter'|'equinox'|'summer', year:number,
 *   baseHeight:number|null, cellHeights:Float64Array, rooftopCells:number,
 *   computedCount:number, raysCompleted:number, totalRays:number,
 *   pickErrors:number, pickSupported:boolean, slotCount:number,
 *   msPerRayMedian:number|null
 * }>>}}
 *   `cells`はレベル完了通知と最終結果で共有する配列。保持する場合は呼び出し側でコピーすること。
 */
export function createShadeMapEngine(deps = {}) {
  const viewer = deps.viewer;
  const scene = viewer?.scene;
  const tileset = deps.tileset || null;
  const raf = typeof deps.raf === 'function' ? deps.raf : defaultRaf;
  const now = typeof deps.now === 'function' ? deps.now : defaultNow;

  async function run({
    center,
    sizeM = 200,
    pitchM = 10,
    date = 'winter',
    year = new Date().getFullYear(),
    frameBudgetMs = DEFAULT_FRAME_BUDGET_MS,
    onProgress = null,
    onLevelComplete = null,
    isCancelled = null,
  }) {
    const normalizedDate = normalizeDateKey(date);
    if (!Number.isInteger(year)) {
      throw new RangeError('日影マップの計算年は整数で指定してください');
    }
    const frameBudget = Number(frameBudgetMs);
    if (!(Number.isFinite(frameBudget) && frameBudget > 0)) {
      throw new RangeError('日影マップのフレーム予算は正の数で指定してください');
    }
    const grid = buildShadeGrid({
      centerLon: center?.lon,
      centerLat: center?.lat,
      sizeM,
      pitchM,
    });
    const cells = new Float32Array(grid.cells.length);
    const rayMs = [];
    let pickErrors = 0;
    let doneRays = 0;
    let lastProgress = -1;
    let cellHeights = new Float64Array(grid.cells.length);
    let baseHeight = null;
    let rooftopCells = 0;
    let computedCount = 0;
    const pickSupported = !!scene && typeof scene.pickFromRay === 'function';

    const cancelledNow = () => {
      try {
        return !!(typeof isCancelled === 'function' && isCancelled());
      } catch (_) {
        return false;
      }
    };

    const result = (completed, slotCount = 0, error = null) => ({
      cells,
      grid,
      completed,
      error,
      date: normalizedDate,
      year,
      msPerRayMedian: median(rayMs),
      baseHeight,
      cellHeights,
      rooftopCells,
      computedCount,
      raysCompleted: doneRays,
      totalRays: grid.cells.length * slotCount,
      pickErrors,
      pickSupported,
      slotCount,
    });

    const emitProgress = (fraction, partial = undefined) => {
      const next = Math.min(1, Math.max(0, fraction));
      if (!(next > lastProgress)) return;
      lastProgress = next;
      if (typeof onProgress !== 'function') return;
      try {
        // 第1引数の進捗率は従来どおり。第2引数はUIが精細パス途中を描けるよう
        // 後方互換で追加した、その時点の確定済みセル数を含む部分結果。
        onProgress(next, partial);
      } catch (error) {
        console.warn('日影マップの進捗コールバックで例外が発生しました', error);
      }
    };

    // 未対応環境では高さ取得やウォームアップを始めず、偽の完走結果も作らない。
    if (!pickSupported) {
      return result(
        false,
        0,
        'この描画環境ではレイキャスト（pickFromRay）が利用できないため日影マップを計算できません'
      );
    }

    const releaseCache = boostTilesetCache(tileset);
    try {
      if (cancelledNow()) return result(false);

      const baseSettled = await settleWithTimeoutAndCancellation(
        Promise.resolve().then(() => estimateBaseHeight(
          viewer,
          grid.center.lon,
          grid.center.lat,
          null
        )),
        HEIGHT_SAMPLE_TIMEOUT_MS,
        cancelledNow
      );
      if (baseSettled.cancelled) return result(false);
      if (baseSettled.timedOut) {
        console.warn('日影マップの中心地盤高取得が15秒でタイムアウトしたため既定値を使います');
      } else if (baseSettled.error) {
        console.warn('日影マップの中心地盤高取得に失敗したため既定値を使います', baseSettled.error);
      }
      const rawBaseHeight = baseSettled.timedOut || baseSettled.error
        ? DEFAULT_BASE_HEIGHT
        : baseSettled.value?.height;
      baseHeight = resolveBaseHeight(rawBaseHeight, DEFAULT_BASE_HEIGHT);
      if (cancelledNow()) return result(false);

      const sampled = await detectRooftopCells(scene, grid, baseHeight, cancelledNow);
      baseHeight = sampled.baseHeight;
      cellHeights = sampled.heights;
      rooftopCells = sampled.rooftopCells;
      if (sampled.cancelled || cancelledNow()) return result(false);

      // 四隅+中心の5原点 × 朝/南中/夕のうち高度5度以上の方向を先読みする。
      await warmUpMultipleOrigins(
        scene,
        grid,
        baseHeight + EYE_HEIGHT,
        normalizedDate,
        year,
        cancelledNow
      );
      if (cancelledNow()) return result(false);

      const selectedDate = selectSolarDate(normalizedDate, year);
      const samples = sampleDay(
        selectedDate.year,
        selectedDate.month,
        selectedDate.day,
        grid.center.lon,
        grid.center.lat,
        {
          hourStart: HOUR_START,
          hourEnd: HOUR_END,
          stepMinutes: SAMPLE_STEP_MIN,
        }
      ).filter((sample) => sample.elevationDeg >= MIN_SUN_ELEVATION);

      // 太陽方向は中心ENUでスロットごとに1回だけ計算し、全セルで共有する。
      const directionOrigin = Cesium.Cartesian3.fromDegrees(
        grid.center.lon,
        grid.center.lat,
        baseHeight + EYE_HEIGHT
      );
      const centerEnu = Cesium.Transforms.eastNorthUpToFixedFrame(directionOrigin);
      const slotDirections = samples.map((sample) =>
        sunDirectionEcef(centerEnu, sample.azimuthDeg, sample.elevationDeg)
      );
      const slotCount = slotDirections.length;
      const totalRays = grid.cells.length * slotCount;
      const ray = new Cesium.Ray(new Cesium.Cartesian3(), new Cesium.Cartesian3());
      let frameStarted = now();

      for (const level of grid.levels) {
        for (const cell of level.newCells) {
          const origin = Cesium.Cartesian3.fromDegrees(
            cell.lon,
            cell.lat,
            cellHeights[cell.index] + EYE_HEIGHT
          );
          ray.origin = origin;
          let litSlots = 0;

          for (const direction of slotDirections) {
            let lit = false;
            ray.direction = direction;
            const started = now();
            let measuredAt;
            try {
              const hit = scene.pickFromRay(ray);
              measuredAt = now();
              rayMs.push(measuredAt - started);
              lit = !(isDefined(hit) && isDefined(hit.position));
            } catch (_) {
              measuredAt = now();
              // 例外スロットは「遮蔽なし」とせず、0時間側へ倒して計算を続ける。
              pickErrors++;
            }
            if (lit) litSlots++;
            cells[cell.index] = litSlots * (SAMPLE_STEP_MIN / 60);
            doneRays++;

            if (measuredAt - frameStarted > frameBudget) {
              emitProgress(
                totalRays > 0 ? doneRays / totalRays : computedCount / grid.cells.length,
                result(false, slotCount)
              );
              const frame = await nextFrame(raf, cancelledNow);
              if (frame.cancelled || cancelledNow()) return result(false, slotCount);
              frameStarted = now();
            }
          }
          computedCount++;
        }

        if (level.newCells.length > 0 && typeof onLevelComplete === 'function') {
          try {
            onLevelComplete(level.level, result(false, slotCount));
          } catch (error) {
            console.warn('日影マップのレベル完了コールバックで例外が発生しました', error);
          }
        }
      }

      emitProgress(1, result(false, slotCount));
      return result(true, slotCount);
    } finally {
      releaseCache();
    }
  }

  return { run };
}

/** 正規化済みの日付キーをsolarKeyDatesの日付へ対応付ける。 */
function selectSolarDate(date, year) {
  return solarKeyDates(year).find((item) => item.key === date);
}

/** ENU（東・北・上）方向をECEF方向へ変換する。 */
function sunDirectionEcef(enuMatrix, azimuthDeg, elevationDeg) {
  const elevation = elevationDeg * RAD;
  const azimuth = azimuthDeg * RAD;
  const enu = new Cesium.Cartesian3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.cos(elevation) * Math.cos(azimuth),
    Math.sin(elevation)
  );
  const ecef = Cesium.Matrix4.multiplyByPointAsVector(
    enuMatrix,
    enu,
    new Cesium.Cartesian3()
  );
  return Cesium.Cartesian3.normalize(ecef, ecef);
}

/** 多原点ウォームアップ。失敗・未対応・タイムアウトは呼び出し側へ例外を出さない。 */
async function warmUpMultipleOrigins(scene, grid, height, date, year, isCancelled) {
  if (!scene || typeof scene.pickFromRayMostDetailed !== 'function' || isCancelled()) {
    return;
  }
  try {
    const selectedDate = selectSolarDate(date, year);
    const directions = SHADE_WARM_UP_HOURS_JST.map((hour) => {
      const position = sunPosition(
        jstDate(selectedDate.year, selectedDate.month, selectedDate.day, hour, 0),
        grid.center.lon,
        grid.center.lat
      );
      return {
        azimuthDeg: position.azimuthDeg,
        elevationDeg: position.elevationDeg,
      };
    }).filter((direction) => direction.elevationDeg >= MIN_SUN_ELEVATION);
    const half = grid.sizeM / 2;
    const offsets = [
      { eastM: -half, northM: -half },
      { eastM: half, northM: -half },
      { eastM: -half, northM: half },
      { eastM: half, northM: half },
      { eastM: 0, northM: 0 },
    ];
    const raySpecs = [];
    for (const offset of offsets) {
      const point = offsetToLonLat(grid.center, offset.eastM, offset.northM);
      const origin = Cesium.Cartesian3.fromDegrees(point.lon, point.lat, height);
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
      for (const direction of directions) {
        raySpecs.push({
          origin,
          direction: sunDirectionEcef(enu, direction.azimuthDeg, direction.elevationDeg),
        });
      }
    }

    const deadline = defaultNow() + WARM_UP_TIMEOUT_MS;
    for (let start = 0; start < raySpecs.length; start += WARM_UP_CONCURRENCY) {
      if (isCancelled()) return;
      const remaining = deadline - defaultNow();
      if (remaining <= 0) return;
      const batch = raySpecs.slice(start, start + WARM_UP_CONCURRENCY).map((spec) => {
        try {
          const ray = new Cesium.Ray(
            spec.origin,
            spec.direction
          );
          return Promise.resolve(scene.pickFromRayMostDetailed(ray));
        } catch (error) {
          return Promise.reject(error);
        }
      });
      const settled = await settleWithTimeoutAndCancellation(
        Promise.allSettled(batch),
        remaining,
        isCancelled
      );
      if (settled.cancelled || settled.timedOut) return;
    }
  } catch (error) {
    console.warn('日影マップの多原点ウォームアップに失敗しました', error);
  }
}

/** 64点ずつ高さを取得し、中心値+4mを超える点だけ屋上高さとして採用する。 */
async function detectRooftopCells(scene, grid, baseHeight, isCancelled) {
  const heights = new Float64Array(grid.cells.length);
  heights.fill(baseHeight);
  if (!scene || typeof scene.sampleHeightMostDetailed !== 'function') {
    return { baseHeight, heights, rooftopCells: 0, cancelled: false };
  }

  const cartographics = grid.cells.map((cell) =>
    Cesium.Cartographic.fromDegrees(cell.lon, cell.lat)
  );
  const sampledHeights = new Float64Array(grid.cells.length);
  sampledHeights.fill(Number.NaN);

  for (let start = 0; start < cartographics.length; start += SAMPLE_BATCH_SIZE) {
    const batch = cartographics.slice(start, start + SAMPLE_BATCH_SIZE);
    const settled = await settleWithTimeoutAndCancellation(
      Promise.resolve().then(() => scene.sampleHeightMostDetailed(batch)),
      HEIGHT_SAMPLE_TIMEOUT_MS,
      isCancelled
    );
    if (settled.cancelled) {
      return { baseHeight, heights, rooftopCells: 0, cancelled: true };
    }
    if (settled.timedOut) {
      console.warn('日影マップの高さバッチ取得が15秒でタイムアウトしたため地表高さへ縮退します');
      continue;
    }
    if (settled.error) {
      console.warn('日影マップの高さバッチ取得に失敗したため地表高さへ縮退します', settled.error);
      continue;
    }
    const results = settled.value;
    if (!Array.isArray(results) || results.length !== batch.length) {
      console.warn('日影マップの高さバッチ件数が一致しないため地表高さへ縮退します');
      continue;
    }
    for (let i = 0; i < results.length; i++) {
      const height = results[i]?.height;
      if (Number.isFinite(height)) sampledHeights[start + i] = height;
    }
  }

  // 中心が建物屋上だった場合は、バッチ内の最も低い妥当値を地表候補として採用する。
  let groundCandidate = Infinity;
  for (const sampledHeight of sampledHeights) {
    if (
      sampledHeight >= MIN_PLAUSIBLE_BASE_HEIGHT
      && sampledHeight < groundCandidate
    ) {
      groundCandidate = sampledHeight;
    }
  }
  const sanitizedBaseHeight = Number.isFinite(groundCandidate)
    && baseHeight > groundCandidate + 4
    ? groundCandidate
    : baseHeight;
  heights.fill(sanitizedBaseHeight);

  let rooftopCells = 0;
  for (let i = 0; i < sampledHeights.length; i++) {
    if (sampledHeights[i] > sanitizedBaseHeight + 4) {
      heights[i] = sampledHeights[i];
      rooftopCells++;
    }
  }
  return {
    baseHeight: sanitizedBaseHeight,
    heights,
    rooftopCells,
    cancelled: false,
  };
}

/** Promiseをタイムアウト・キャンセルと競争させ、監視タイマーを必ず片付ける。 */
function settleWithTimeoutAndCancellation(promise, timeoutMs, isCancelled) {
  return new Promise((resolve) => {
    let finished = false;
    let timeout = null;
    let poll = null;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(poll);
      resolve(value);
    };
    promise.then(
      (value) => finish({ value, timedOut: false, cancelled: false }),
      (error) => finish({ error, timedOut: false, cancelled: false })
    );
    timeout = setTimeout(() => finish({ timedOut: true, cancelled: false }), timeoutMs);
    poll = setInterval(() => {
      if (isCancelled()) finish({ timedOut: false, cancelled: true });
    }, 100);
  });
}

/** Promiseの解決をキャンセル監視と競争させる。 */
function settleWithCancellation(promise, isCancelled) {
  return new Promise((resolve) => {
    let finished = false;
    let poll = null;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      resolve(value);
    };
    if (isCancelled()) {
      finish({ cancelled: true });
      return;
    }
    promise.then(
      (value) => finish({ value, cancelled: false }),
      (error) => finish({ error, cancelled: false })
    );
    poll = setInterval(() => {
      if (isCancelled()) finish({ cancelled: true });
    }, 100);
  });
}

function nextFrame(raf, isCancelled) {
  const frame = new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    try {
      const pending = raf(finish);
      if (pending && typeof pending.then === 'function') pending.then(finish, finish);
    } catch (_) {
      finish();
    }
  });
  return settleWithCancellation(frame, isCancelled);
}

function defaultRaf(callback) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(callback, 0);
}

function defaultNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function isDefined(value) {
  if (typeof Cesium.defined === 'function') return Cesium.defined(value);
  return value !== undefined && value !== null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.floor(sorted.length / 2)].toFixed(3);
}
