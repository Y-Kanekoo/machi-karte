// 簡易日照シミュレーション
//
// 地点（既定は地表+1.2m）から太陽方向へレイを飛ばし、scene.pickFromRay で読み込み済みの
// 建物3D Tilesとの交差を調べる。交差なし＝日照。
//
// 精度の注記（UIにも表示する）:
//   - 画面に読み込み済みの建物タイルのみを考慮する簡易計算
//   - 地形は平面（楕円体）扱い。周辺の地形による遮蔽は考慮しない
//   - 太陽高度5度未満は日照時間に数えない
//
// R3（P1）で追加したもの:
//   - `floorHeights`: 階数→レイ原点高さの変換（純関数。Cesium/DOM非依存でNode単体テスト対象）
//   - `warmUpSunPath`: カメラを動かさないタイル先読み（scene.pickFromRayMostDetailed）
//   - `preloadForSunlight`: 上記の機能検出＋従来方式（prepareTiles）へのフォールバック
//   - `estimateSunlight` の opts: originHeight / isCancelled / excludeFeatures と ms/本の計測
//   - `boostTilesetCache`: 計算中だけタイルキャッシュ上限を引き上げる（try/finallyで復元）
//
// 非公開API（pickFromRay 系）は機能検出と try/catch で必ず包み、失敗しても
// 診断そのものは続行する（graceful degradation）。

import { sampleDay, solarKeyDates, sunPosition, jstDate } from './solar.js';

const RAD = Math.PI / 180;

/** 太陽高度がこれ未満なら日照とみなさない（度） */
export const MIN_SUN_ELEVATION = 5;
/** 視点高さ（地表からの高さ、m） */
export const EYE_HEIGHT = 1.2;
/** 地面高さが取得できなかったときの既定値（中野駅周辺の実測 _zmin ≒ 33m に基づく） */
export const DEFAULT_BASE_HEIGHT = 35;

const SAMPLE_STEP_MIN = 20;
const HOUR_START = 7;
const HOUR_END = 17;

// ---- R3: 階数→高さ変換の定数 ---------------------------------------------------

/** 一般地点の1階あたりの高さ（m）。1階=地面+EYE_HEIGHT、以降 +3.0m/階 */
export const GROUND_FLOOR_HEIGHT = 3.0;
/**
 * 階数プロパティが無い建物の階数推定に使う除数（m/階）。
 * P0実測（2026-07-31）で `_zmax − _zmin` / 階数は 3.63〜6.06 m（中央値約4.6m）だった。
 * `_zmax` が屋上突起物を含むため 3.0m では階数を大幅に過大推定する。
 */
export const FLOOR_ESTIMATE_DIVISOR = 4.0;
/** 一般地点で選べる最大階数 */
export const GROUND_FLOOR_MAX = 15;
/** 階数プロパティとして妥当とみなす上限 */
export const BUILDING_FLOOR_MAX = 60;
/** 最上階のレイ原点が屋上面を突き抜けないためのクリアランス（m） */
export const ROOF_CLEARANCE = 0.3;
/** 地上階数プロパティの実名（P0実測。`地上階数` は実データに存在しない） */
export const STOREYS_PROPERTY = 'bldg:storeysAboveGround';

// ---- R3: 太陽経路ウォームアップの定数 ---------------------------------------------

/** ウォームアップで見る時刻（JST） */
export const WARM_UP_HOURS_JST = [8, 10, 12, 14, 16];
/** 同じ方位のレイを間引く粒度（度） */
export const WARM_UP_AZIMUTH_STEP = 10;
/** ウォームアップの最大本数 */
export const WARM_UP_MAX_RAYS = 12;
/**
 * 同時に発射する本数。全本数を一度に投げると（連続クリック時に）多重に走るため、
 * 小さなバッチに分けてバッチ境界でキャンセルを見る。
 */
