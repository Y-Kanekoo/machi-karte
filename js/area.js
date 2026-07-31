// 自治体対応表から実行時設定を組み立てる動的リゾルバ層

import {
  DEFAULT_CITY,
  AREA_INDEX_URL,
  TILESETS,
  ZONING_TILES,
  PRESETS,
  AREA_RECT,
} from './config.js';

const CITY_CODE_PATTERN = /^\d{5}$/;
const ZONING_KEYS = ['use', 'fire', 'height'];

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

/**
 * 自治体対応表の1件を、アプリが参照するAreaConfigへ変換する純粋関数。
 */
export function resolveArea(index, code) {
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
    presets: code === DEFAULT_CITY ? clonePresets() : null,
    rect: code === DEFAULT_CITY ? { ...AREA_RECT } : null,
    groundHeight: code === DEFAULT_CITY ? 35 : null,
  };
}

/**
 * 対応表を利用できない場合も中野区を起動できる静的フォールバック。
 */
export function buildNakanoFallback() {
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
    presets: clonePresets(),
    rect: { ...AREA_RECT },
    groundHeight: 35,
  };
}
