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
// R3（P1.1・レビュー指摘の修正）で強化したもの:
//   - キャンセルの徹底: 先読みの全経路（warm-up のバッチ待機・prepareTiles・フォールバック分岐）で
//     isCancelled を見る。キャンセル済みならカメラを一切動かさずに抜ける
//   - 非公開APIの防御: 同期 `pickFromRay` にも機能検出を入れ、`excludeFeatures` は実行時に絞り込む
//   - `boostTilesetCache` の参照カウント化（先に抜けた側が復元してしまうレースの解消）
//   - `floorHeights` の入力を厳格パース（null/空文字を数値0として通さない）＋縮退建物の判定
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
/**
 * 建物の包絡（_zmax − _zmin）として妥当とみなす最小の高さ（m）。
 * これ未満は縮退した（不正な）包絡とみなし、階数の内挿をやめて一般地点仕様へ落とす。
 * 1.0m 以上あれば上限クランプ `zmax − ROOF_CLEARANCE` が必ず zmin を上回る。
 */
export const BUILDING_MIN_SPAN = 1.0;
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
/** キャンセル判定用の番兵 */
const CANCELLED = Symbol('cancelled');

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

/**
 * 数値プロパティの厳格パーサー。数値と数字文字列だけを受け付け、それ以外は null。
 *
 * `Number()` 任せにすると `null`・`''`・`true`・`[]` がいずれも 0 や 1 になり、
 * 「属性が無い」ことと「値が0である」ことを区別できなくなる（P1レビュー指摘）。
 * @param {unknown} value
 * @returns {number|null}
 */
function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 階数プロパティの値を 1..60 の整数として解釈する。解釈できなければ null */
function parseStoreys(value) {
  const n = parseNumber(value);
  if (n === null || !Number.isInteger(n)) return null;
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
 *       F = 階数プロパティ（1..60の整数）。無ければ min(60, max(1, round((zmax−zmin)/4.0))) で推定
 *       perFloor = (zmax − zmin) / F
 *       h(k) = min(zmin + 1.2 + perFloor×(k−1), zmax − 0.3)   （k = 1..F）
 *       h(屋上) = zmax + 1.2
 *       並びは「屋上 → F階 → … → 1階」（UIのセレクタ順）
 *   - 建物だが zmin/zmax が欠損、または包絡が縮退（zmax − zmin < 1.0m）:
 *     一般地点仕様へフォールバック（base を使う。fallback:true）
 *
 * 数値は `parseNumber` で厳格に解釈する（`null`・空文字は 0 ではなく「欠損」）。
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
  const zmin = parseNumber(params.zmin);
  const zmax = parseNumber(params.zmax);
  // 縮退した包絡（高さ1m未満）は内挿しても意味がないので一般地点仕様へ落とす
  const hasEnvelope =
    kind === 'building' && zmin !== null && zmax !== null && zmax - zmin >= BUILDING_MIN_SPAN;

  if (!hasEnvelope) {
    const baseRaw = parseNumber(params.base);
    const base = baseRaw !== null ? baseRaw : (zmin !== null ? zmin : DEFAULT_BASE_HEIGHT);
    const maxRaw = parseNumber(params.maxFloors);
    const count = maxRaw !== null && Number.isInteger(maxRaw) && maxRaw >= 1
      ? Math.min(maxRaw, BUILDING_FLOOR_MAX)
      : GROUND_FLOOR_MAX;
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
      zmin,
      zmax,
      floorCount: count,
      perFloor: GROUND_FLOOR_HEIGHT,
      estimated: false,
      fallback: kind === 'building',
      floors,
    };
  }

  const storeys = parseStoreys(params.storeys);
  const estimated = storeys === null;
  // 推定時も階数プロパティと同じ上限（60階）でクランプする
  const floorCount = estimated
    ? Math.min(BUILDING_FLOOR_MAX, Math.max(1, Math.round((zmax - zmin) / FLOOR_ESTIMATE_DIVISOR)))
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
    // 上限は屋上面の直下（ROOF_CLEARANCE）。包絡は1.0m以上あるので zmin を下回ることはない
    const h = Math.min(zmin + EYE_HEIGHT + perFloor * (k - 1), zmax - ROOF_CLEARANCE);
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
 *
 * キャンセル済み（`isCancelled()` が true）ならカメラを一切動かさずに false を返す。
 * 待機中にキャンセルされた場合もタイマーと `allTilesLoaded` の購読を即時解除して抜ける。
 *
 * @param {(()=>boolean)|null} [isCancelled]
 */