export const WARM_UP_CONCURRENCY = 4;
/** ウォームアップ全体のタイムアウト（ms） */
export const WARM_UP_TIMEOUT_MS = 15000;
/** flyTo との競合を避けるためにカメラの停止を待つ上限（ms） */
export const CAMERA_SETTLE_MS = 2500;
/**
 * 計算中だけ引き上げるタイルキャッシュ上限（バイト）。
 * P0実測で平常時から546〜743MB（既定 512MB 超過）を使っていたため 1GB とする。
 */
export const SUNLIGHT_CACHE_BYTES = 1024 * 1024 * 1024;

/** タイムアウト判定用の番兵 */
const TIMED_OUT = Symbol('timeout');

/**
 * ENU（東・北・上）方向ベクトルをECEFに変換したレイ方向を返す。
 * @param {object} enuMatrix Transforms.eastNorthUpToFixedFrame の結果
 * @param {number} azimuthDeg 北=0, 東=90
 * @param {number} elevationDeg
 */
function sunDirectionEcef(enuMatrix, azimuthDeg, elevationDeg) {
  const el = elevationDeg * RAD;
  const az = azimuthDeg * RAD;
  const dirEnu = new Cesium.Cartesian3(
    Math.cos(el) * Math.sin(az), // 東
    Math.cos(el) * Math.cos(az), // 北
    Math.sin(el)                 // 上
  );
  const ecef = Cesium.Matrix4.multiplyByPointAsVector(enuMatrix, dirEnu, new Cesium.Cartesian3());
  return Cesium.Cartesian3.normalize(ecef, ecef);
}

/**
 * 地点の地面高さを推定する。
 * 建物クリック時はその建物の `_zmin`、それ以外は sampleHeightMostDetailed、
 * どちらも取れなければ既定値。
 */
export async function estimateBaseHeight(viewer, lon, lat, pickedFeature) {
  if (pickedFeature) {
    try {
      const zmin = pickedFeature.getProperty('_zmin');
      const n = Number(zmin);
      if (Number.isFinite(n)) return { height: n, source: '建物の_zmin' };
    } catch (_) { /* 属性なし */ }
  }
  try {
    const carto = Cesium.Cartographic.fromDegrees(lon, lat);
    const results = await viewer.scene.sampleHeightMostDetailed([carto]);
    const h = results?.[0]?.height;
    if (Number.isFinite(h)) return { height: h, source: 'sampleHeightMostDetailed' };
  } catch (e) {
    console.warn('sampleHeightMostDetailed failed', e);
  }
  return { height: DEFAULT_BASE_HEIGHT, source: '既定値' };
}

// ---- R3 F3-1: 階数 → レイ原点の高さ（純関数） ---------------------------------------

/** 階数プロパティの値を 1..60 の整数として解釈する。解釈できなければ null */
function parseStoreys(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > BUILDING_FLOOR_MAX) return null;
  return n;
}

/**
 * 階数の選択肢とそれぞれのレイ原点高さ（絶対高、m）を返す。
 * Cesium/DOM非依存の純関数（Nodeで単体テストする）。
 *
 * 仕様（R3計画書 §3.1.1 ＋「P0後の設計確定」#3 #4）:
 *   - 一般地点 (kind='ground'): h(k) = base + 1.2 + 3.0×(k−1)  （k = 1..15、昇順）
 *   - 建物     (kind='building' かつ zmin/zmax あり):
 *       F = 階数プロパティ（1..60の整数）。無ければ max(1, round((zmax−zmin)/4.0)) で推定
 *       perFloor = (zmax − zmin) / F
 *       h(k) = min(zmin + 1.2 + perFloor×(k−1), zmax − 0.3)   （k = 1..F）
 *       h(屋上) = zmax + 1.2
 *       並びは「屋上 → F階 → … → 1階」（UIのセレクタ順）
 *   - 建物だが zmin/zmax が欠損: 一般地点仕様へフォールバック（base を使う）
 *
 * @param {'ground'|'building'} kind
 * @param {{base?:number, zmin?:number, zmax?:number, storeys?:number|string, maxFloors?:number}} params
 * @returns {{kind:string, base:number, zmin:number|null, zmax:number|null, floorCount:number,
 *            perFloor:number, estimated:boolean, fallback:boolean,
 *            floors:Array<{key:string, label:string, floor:number|null, height:number, isRoof:boolean}>}}
 *   estimated: 階数プロパティが無く高さから推定した場合 true（UI注記用）
 *   fallback : 建物として呼ばれたが zmin/zmax が使えず一般地点仕様になった場合 true
 */
