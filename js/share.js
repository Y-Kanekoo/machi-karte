// 共有URL（診断パーマリンク）
//
// URLハッシュに診断状態を保存する。形式は URLSearchParams 互換:
//   #v=1&city={自治体コード}&spot={lon},{lat}&addr={住所}&cam={lon},{lat},{height},{heading},{pitch}&ov={use,fire,height}
//   #v=1&city={現在の自治体コード}&compare={lon},{lat};...                  （全地点が中野区）
//   #v=1&city={現在の自治体コード}&compare={自治体コード},{lon},{lat};...   （他エリアを含む）
// cityなしの比較地点は中野区（13114）として復元する。
//
// serializeState / parseHash は DOM・Cesium 非依存の純粋関数（Node単体テスト対象）。

import {
  OVERLAY_KEYS,
  COMPARE_MAX,
  JP_BOUNDS,
  DEFAULT_CITY,
} from './config.js';

/** ハッシュのスキーマバージョン。互換性のない変更時にインクリメントする */
export const SCHEMA_VERSION = 1;

/** 住所文字列の最大長（URL肥大とDoS的な入力を防ぐ） */
export const ADDR_MAX_LENGTH = 120;

const CITY_CODE_PATTERN = /^\d{5}$/;

/** 自治体コードとして受け付ける形式か */
export function isValidCityCode(city) {
  return typeof city === 'string' && CITY_CODE_PATTERN.test(city);
}

/** 日本国内の緯度経度か（NaN・範囲外の値をURLから受け取らないためのガード） */
export function isValidLonLat(lon, lat) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= JP_BOUNDS.west &&
    lon <= JP_BOUNDS.east &&
    lat >= JP_BOUNDS.south &&
    lat <= JP_BOUNDS.north
  );
}

function round6(v) {
  return Number(v.toFixed(6));
}

