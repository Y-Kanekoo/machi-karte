// 自治体対応表から実行時設定を組み立てる動的リゾルバ層

import {
  DEFAULT_CITY,
  AREA_INDEX_URL,
  GEOCODE_URL,
  TILESETS,
  ZONING_TILES,
  PRESETS,
  AREA_RECT,
} from './config.js';

const CITY_CODE_PATTERN = /^\d{5}$/;
const ZONING_KEYS = ['use', 'fire', 'height'];
const SPOTS_URL = 'data/spots.json';
const RAD_TO_DEG = 180 / Math.PI;

/**
 * URLから自治体コードを読む。
 * ハッシュにcityがある場合は、値が不正でもクエリより優先する。
 */
export function parseCityCode(location) {
  const hash = new URLSearchParams(
    String(location?.hash || '').replace(/^#\??/, ''),
  );
  const query = new URLSearchParams(String(location?.search || ''));
  const value = hash.has('city')
    ? hash.get('city')
    : query.has('city')
      ? query.get('city')
      : DEFAULT_CITY;
  return typeof value === 'string' && CITY_CODE_PATTERN.test(value)
    ? value
    : null;
}

/**
 * 同梱の自治体対応表を読み込む。
 * オフラインや不正JSONでも起動を止めず、呼び出し側の静的フォールバックへ委ねる。
 */
export async function loadAreaIndex() {
  try {
    const response = await fetch(AREA_INDEX_URL, {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.warn('自治体対応表を読み込めませんでした', error);
    return null;
  }
}

/**
 * 同梱の自治体別スポットを読み込む。
 * 失敗時はnullを返し、中野区はconfig.js、その他は実行時フォールバックへ委ねる。
 */
export async function loadSpots() {
  try {
    const response = await fetch(SPOTS_URL, {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.warn('スポットプリセットを読み込めませんでした', error);
    return null;
  }
}

function restoreUrl(prefix, value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^https?:\/\//.test(value)) return value;
  return typeof prefix === 'string' ? `${prefix}${value}` : null;
}

function zoningConfig(prefix, urf, key) {
  const url = restoreUrl(prefix, urf[key]);
  if (!url) return null;
  return {
    url,
    z: ZONING_TILES[key].z,
    label: ZONING_TILES[key].label,
  };
}

function clonePresets() {
  return Object.fromEntries(
    Object.entries(PRESETS).map(([key, value]) => [key, { ...value }]),
  );
}

function cloneAreaPresets(spots, code) {
  const presets = spots?.[code];
  if (!presets || typeof presets !== 'object' || Array.isArray(presets)) return null;
  const entries = Object.entries(presets)
    .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
    .map(([key, value]) => [key, { ...value }]);
  return entries.length ? Object.fromEntries(entries) : null;
}

/**
 * 自治体対応表の1件を、アプリが参照するAreaConfigへ変換する純粋関数。
 */
export function resolveArea(index, code, spots = null) {
  const area = index?.areas?.[code];
  if (!area) return null;

  const prefix = index.prefix;
  const fld = Array.isArray(area.fld)
    ? area.fld.map(({ label, url }) => ({
      label,
      url: restoreUrl(prefix, url),
    }))
    : [];
  const urf = area.urf && typeof area.urf === 'object' ? area.urf : {};

  return {
    code,
    name: area.name,
    pref: area.pref,
    year: area.year,
    tilesets: {
      bldgLod1: restoreUrl(prefix, area.b1),
      bldgLod2: restoreUrl(prefix, area.b2),
      bldgLod2NoTex: restoreUrl(prefix, area.b2n),
      fld,
      tranLod3: restoreUrl(prefix, area.tran),
      wtrLod1: restoreUrl(prefix, area.wtr),
    },
    zoning: Object.fromEntries(
      ZONING_KEYS.map((key) => [key, zoningConfig(prefix, urf, key)]),
    ),
    presets: cloneAreaPresets(spots, code)
      || (code === DEFAULT_CITY ? clonePresets() : null),
    rect: code === DEFAULT_CITY ? { ...AREA_RECT } : null,
    groundHeight: code === DEFAULT_CITY ? 35 : null,
  };
}

/**
 * bldg tileset.json のroot regionから自治体矩形を取り出す。
 * regionは [west,south,east,north,minHeight,maxHeight]（角度はradian）。
 */
export function areaRect(tilesetJson) {
  const region = tilesetJson?.root?.boundingVolume?.region;
  if (!Array.isArray(region) || region.length < 6) return null;
  const radians = region.slice(0, 4).map(Number);
  if (!radians.every(Number.isFinite)) return null;
  const [west, south, east, north] = radians.map((value) => value * RAD_TO_DEG);
  if (west >= east || south >= north) return null;
  return { west, south, east, north };
}

function regionMetadata(tilesetJson) {
  const rect = areaRect(tilesetJson);
  const region = tilesetJson?.root?.boundingVolume?.region;
  if (!rect || !Array.isArray(region)) return null;
  const groundHeight = Number(region[4]);
  return {
    rect,
    groundHeight: Number.isFinite(groundHeight) ? groundHeight : null,
  };
}

function overviewPreset(rect) {
  if (!rect) return null;
  const lon = (rect.west + rect.east) / 2;
  const lat = (rect.south + rect.north) / 2;
  const widthMeters = Math.abs(rect.east - rect.west)
    * 111_000 * Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const heightMeters = Math.abs(rect.north - rect.south) * 111_000;
  return {
    label: '全体',
    lon,
    lat,
    height: Math.max(1500, widthMeters, heightMeters) * 1.5,
    heading: 0,
    pitch: -70,
  };
}

async function officePreset(areaConfig) {
  try {
    const query = `${areaConfig.name}役所`;
    const response = await fetch(`${GEOCODE_URL}?q=${encodeURIComponent(query)}`);
    if (!response.ok) return null;
    const features = await response.json();
    if (!Array.isArray(features)) return null;
    const feature = features.find(
      (item) => String(item?.properties?.addressCode || '') === areaConfig.code
        && Array.isArray(item?.geometry?.coordinates),
    );
    if (!feature) return null;
    const lon = Number(feature.geometry.coordinates[0]);
    const lat = Number(feature.geometry.coordinates[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return {
      label: '役所',
      lon,
      lat,
      height: 500,
      heading: 0,
      pitch: -45,
    };
  } catch (error) {
    console.warn(`${areaConfig.name}役所を検索できませんでした`, error);
    return null;
  }
}

/**
 * 非中野自治体の矩形・地盤高を建物tilesetから1回取得し、
 * spots.json未定義時は役所と全体のプリセットを実行時生成する。
 */
export async function enrichAreaConfig(areaConfig) {
  if (!areaConfig || areaConfig.code === DEFAULT_CITY) return areaConfig;

  let metadata = null;
  if (areaConfig.tilesets.bldgLod1) {
    try {
      const response = await fetch(areaConfig.tilesets.bldgLod1);
      if (response.ok) metadata = regionMetadata(await response.json());
    } catch (error) {
      console.warn('建物タイルセットの範囲を取得できませんでした', error);
    }
  }

  let presets = areaConfig.presets;
  if (!presets) {
    const [office, overview] = await Promise.all([
      officePreset(areaConfig),
      Promise.resolve(overviewPreset(metadata?.rect || null)),
    ]);
    presets = {};
    if (office) presets.office = office;
    if (overview) presets.overview = overview;
  }

  return {
    ...areaConfig,
    presets,
    rect: metadata?.rect || areaConfig.rect,
    groundHeight: metadata?.groundHeight ?? areaConfig.groundHeight,
  };
}

/**
 * 対応表を利用できない場合も中野区を起動できる静的フォールバック。
 */
export function buildNakanoFallback(spots = null) {
  return {
    code: DEFAULT_CITY,
    name: '中野区',
    pref: '東京都',
    year: 2025,
    tilesets: {
      bldgLod1: TILESETS.bldgLod1,
      bldgLod2: TILESETS.bldgLod2,
      bldgLod2NoTex: TILESETS.bldgLod2NoTex,
      fld: [
        { label: '荒川水系神田川流域', url: TILESETS.fldArakawaL2 },
        { label: '神田川流域', url: TILESETS.fldKandaL2 },
      ],
      tranLod3: TILESETS.tranLod3,
      wtrLod1: TILESETS.wtrLod1,
    },
    zoning: Object.fromEntries(
      ZONING_KEYS.map((key) => [key, { ...ZONING_TILES[key] }]),
    ),
    presets: cloneAreaPresets(spots, DEFAULT_CITY) || clonePresets(),
    rect: { ...AREA_RECT },
    groundHeight: 35,
  };
}