export function floorHeights(kind, params = {}) {
  const zmin = Number(params.zmin);
  const zmax = Number(params.zmax);
  const hasEnvelope =
    kind === 'building' && Number.isFinite(zmin) && Number.isFinite(zmax) && zmax > zmin;

  if (!hasEnvelope) {
    const baseRaw = Number(params.base);
    const base = Number.isFinite(baseRaw)
      ? baseRaw
      : (Number.isFinite(zmin) ? zmin : DEFAULT_BASE_HEIGHT);
    const maxRaw = Number(params.maxFloors);
    const count = Number.isInteger(maxRaw) && maxRaw >= 1 ? maxRaw : GROUND_FLOOR_MAX;
    const floors = [];
    for (let k = 1; k <= count; k++) {
      floors.push({
        key: 'f' + k,
        label: `${k}階`,
        floor: k,
        height: base + EYE_HEIGHT + GROUND_FLOOR_HEIGHT * (k - 1),
        isRoof: false,
      });
    }
    return {
      kind: 'ground',
      base,
      zmin: Number.isFinite(zmin) ? zmin : null,
      zmax: Number.isFinite(zmax) ? zmax : null,
      floorCount: count,
      perFloor: GROUND_FLOOR_HEIGHT,
      estimated: false,
      fallback: kind === 'building',
      floors,
    };
  }

  const storeys = parseStoreys(params.storeys);
  const estimated = storeys === null;
  const floorCount = estimated
    ? Math.max(1, Math.round((zmax - zmin) / FLOOR_ESTIMATE_DIVISOR))
    : storeys;
  const perFloor = (zmax - zmin) / floorCount;

  // 並びは UI のセレクタ順（屋上 → 上階 → … → 1階）
  const floors = [{
    key: 'roof',
    label: '屋上',
    floor: null,
    height: zmax + EYE_HEIGHT,
    isRoof: true,
  }];
  for (let k = floorCount; k >= 1; k--) {
    // 上限は屋上面の直下（ROOF_CLEARANCE）。退化した建物では zmin を下回らせない
    const h = Math.max(zmin, Math.min(zmin + EYE_HEIGHT + perFloor * (k - 1), zmax - ROOF_CLEARANCE));
    floors.push({ key: 'f' + k, label: `${k}階`, floor: k, height: h, isRoof: false });
  }

  return {
    kind: 'building',
    base: zmin,
    zmin,
    zmax,
    floorCount,
    perFloor,
    estimated,
    fallback: false,
    floors,
  };
}

/**
 * 建物フィーチャから階数→高さ変換のパラメータを取り出して floorHeights を呼ぶ。
 * Cesium のフィーチャに触るのでここだけ非純粋（getProperty は try/catch で包む）。
 *
 * @param {object|null} picked Cesium3DTileFeature
 * @param {number} baseHeight フィーチャが無い/属性が欠けているときの地面高さ
 */
export function floorHeightsForFeature(picked, baseHeight) {
  if (!picked) return floorHeights('ground', { base: baseHeight });
  const prop = (name) => {
    try { return picked.getProperty(name); } catch (_) { return undefined; }
  };
  return floorHeights('building', {
    base: baseHeight,
    zmin: prop('_zmin'),
    zmax: prop('_zmax'),
    storeys: prop(STOREYS_PROPERTY),
  });
}