/** heading を 0〜359 に正規化する */
function normalizeHeading(h) {
  const n = Math.round(h) % 360;
  return n < 0 ? n + 360 : n;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * 状態オブジェクトをハッシュ文字列（先頭の `#` を含まない）へ直列化する。
 *
 * @param {{
 *   city?: string|null,
 *   spot?: {lon:number, lat:number}|null,
 *   addr?: string|null,
 *   cam?: {lon:number, lat:number, height:number, heading:number, pitch:number}|null,
 *   overlays?: string[]|null,
 *   compare?: Array<{city?:string, lon:number, lat:number}>|null,
 * }} state
 * @returns {string} 例 `v=1&spot=139.665900,35.705600`
 */
export function serializeState(state) {
  const s = state || {};
  const parts = [`v=${SCHEMA_VERSION}`];

  if (isValidCityCode(s.city)) {
    parts.push(`city=${s.city}`);
  }

  if (s.spot && isValidLonLat(Number(s.spot.lon), Number(s.spot.lat))) {
    parts.push(`spot=${round6(Number(s.spot.lon))},${round6(Number(s.spot.lat))}`);
  }

  if (s.addr) {
    const addr = String(s.addr).slice(0, ADDR_MAX_LENGTH);
    if (addr) parts.push(`addr=${encodeURIComponent(addr)}`);
  }

  if (s.cam && isValidLonLat(Number(s.cam.lon), Number(s.cam.lat))) {
    const height = Math.round(clamp(Number(s.cam.height) || 0, 0, 20000000));
    const heading = normalizeHeading(Number(s.cam.heading) || 0);
    const pitch = Math.round(clamp(Number(s.cam.pitch) || 0, -90, 90));
    parts.push(
      `cam=${round6(Number(s.cam.lon))},${round6(Number(s.cam.lat))},${height},${heading},${pitch}`
    );
  }

  if (Array.isArray(s.overlays)) {
    const ov = OVERLAY_KEYS.filter((k) => s.overlays.includes(k));
    if (ov.length) parts.push(`ov=${ov.join(',')}`);
  }

  if (Array.isArray(s.compare)) {
    const points = s.compare
      .filter((p) => p && isValidLonLat(Number(p.lon), Number(p.lat)))
      .slice(0, COMPARE_MAX)
      .map((p) => {
        const city = isValidCityCode(p.city) ? p.city : DEFAULT_CITY;
        return {
          city,
          pair: `${round6(Number(p.lon))},${round6(Number(p.lat))}`,
        };
      });
    if (points.length) {
      const legacyFormat = points.every((p) => p.city === DEFAULT_CITY);
      const pts = points.map((p) => legacyFormat ? p.pair : `${p.city},${p.pair}`);
      parts.push(`compare=${pts.join(';')}`);
    }
  }

  return parts.join('&');
}

function parsePair(text) {
  const parts = String(text).split(',');
  if (parts.length !== 2) return null;
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  return isValidLonLat(lon, lat) ? { lon, lat } : null;
}

function parseComparePoint(text) {
  const parts = String(text).split(',');
  if (parts.length === 2) {
    const point = parsePair(text);
    return point ? { city: DEFAULT_CITY, ...point } : null;
  }
  if (parts.length !== 3 || !isValidCityCode(parts[0])) return null;
  const point = parsePair(parts.slice(1).join(','));
  return point ? { city: parts[0], ...point } : null;
}

/**
 * ハッシュ文字列を状態オブジェクトへ復元する。
 * 解析できない・意味のある状態を含まない場合は null（呼び出し側は黙って無視する）。
 *
 * @param {string} hash `#v=1&spot=...` でも `v=1&spot=...` でもよい
 * @returns {{city, spot, addr, cam, overlays, compare}|null}
 */
export function parseHash(hash) {
  if (typeof hash !== 'string') return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;

  let q;
  try {
    q = new URLSearchParams(raw);
  } catch (_) {
    return null;
  }

  // 未知のスキーマバージョンは無視する（将来の形式を古いコードが誤読しないため）
  if (q.get('v') !== String(SCHEMA_VERSION)) return null;

  const requestedCity = q.get('city');
  const out = {
    city: isValidCityCode(requestedCity) ? requestedCity : DEFAULT_CITY,
    spot: null,
    addr: null,
    cam: null,
    overlays: [],
    compare: null,
  };

  if (q.has('spot')) out.spot = parsePair(q.get('spot'));

  const addr = q.get('addr');
  if (addr) out.addr = addr.slice(0, ADDR_MAX_LENGTH);

  if (q.has('cam')) {
    const nums = String(q.get('cam')).split(',').map(Number);
    if (nums.length === 5 && nums.every((n) => Number.isFinite(n))) {
      const [lon, lat, height, heading, pitch] = nums;
      if (isValidLonLat(lon, lat) && height > 0 && height <= 20000000 && pitch >= -90 && pitch <= 90) {
        out.cam = { lon, lat, height, heading: normalizeHeading(heading), pitch };
      }
    }
  }

  if (q.has('ov')) {
    const req = String(q.get('ov')).split(',');
    out.overlays = OVERLAY_KEYS.filter((k) => req.includes(k));
  }

  if (q.has('compare')) {
    const pts = String(q.get('compare'))
      .split(';')
      .map(parseComparePoint)
      .filter(Boolean)
      .slice(0, COMPARE_MAX);
    if (pts.length) out.compare = pts;
  }

  // spot / cam / compare のいずれも読めなければ復元する意味がない
  if (!out.spot && !out.cam && !out.compare) return null;
  return out;
}

/**
 * `?city=` を現在エリアの `#v=1&city=...` に正規化する。
 * 既存の共有状態があれば保持し、city以外のクエリパラメータは残す。
 */
export function normalizeCityQuery(locationLike, historyLike, city) {
  const query = new URLSearchParams(String(locationLike?.search || ''));
  if (!query.has('city')) return false;

  query.delete('city');
  const state = parseHash(String(locationLike?.hash || '')) || {};
  const hashBody = serializeState({
    ...state,
    city: isValidCityCode(city) ? city : DEFAULT_CITY,
  });
  const rest = query.toString();
  const path = `${String(locationLike?.pathname || '')}${rest ? `?${rest}` : ''}#${hashBody}`;
  historyLike.replaceState(null, '', path);
  return true;
}

/**
 * ハッシュ内のcityを実際に表示している自治体コードへ置き換える。
 * 対応表取得失敗や未対応コードのフォールバック後に、画面とURLを一致させるために使う。
 */
export function normalizeCityHash(
  locationLike,
  historyLike,
  city,
  { preserveState = true } = {},
) {
  const normalizedCity = isValidCityCode(city) ? city : DEFAULT_CITY;
  const state = preserveState
    ? (parseHash(String(locationLike?.hash || '')) || {})
    : {};
  const hashBody = serializeState({ ...state, city: normalizedCity });
  const path = `${String(locationLike?.pathname || '')}${String(locationLike?.search || '')}#${hashBody}`;
  historyLike.replaceState(null, '', path);
  return hashBody;
}

// ---- 以下はブラウザ用（DOM/Cesium 依存） -------------------------------------

/**
 * 共有ボタンの配線と、起動時のハッシュ復元を行う。
 *
 * @param {{
 *   viewer: object,
 *   diagnosis: object,   // initDiagnosis の戻り
 *   overlays: object,    // initZoningOverlay の戻り（省略可）
 *   compare: object,     // initCompare の戻り（省略可）
 *   toast: (msg:string) => void,
 * }} ctx
 */
export function initShare(ctx) {
  const {
    viewer,
    diagnosis,
    overlays = null,
    compare = null,
    toast,
    areaConfig = null,
  } = ctx;
  const btn = document.getElementById('shareBtn');

  /** 現在のカメラを serialize 用の形に落とす */
  function currentCamera() {
    try {
      const c = viewer.camera;
      const carto = c.positionCartographic;
      return {
        lon: Cesium.Math.toDegrees(carto.longitude),
        lat: Cesium.Math.toDegrees(carto.latitude),
        height: carto.height,
        heading: Cesium.Math.toDegrees(c.heading),
        pitch: Cesium.Math.toDegrees(c.pitch),
      };
    } catch (e) {
      console.warn('share: camera read failed', e);
      return null;
    }
  }

  /** 今の画面状態からハッシュ文字列を組み立てる */
  function buildHash() {
    const r = diagnosis.getLastResult();
    return serializeState({
      city: areaConfig?.code || DEFAULT_CITY,
      spot: r ? { lon: r.lon, lat: r.lat } : null,
      addr: r?.title || null,
      cam: currentCamera(),
      overlays: overlays ? overlays.getActive() : [],
    });
  }

  /** 現在状態をハッシュに書き込み、URL全体を返す（履歴は汚さない） */
  function applyHash(hashBody) {
    const url = `${location.origin}${location.pathname}${location.search}#${hashBody}`;
    try {
      history.replaceState(null, '', '#' + hashBody);
    } catch (e) {
      console.warn('share: replaceState failed', e);
      location.hash = hashBody;
    }
    return url;
  }

  async function copyLink() {
    const url = applyHash(buildHash());
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch (e) {
      console.warn('share: clipboard failed', e);
    }
    if (ok) {
      toast('リンクをコピーしました');
    } else {
      // 非HTTPS等でクリップボードが使えない環境向けのフォールバック
      try { window.prompt('このURLをコピーしてください', url); } catch (_) { /* noop */ }
      toast('URLを表示しました');
    }
    return url;
  }

  if (btn) btn.addEventListener('click', copyLink);

  /** 比較状態を共有するときのハッシュ（compare.js から呼ぶ） */
  function shareCompare(points) {
    const url = applyHash(serializeState({
      city: areaConfig?.code || DEFAULT_CITY,
      compare: points,
      cam: currentCamera(),
    }));
    return url;
  }

  /**
   * 起動時のハッシュ復元。
   * カメラ → オーバーレイ → 診断（または比較）の順に適用する。
   */
  async function restoreFromHash(hash = location.hash) {
    const state = parseHash(hash);
    if (!state) return null;
    if (state.city !== (areaConfig?.code || DEFAULT_CITY)) {
      console.warn(
        `share: city mismatch (${state.city} !== ${areaConfig?.code || DEFAULT_CITY})`,
      );
      return null;
    }

    if (state.cam) {
      try {
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(state.cam.lon, state.cam.lat, state.cam.height),
          orientation: {
            heading: Cesium.Math.toRadians(state.cam.heading),
            pitch: Cesium.Math.toRadians(state.cam.pitch),
            roll: 0,
          },
        });
      } catch (e) {
        console.warn('share: setView failed', e);
      }
    }

    if (overlays && state.overlays?.length) {
      for (const key of state.overlays) {
        try { overlays.setEnabled(key, true); } catch (e) { console.warn('share: overlay restore', e); }
      }
    }

    if (state.compare && compare) {
      await compare.restoreFromPoints(state.compare);
    } else if (state.spot) {
      // 住所は diagnose 側の renderPlace で escapeHtml を通してから DOM に入る
      await diagnosis.runDiagnosisAt(state.spot.lon, state.spot.lat, {
        title: state.addr || null,
        fly: !state.cam,
      });
    }
    return state;
  }

  return { copyLink, buildHash, restoreFromHash, shareCompare, currentCamera };
}