export function prepareTiles(viewer, tileset, lon, lat, timeoutMs = 10000, isCancelled = null) {
  const cancelledNow = () => {
    try { return !!(isCancelled && isCancelled()); } catch (_) { return false; }
  };
  return new Promise((resolve) => {
    // カメラを動かす前に必ず確認する（キャンセル後に視点を奪わない）
    if (cancelledNow()) return resolve(false);
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 400),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-60),
        roll: 0,
      },
    });
    if (!tileset) return resolve(false);

    let done = false;
    let timer = null;
    let poll = null;
    let onLoaded = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (onLoaded) {
        try { tileset.allTilesLoaded.removeEventListener(onLoaded); } catch (_) { /* noop */ }
      }
      clearTimeout(timer);
      clearInterval(poll);
      resolve(ok);
    };
    // 待機中のキャンセルも監視する（放置された先読みで待たせない）
    if (isCancelled) poll = setInterval(() => { if (cancelledNow()) finish(false); }, 200);

    if (tileset.tilesLoaded) {
      // すでに読み込み済みでも、視点移動後の追加読み込みを少し待つ
      timer = setTimeout(() => finish(true), 1500);
      return;
    }
    onLoaded = () => {
      // 全体タイムアウトを「読み込み完了から500ms」に置き換える
      clearTimeout(timer);
      timer = setTimeout(() => finish(true), 500);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
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
  // 方位は円環なので 355度 と 5度 が同じバケットになるよう折り返す（360→0）
  const buckets = Math.max(1, Math.round(360 / azimuthStepDeg));
  for (const d of solarKeyDates(year)) {
    for (const h of hours) {
      const p = sunPosition(jstDate(d.year, d.month, d.day, h, 0), lon, lat);
      if (!(p.elevationDeg >= minElevationDeg)) continue;
      const bucket = Math.round(p.azimuthDeg / azimuthStepDeg) % buckets;
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
 *          isCancelled?:(()=>boolean)|null, concurrency?:number,
 *          excludeFeatures?:Array<object>}} [opts]
 *   excludeFeatures: `pickFromRayMostDetailed` の objectsToExclude に渡すフィーチャ
 *                    （自建物の除外。`feature.primitive` を渡すとタイルセット全体が消えるので
 *                     フィーチャのみ渡すこと）
 * @returns {Promise<object>} 実行結果
 *   （supported/rays/attempted/resolved/failed/hits/ms/timedOut/cancelled/error）
 *   rays: 計画した本数 / attempted: 実際に発射した本数
 */
export async function warmUpSunPath(scene, origin, opts = {}) {
  const {
    year = new Date().getFullYear(),
    timeoutMs = WARM_UP_TIMEOUT_MS,
    cameraSettleMs = CAMERA_SETTLE_MS,
    isCancelled = null,
    concurrency = WARM_UP_CONCURRENCY,
    excludeFeatures = [],
  } = opts;

  const info = {
    supported: false,
    rays: 0,
    attempted: 0,
    resolved: 0,
    failed: 0,
    hits: 0,
    ms: 0,
    timedOut: false,
    cancelled: false,
    error: null,
  };
  const started = nowMs();
  // キャンセルは「実行中バッチの解決待ち」より優先させる（レース用の番兵Promise）
  const cancel = cancelSignal(isCancelled);

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
    // カメラ停止待ち（最大2.5秒）でレイの予算が目減りしないよう、待機後に締切を確定する
    const deadline = nowMs() + timeoutMs;
    // 自建物の除外はフィーチャのみ（primitive を渡すとタイルセット全体が除外される）
    const excludeList = (Array.isArray(excludeFeatures) ? excludeFeatures : [])
      .filter((f) => f && typeof f.getProperty === 'function');
    const objectsToExclude = excludeList.length ? excludeList : undefined;

    for (let i = 0; i < dirs.length; i += concurrency) {
      if (isCancelled && isCancelled()) { info.cancelled = true; break; }
      const remaining = deadline - nowMs();
      if (remaining <= 0) { info.timedOut = true; break; }

      const slice = dirs.slice(i, i + concurrency);
      const batch = slice.map((d) => {
        try {
          const ray = new Cesium.Ray(originEcef, sunDirectionEcef(enu, d.azimuthDeg, d.elevationDeg));
          return Promise.resolve(scene.pickFromRayMostDetailed(ray, objectsToExclude));
        } catch (e) {
          return Promise.reject(e);
        }
      });
      info.attempted += slice.length;
      // タイムアウトともキャンセルともraceする（放置された先読みを待たない）
      const settled = await withTimeout(Promise.allSettled(batch), remaining, cancel.promise);
      if (settled === CANCELLED) { info.cancelled = true; break; }
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
    console.warn('太陽経路ウォームアップに失敗しました', e);
  } finally {
    cancel.stop();
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
 * キャンセルは warm-up 復帰直後とカメラ移動の直前で必ず再確認する。
 * キャンセル済みなら `cancelled:true` を返してカメラを一切動かさない。
 *
 * @param {{fly?:boolean, isCancelled?:(()=>boolean)|null, year?:number,
 *          originHeight?:number|null, excludeFeatures?:Array<object>}} [opts]
 *   originHeight:    warm-upのレイ原点（絶対高、m）。省略時は baseHeight + EYE_HEIGHT
 *   excludeFeatures: warm-upのレイから除外するフィーチャ（自建物。P2で使う）
 * @returns {Promise<{method:'warmUpSunPath'|'prepareTiles'|'none', ok:boolean,
 *                    warmUp:object|null, fallbackReason:string|null, cancelled:boolean, ms:number}>}
 */
export async function preloadForSunlight(viewer, tileset, lon, lat, baseHeight, opts = {}) {
  const { fly = true, isCancelled = null, year, originHeight = null, excludeFeatures = [] } = opts;
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
  const cancelledNow = () => {
    try { return !!(isCancelled && isCancelled()); } catch (_) { return false; }
  };
  /** 早期returnの共通処理（所要の記録） */
  const finish = () => {
    out.ms = Math.round(nowMs() - started);
    return out;
  };

  const warm = await warmUpSunPath(viewer?.scene, { lon, lat, height }, {
    year,
    isCancelled,
    excludeFeatures,
    // 建物クリック（fly=false）ではカメラは静止しているので待たない
    cameraSettleMs: fly ? CAMERA_SETTLE_MS : 0,
  });
  out.warmUp = warm;

  // warm-up 復帰直後に再確認する。ここを抜けるとカメラを動かす分岐に入りうる
  if (warm.cancelled || cancelledNow()) {
    out.cancelled = true;
    return finish();
  }
  if (warm.supported && warm.resolved > 0) {
    out.ok = true;
    return finish();
  }
  if (warm.supported && warm.rays === 0) {
    // 発射すべき方向が1本も無い（＝先読みできていない）。カメラ移動でも改善しないので注記に回す
    out.method = 'none';
    out.fallbackReason = 'ウォームアップの対象となる太陽方向がありませんでした';
    return finish();
  }

  out.fallbackReason = !warm.supported
    ? (warm.error || 'pickFromRayMostDetailed が利用できません')
    : warm.timedOut
      ? 'ウォームアップがタイムアウトしました'
      : 'ウォームアップのレイが1本も解決しませんでした';
  if (fly) {
    // カメラを動かす直前にもう一度確認する（キャンセル後の視点強奪を防ぐ）
    if (cancelledNow()) {
      out.cancelled = true;
      return finish();
    }
    out.method = 'prepareTiles';
    try {
      out.ok = await prepareTiles(viewer, tileset, lon, lat, undefined, isCancelled);
    } catch (e) {
      console.warn('周辺タイルの先読み（従来方式）に失敗しました', e);
      out.ok = false;
    }
    if (cancelledNow()) out.cancelled = true;
  } else {
    // カメラを勝手に動かさない場面ではフォールバックしない（先読みなしで計算する）
    out.method = 'none';
  }
  return finish();
}

// 引き上げ中の状態（参照カウント方式。モジュールスコープで1つだけ持つ）
let cacheBoostDepth = 0;
let cacheBoostTileset = null;
let cacheBoostOriginal = null;

/**
 * 計算中だけタイルキャッシュ上限を引き上げる。
 * 戻り値の関数を try/finally で必ず呼んで元に戻すこと。
 *
 * 参照カウント方式（R3 P1.1）: 引き上げ区間が重なっても、最後の1つが抜けるまで復元しない。
 * 単純な no-op ガードだと「先に抜けた側が復元し、まだ計算中の側がブーストなしになる」
 * レースが起きるため。日影マップ（P3）からも同じ関数を使って区間を入れ子にできる。
 *
 * @param {object|null} tileset Cesium3DTileset
 * @param {number} [bytes] 引き上げ後の上限（バイト）
 * @returns {() => void} 復元関数（多重呼び出し安全）
 */
export function boostTilesetCache(tileset, bytes = SUNLIGHT_CACHE_BYTES) {
  if (!tileset) return () => {};
  // 別のタイルセットが引き上げ中（建物レイヤー切替の途中など）なら、そちらの復元を壊さない
  if (cacheBoostDepth > 0 && cacheBoostTileset !== tileset) return () => {};

  if (cacheBoostDepth === 0) {
    let original;
    try {
      original = tileset.cacheBytes;
      // 既に十分大きい（＝外部で引き上げ済み）なら触らない
      if (!Number.isFinite(original) || original >= bytes) return () => {};
      tileset.cacheBytes = bytes;
    } catch (e) {
      console.warn('タイルキャッシュ上限の引き上げに失敗しました', e);
      return () => {};
    }
    cacheBoostTileset = tileset;
    cacheBoostOriginal = original;
  }
  cacheBoostDepth++;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    cacheBoostDepth--;
    if (cacheBoostDepth > 0) return; // まだ計算中の区間が残っている
    const ts = cacheBoostTileset;
    const original = cacheBoostOriginal;
    cacheBoostTileset = null;
    cacheBoostOriginal = null;
    try {
      if (ts) ts.cacheBytes = original;
    } catch (e) {
      console.warn('タイルキャッシュ上限の復元に失敗しました', e);
    }
  };
}

/** テスト用: 引き上げ中の入れ子の深さ（0なら復元済み） */
export function tilesetCacheBoostDepth() {
  return cacheBoostDepth;
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
  // 自建物の除外はフィーチャのみ通す（primitive や null が混ざるとタイルセット全体が消える/例外になる）
  const feats = (Array.isArray(excludeFeatures) ? excludeFeatures : [])
    .filter((f) => f && typeof f.getProperty === 'function');
  const ents = Array.isArray(excludeEntities) ? excludeEntities : [];
  // 除外対象は毎回同じ配列を使い回す（pickFromRay の第2引数）
  const objectsToExclude = feats.length ? [...ents, ...feats] : ents;

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

  // 非公開APIなので同期版にも機能検出を通す（未対応環境では1本も飛ばさずに理由を返す）
  const pickSupported = !!scene && typeof scene.pickFromRay === 'function';

  for (const d of dates) {
    if (cancelled || !pickSupported) break;
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

  if (onProgress && !cancelled && pickSupported) onProgress(1);

  // 判定順が重要: pickエラー多発は「太陽高度が足りない」より先に評価する。
  // 全本数が例外になると raysCast は 0 のままなので、順序を逆にすると原因を取り違える。
  let error = null;
  if (cancelled) {
    error = null;
  } else if (!pickSupported) {
    error = 'この描画環境ではレイキャスト（pickFromRay）が利用できないため日照を計算できません';
  } else if (pickErrors > raysCast * 0.5) {
    error = 'レイキャストに失敗しました（描画環境の制限の可能性があります）';
  } else if (raysCast === 0) {
    error = '太陽高度が5度以上になる時間帯がありませんでした';
  }

  return {
    days,
    error,
    raysCast,
    pickErrors,
    pickSupported,
    hourStart: HOUR_START,
    hourEnd: HOUR_END,
    cancelled,
    originHeight: eyeHeight,
    excludedFeatures: feats.length,
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

/**
 * promise が ms 以内に解決しなければ TIMED_OUT を返す（タイマーは必ず片付ける）。
 * cancelPromise を渡すと、そちらが先に解決したときは CANCELLED を返す。
 * @param {Promise<any>|null} [cancelPromise] cancelSignal().promise
 */
function withTimeout(promise, ms, cancelPromise = null) {
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  const racers = cancelPromise ? [promise, timeout, cancelPromise] : [promise, timeout];
  return Promise.race(racers).finally(() => clearTimeout(timer));
}

/**
 * `isCancelled()` が true になったら CANCELLED で解決する Promise を作る。
 * キャンセルはポーリングでしか観測できないので、待機側で race するための橋渡し。
 * 使い終わったら必ず `stop()` を呼んでタイマーを片付けること。
 *
 * @param {(()=>boolean)|null} isCancelled
 * @param {number} [pollMs]
 * @returns {{promise: Promise<symbol>, stop: () => void}}
 */
function cancelSignal(isCancelled, pollMs = 100) {
  if (typeof isCancelled !== 'function') {
    // 解決しないPromise（raceの結果に影響しない）
    return { promise: new Promise(() => {}), stop: () => {} };
  }
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setInterval(() => {
      let cancelled = false;
      try { cancelled = !!isCancelled(); } catch (_) { cancelled = false; }
      if (!cancelled) return;
      clearInterval(timer);
      timer = null;
      resolve(CANCELLED);
    }, pollMs);
  });
  return {
    promise,
    stop: () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

/** 位置の静止とみなす1回あたりの変化量（m） */
const CAMERA_STILL_POSITION_M = 0.05;
/** 姿勢の静止とみなす1回あたりの変化量（単位ベクトル成分の絶対値和。約0.006度） */
const CAMERA_STILL_ORIENTATION = 1e-4;

/** カメラの姿勢スナップショット（位置・視線方向・上方向） */
function cameraPose(camera) {
  const p = camera.positionWC;
  if (!p) return null;
  const d = camera.directionWC || camera.direction;
  const u = camera.upWC || camera.up;
  return {
    px: p.x, py: p.y, pz: p.z,
    dx: d?.x ?? 0, dy: d?.y ?? 0, dz: d?.z ?? 0,
    ux: u?.x ?? 0, uy: u?.y ?? 0, uz: u?.z ?? 0,
  };
}

/** 2つの姿勢が「静止」とみなせるか（位置だけでなく向きも見る） */
function cameraPoseStill(a, b) {
  if (!a || !b) return false;
  const dPos = Math.abs(a.px - b.px) + Math.abs(a.py - b.py) + Math.abs(a.pz - b.pz);
  if (!(dPos < CAMERA_STILL_POSITION_M)) return false;
  const dDir = Math.abs(a.dx - b.dx) + Math.abs(a.dy - b.dy) + Math.abs(a.dz - b.dz);
  const dUp = Math.abs(a.ux - b.ux) + Math.abs(a.uy - b.uy) + Math.abs(a.uz - b.uz);
  return dDir < CAMERA_STILL_ORIENTATION && dUp < CAMERA_STILL_ORIENTATION;
}

/**
 * カメラの移動が止まるのを待つ（最大 timeoutMs）。
 * moveEnd イベントに加えて位置・向きの変化も監視し、最初から静止していれば早く抜ける。
 * 向きを見ないと「その場で旋回中」を静止と誤検出する（P1レビュー指摘）。
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
      const pose = cameraPose(camera);
      if (!pose) return finish(false);
      if (cameraPoseStill(pose, last)) {
        stable++;
        if (stable >= 2) return finish(true);
      } else {
        stable = 0;
      }
      last = pose;
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