// ---- R3 F3-3: タイル先読み --------------------------------------------------------

/**
 * 対象地点の周辺タイルが読み込まれるのを待つ（v1.0からの従来方式）。
 * カメラを地点上空400mへ瞬間移動させるため視点が飛ぶ。
 * R3では `warmUpSunPath` が使えない環境のフォールバックとしてのみ使う。
 */
export function prepareTiles(viewer, tileset, lon, lat, timeoutMs = 10000) {
  return new Promise((resolve) => {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 400),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-60),
        roll: 0,
      },
    });
    if (!tileset) return resolve(false);
    if (tileset.tilesLoaded) {
      // すでに読み込み済みでも、視点移動後の追加読み込みを少し待つ
      setTimeout(() => resolve(true), 1500);
      return;
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { tileset.allTilesLoaded.removeEventListener(onLoaded); } catch (_) { /* noop */ }
      clearTimeout(timer);
      resolve(ok);
    };
    const onLoaded = () => setTimeout(() => finish(true), 500);
    const timer = setTimeout(() => finish(false), timeoutMs);
    tileset.allTilesLoaded.addEventListener(onLoaded);
  });
}

/**
 * ウォームアップで飛ばす太陽方向の一覧（純関数。Cesium非依存）。
 * 冬至・春分・夏至の 8/10/12/14/16時のうち太陽高度5度以上のものを、
 * 方位10度粒度で間引いて最大12本返す。低い太陽（冬至）を優先する。
 *
 * @returns {Array<{label:string, azimuthDeg:number, elevationDeg:number}>}
 */
export function sunPathWarmDirections(lon, lat, opts = {}) {
  const {
    year = new Date().getFullYear(),
    hours = WARM_UP_HOURS_JST,
    minElevationDeg = MIN_SUN_ELEVATION,
    azimuthStepDeg = WARM_UP_AZIMUTH_STEP,
    max = WARM_UP_MAX_RAYS,
  } = opts;
  const out = [];
  const seen = new Set();
  for (const d of solarKeyDates(year)) {
    for (const h of hours) {
      const p = sunPosition(jstDate(d.year, d.month, d.day, h, 0), lon, lat);
      if (!(p.elevationDeg >= minElevationDeg)) continue;
      const bucket = Math.round(p.azimuthDeg / azimuthStepDeg);
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      out.push({
        label: `${d.key}-${h}時`,
        azimuthDeg: p.azimuthDeg,
        elevationDeg: p.elevationDeg,
      });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * 太陽経路のウォームアップ。カメラを動かさずに、レイ経路上の最詳細タイルを
 * `scene.pickFromRayMostDetailed`（非公開API）で先読みさせる。
 *
 * @param {object} scene Cesium.Scene
 * @param {{lon:number, lat:number, height:number}} origin レイ原点（絶対高）
 * @param {{year?:number, timeoutMs?:number, cameraSettleMs?:number,
 *          isCancelled?:(()=>boolean)|null, concurrency?:number}} [opts]
 * @returns {Promise<object>} 実行結果（supported/rays/resolved/failed/ms/timedOut/cancelled/error）
 */
export async function warmUpSunPath(scene, origin, opts = {}) {
  const {
    year = new Date().getFullYear(),
    timeoutMs = WARM_UP_TIMEOUT_MS,
    cameraSettleMs = CAMERA_SETTLE_MS,
    isCancelled = null,
    concurrency = WARM_UP_CONCURRENCY,
  } = opts;

  const info = {
    supported: false,
    rays: 0,
    resolved: 0,
    failed: 0,
    hits: 0,
    ms: 0,
    timedOut: false,
    cancelled: false,
    error: null,
  };
  const started = nowMs();

  try {
    // 非公開APIなので機能検出を必ず通す
    if (!scene || typeof scene.pickFromRayMostDetailed !== 'function') {
      info.error = 'pickFromRayMostDetailed が利用できません';
      return info;
    }
    info.supported = true;

    const lon = Number(origin?.lon);
    const lat = Number(origin?.lat);
    const height = Number(origin?.height);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(height)) {
      info.error = 'ウォームアップの原点が不正です';
      return info;
    }

    // flyTo と描画負荷が競合しないよう、カメラが止まるのを待ってから始める
    if (cameraSettleMs > 0) await waitForCameraSettled(scene.camera, cameraSettleMs);
    if (isCancelled && isCancelled()) {
      info.cancelled = true;
      return info;
    }

    const dirs = sunPathWarmDirections(lon, lat, { year });
    info.rays = dirs.length;
    if (!dirs.length) return info;

    const originEcef = Cesium.Cartesian3.fromDegrees(lon, lat, height);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(originEcef);
    const deadline = started + timeoutMs;

    for (let i = 0; i < dirs.length; i += concurrency) {
      if (isCancelled && isCancelled()) { info.cancelled = true; break; }
      const remaining = deadline - nowMs();
      if (remaining <= 0) { info.timedOut = true; break; }

      const batch = dirs.slice(i, i + concurrency).map((d) => {
        try {
          const ray = new Cesium.Ray(originEcef, sunDirectionEcef(enu, d.azimuthDeg, d.elevationDeg));
          return Promise.resolve(scene.pickFromRayMostDetailed(ray));
        } catch (e) {
          return Promise.reject(e);
        }
      });
      const settled = await withTimeout(Promise.allSettled(batch), remaining);
      if (settled === TIMED_OUT) { info.timedOut = true; break; }
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          info.resolved++;
          if (r.value && r.value.position) info.hits++;
        } else {
          info.failed++;
        }
      }
    }
  } catch (e) {
    info.error = String(e?.message || e).slice(0, 200);
    console.warn('warmUpSunPath failed', e);
  } finally {
    info.ms = Math.round(nowMs() - started);
  }
  return info;
}

/**
 * 日照計算の前処理（タイル先読み）。
 * 既定は `warmUpSunPath`（カメラを動かさない）。機能検出に失敗した場合や
 * 1本も解決しなかった場合だけ、従来の `prepareTiles`（カメラ移動）へ落とす。
 * カメラを動かせない場面（建物クリック等、fly=false）では先読みなしで続行する。
 *
 * @returns {Promise<{method:'warmUpSunPath'|'prepareTiles'|'none', ok:boolean,
 *                    warmUp:object|null, fallbackReason:string|null, cancelled:boolean, ms:number}>}
 */
export async function preloadForSunlight(viewer, tileset, lon, lat, baseHeight, opts = {}) {
  const { fly = true, isCancelled = null, year, originHeight = null } = opts;
  const started = nowMs();
  const height = Number.isFinite(originHeight) ? originHeight : baseHeight + EYE_HEIGHT;
  const out = {
    method: 'warmUpSunPath',
    ok: false,
    warmUp: null,
    fallbackReason: null,
    cancelled: false,
    ms: 0,
  };

  const warm = await warmUpSunPath(viewer?.scene, { lon, lat, height }, {
    year,
    isCancelled,
    // 建物クリック（fly=false）ではカメラは静止しているので待たない
    cameraSettleMs: fly ? CAMERA_SETTLE_MS : 0,
  });
  out.warmUp = warm;

  if (warm.cancelled) {
    out.cancelled = true;
    out.ms = Math.round(nowMs() - started);
    return out;
  }
  if (warm.supported && (warm.resolved > 0 || warm.rays === 0)) {
    out.ok = true;
    out.ms = Math.round(nowMs() - started);
    return out;
  }

  out.fallbackReason = !warm.supported
    ? (warm.error || 'pickFromRayMostDetailed が利用できません')
    : warm.timedOut
      ? 'ウォームアップがタイムアウトしました'
      : 'ウォームアップのレイが1本も解決しませんでした';
  if (fly) {
    out.method = 'prepareTiles';
    try {
      out.ok = await prepareTiles(viewer, tileset, lon, lat);
    } catch (e) {
      console.warn('prepareTiles failed', e);
      out.ok = false;
    }
  } else {
    // カメラを勝手に動かさない場面ではフォールバックしない（先読みなしで計算する）
    out.method = 'none';
  }
  out.ms = Math.round(nowMs() - started);
  return out;
}

/**
 * 計算中だけタイルキャッシュ上限を引き上げる。
 * 戻り値の関数を try/finally で必ず呼んで元に戻すこと。
 * @returns {() => void} 復元関数（多重呼び出し安全）
 */
export function boostTilesetCache(tileset, bytes = SUNLIGHT_CACHE_BYTES) {
  if (!tileset) return () => {};
  let original;
  try {
    original = tileset.cacheBytes;
    // 既に十分大きい（＝別の計算が引き上げ中）なら触らない
    if (!Number.isFinite(original) || original >= bytes) return () => {};
    tileset.cacheBytes = bytes;
  } catch (e) {
    console.warn('cacheBytes の引き上げに失敗', e);
    return () => {};
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try { tileset.cacheBytes = original; } catch (e) { console.warn('cacheBytes の復元に失敗', e); }
  };
}

// ---- 日照計算 -------------------------------------------------------------------

/**
 * 日照時間を推定する。
 *
 * @param {object} viewer Cesium.Viewer
 * @param {object} tileset 建物の Cesium3DTileset（遮蔽物）
 * @param {number} lon @param {number} lat
 * @param {number} baseHeight 地面高さ(m)
 * @param {object} [opts]
 *   excludeEntities: pickFromRay の objectsToExclude に渡すEntity（診断ピン等）
 *   excludeFeatures: 同上のフィーチャ（自建物の除外。P0でフィーチャ単位の除外が効くことを確認済み。
 *                    `feature.primitive` を渡すとタイルセット全体が消えるのでフィーチャのみ渡すこと）
 *   originHeight:    レイ原点の絶対高(m)。省略時は baseHeight + EYE_HEIGHT
 *   isCancelled:     () => boolean。チャンク毎に確認し、true なら計算ループを中途離脱する
 *   year, onProgress(fraction)
 * @returns {Promise<{days: Array<{key,label,hours,slots:Array<{hourJst,lit,elevationDeg}>}>,
 *                    error: string|null, raysCast:number, cancelled:boolean,
 *                    msPerRayMean:number|null, msPerRayMedian:number|null}>}
 */
export async function estimateSunlight(viewer, tileset, lon, lat, baseHeight, opts = {}) {
  const {
    excludeEntities = [],
    excludeFeatures = [],
    originHeight = null,
    isCancelled = null,
    year = new Date().getFullYear(),
    onProgress = null,
  } = opts;

  const scene = viewer.scene;
  const eyeHeight = Number.isFinite(originHeight) ? originHeight : baseHeight + EYE_HEIGHT;
  const origin = Cesium.Cartesian3.fromDegrees(lon, lat, eyeHeight);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const ray = new Cesium.Ray(origin, new Cesium.Cartesian3());
  // 除外対象は毎回同じ配列を使い回す（pickFromRay の第2引数）
  const objectsToExclude = excludeFeatures.length
    ? [...excludeEntities, ...excludeFeatures]
    : excludeEntities;

  const dates = solarKeyDates(year);
  const days = [];
  let raysCast = 0;
  let pickErrors = 0;
  let cancelled = false;
  const rayMs = [];

  const total = dates.length * (((HOUR_END - HOUR_START) * 60) / SAMPLE_STEP_MIN + 1);
  let done = 0;

  const cancelledNow = () => {
    try { return !!(isCancelled && isCancelled()); } catch (_) { return false; }
  };

  for (const d of dates) {
    if (cancelled) break;
    const samples = sampleDay(d.year, d.month, d.day, lon, lat, {
      hourStart: HOUR_START,
      hourEnd: HOUR_END,
      stepMinutes: SAMPLE_STEP_MIN,
    });
    const slots = [];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      let lit = false;
      if (s.elevationDeg >= MIN_SUN_ELEVATION) {
        try {
          ray.direction = sunDirectionEcef(enu, s.azimuthDeg, s.elevationDeg);
          const t0 = nowMs();
          const hit = scene.pickFromRay(ray, objectsToExclude);
          rayMs.push(nowMs() - t0);
          raysCast++;
          // pickFromRay は交差時に {object, position} を返す。position があれば遮蔽されている。
          lit = !(Cesium.defined(hit) && Cesium.defined(hit.position));
        } catch (e) {
          pickErrors++;
          lit = false;
        }
      }
      slots.push({ hourJst: s.hourJst, lit, elevationDeg: s.elevationDeg });

      done++;
      // 数本ごとにフレームを譲ってUIをブロックしない
      if (i % 6 === 5) {
        // キャンセルされていたら結果を捨てるのではなく計算そのものを止める
        if (cancelledNow()) { cancelled = true; break; }
        if (onProgress) onProgress(done / total);
        await nextFrame();
        if (cancelledNow()) { cancelled = true; break; }
      }
    }
    if (cancelled) break;
    const litCount = slots.filter((x) => x.lit).length;
    days.push({
      key: d.key,
      label: d.label,
      dateLabel: `${d.month}/${d.day}`,
      hours: (litCount * SAMPLE_STEP_MIN) / 60,
      slots,
    });
  }

  if (onProgress && !cancelled) onProgress(1);

  let error = null;
  if (cancelled) {
    error = null;
  } else if (raysCast === 0) {
    error = '太陽高度が5度以上になる時間帯がありませんでした';
  } else if (pickErrors > raysCast * 0.5) {
    error = 'レイキャストに失敗しました（描画環境の制限の可能性があります）';
  }

  return {
    days,
    error,
    raysCast,
    pickErrors,
    hourStart: HOUR_START,
    hourEnd: HOUR_END,
    cancelled,
    originHeight: eyeHeight,
    excludedFeatures: excludeFeatures.length,
    msPerRayMean: mean(rayMs),
    msPerRayMedian: median(rayMs),
    msTotalRays: rayMs.length ? Math.round(rayMs.reduce((a, b) => a + b, 0)) : 0,
  };
}

// ---- 内部ユーティリティ -------------------------------------------------------------

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/** promise が ms 以内に解決しなければ TIMED_OUT を返す（タイマーは必ず片付ける） */
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * カメラの移動が止まるのを待つ（最大 timeoutMs）。
 * moveEnd イベントに加えて位置の変化も監視し、最初から静止していれば早く抜ける。
 * @returns {Promise<boolean>} 停止を確認できたら true
 */
function waitForCameraSettled(camera, timeoutMs) {
  return new Promise((resolve) => {
    if (!camera || !(timeoutMs > 0)) return resolve(false);
    let done = false;
    let timer = null;
    let poll = null;
    let last = null;
    let stable = 0;
    const finish = (settled) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      try { camera.moveEnd?.removeEventListener?.(onMoveEnd); } catch (_) { /* noop */ }
      resolve(settled);
    };
    const onMoveEnd = () => finish(true);
    try { camera.moveEnd?.addEventListener?.(onMoveEnd); } catch (_) { /* noop */ }
    poll = setInterval(() => {
      const p = camera.positionWC;
      if (!p) return finish(false);
      if (last && Math.abs(p.x - last.x) + Math.abs(p.y - last.y) + Math.abs(p.z - last.z) < 0.05) {
        stable++;
        if (stable >= 2) return finish(true);
      } else {
        stable = 0;
      }
      last = { x: p.x, y: p.y, z: p.z };
    }, 200);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function mean(arr) {
  if (!arr.length) return null;
  return +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3);
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.floor(s.length / 2)].toFixed(3);
}
