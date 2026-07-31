import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CATALOG_URL =
  'https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets';
export const URL_PREFIX = 'https://assets.cms.plateau.reearth.io/assets/';

const URF_TYPES = {
  UseDistrict: 'use',
  FirePreventionDistrict: 'fire',
  HeightControlDistrict: 'height',
};

function catalogRows(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (catalog && Array.isArray(catalog.datasets)) return catalog.datasets;
  throw new TypeError('カタログに datasets 配列がありません');
}

function areaCode(row) {
  return row.ward_code || row.city_code;
}

function isAreaCode(value) {
  return typeof value === 'string' && /^\d{5}$/.test(value);
}

function numericLod(row) {
  return Number(row.lod);
}

export function urlContainsAreaCode(url, code) {
  return typeof url === 'string'
    && isAreaCode(code)
    && new RegExp(`(?:^|[^0-9])${code}(?:[^0-9]|$)`).test(url);
}

function urlContainsYear(url, year) {
  return typeof url === 'string'
    && Number.isInteger(year)
    && new RegExp(`(?:^|[^0-9])${year}(?:[^0-9]|$)`).test(url);
}

function shortenUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('データセットURLが空です');
  }
  return url.startsWith(URL_PREFIX) ? url.slice(URL_PREFIX.length) : url;
}

export function restoreUrl(prefix, url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  if (/^https?:\/\//.test(url)) return url;
  return `${prefix}${url}`;
}

function groupRowsByArea(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const code = areaCode(row);
    if (!isAreaCode(code)) continue;
    const current = grouped.get(code) || [];
    current.push(row);
    grouped.set(code, current);
  }
  return grouped;
}

function sameDatasetSeries(row, baseRow) {
  if (areaCode(row) !== areaCode(baseRow)) return false;
  if (Number(row.year) !== Number(baseRow.year)) return false;
  if (row.city_code !== baseRow.city_code || row.ward_code !== baseRow.ward_code) return false;
  return !row.spec || !baseRow.spec || row.spec === baseRow.spec;
}

/**
 * 建物URLは自治体コード・年度・データセット種別をすべて照合する。
 * RESTカタログの直接URLが不整合な場合は、同じ行の公式複合URLを使用する。
 */
function buildingUrl(row, code, year) {
  const matches = (url) =>
    urlContainsAreaCode(url, code)
    && urlContainsYear(url, year)
    && /(?:^|[/_-])bldg(?:[/_-]|$)/.test(url);
  if (matches(row?.url)) return row.url;
  if (matches(row?.composite_url)) return row.composite_url;
  return null;
}

function buildingRow(rows, lod, texture, baseRow) {
  const code = areaCode(baseRow);
  const year = Number(baseRow.year);
  const candidates = rows
    .filter(
      (row) =>
        row.type_en === 'bldg'
        && row.format === '3D Tiles'
        && numericLod(row) === lod
        && row.texture === texture
        && sameDatasetSeries(row, baseRow),
    )
    .map((row) => ({ row, url: buildingUrl(row, code, year) }))
    .filter(({ url }) => url)
    .sort((left, right) => String(left.row.id).localeCompare(String(right.row.id)));
  return candidates[0] || null;
}

function floodLevel(row) {
  const idMatch = row.id?.match(/_l(\d+)$/);
  if (idMatch) return Number(idMatch[1]);
  const urlMatch = row.url?.match(/_3dtiles_l(\d+)(?:_|\/)/);
  return urlMatch ? Number(urlMatch[1]) : 0;
}

function floodKey(row) {
  return String(row.id || row.url).replace(/_l\d+$/, '');
}

function floodLabel(row) {
  return String(row.name || row.id)
    .replace(/^洪水浸水想定区域モデル\s*/, '')
    .replace(/(?:（[^（）]*）)+$/, '')
    .trim();
}

function floodTiles(rows) {
  const selected = new Map();
  for (const row of rows) {
    if (row.type_en !== 'fld' || row.format !== '3D Tiles') continue;
    const key = floodKey(row);
    const current = selected.get(key);
    if (!current || floodLevel(row) > floodLevel(current)) {
      selected.set(key, row);
    }
  }
  return [...selected.values()]
    .map((row) => ({ label: floodLabel(row), url: shortenUrl(row.url) }))
    .sort((left, right) => left.label.localeCompare(right.label, 'ja'));
}

function urfTiles(rows) {
  const urf = {};
  for (const [type, key] of Object.entries(URF_TYPES)) {
    const row = rows.find(
      (candidate) =>
        candidate.type_en === 'urf' &&
        candidate.format === 'MVT' &&
        candidate.id?.includes(`_urf_${type}`),
    );
    if (row) urf[key] = shortenUrl(row.url);
  }
  return urf;
}

function highestLodTile(rows, type) {
  const candidates = rows
    .filter((row) => row.type_en === type && row.format === '3D Tiles')
    .sort((left, right) => numericLod(right) - numericLod(left));
  return candidates[0] ? shortenUrl(candidates[0].url) : null;
}

function buildArea(baseRow, ownRows, parentRows, { includeDisplayName = true } = {}) {
  const year = Number(baseRow.year);
  const ownCode = areaCode(baseRow);
  const parentCode = baseRow.ward_code ? baseRow.city_code : ownCode;
  const matchesAncillary = (row, code) =>
    row.type_en !== 'bldg'
    && Number(row.year) === year
    && urlContainsAreaCode(row.url, code)
    && urlContainsYear(row.url, year);
  const ancillaryRows = [
    ...ownRows.filter((row) => matchesAncillary(row, ownCode)),
    ...parentRows.filter((row) => matchesAncillary(row, parentCode)),
  ];
  const b1 = buildingRow(ownRows, 1, true, baseRow);
  const b2 = buildingRow(ownRows, 2, true, baseRow);
  const b2n = buildingRow(ownRows, 2, false, baseRow);
  if (!b1) {
    throw new Error(`${areaCode(baseRow)}: 一致する建物LOD1 URLがありません`);
  }
  const fld = floodTiles(ancillaryRows);
  const urf = urfTiles(ancillaryRows);
  const tran = highestLodTile(ancillaryRows, 'tran');
  const wtr = highestLodTile(ancillaryRows, 'wtr');
  const area = {
    name: baseRow.ward || baseRow.city,
    pref: baseRow.pref,
    year: Number.isFinite(year) ? year : null,
    b1: shortenUrl(b1.url),
  };
  if (includeDisplayName && baseRow.ward) {
    area.parentName = baseRow.city;
    area.displayName = `${baseRow.city} ${baseRow.ward}`;
  }

  if (b2) area.b2 = shortenUrl(b2.url);
  if (b2n) area.b2n = shortenUrl(b2n.url);
  area.fld = fld;
  area.urf = urf;
  if (tran) area.tran = tran;
  if (wtr) area.wtr = wtr;
  return area;
}

/**
 * RESTカタログからブラウザ同梱用の自治体対応表を生成する。
 * 既定出力は内容だけから算出したcontentHashを持ち、同じ入力では完全に同じ結果になる。
 * generatedAtオプションは既存テスト用の旧スキーマ互換であり、CLI出力では使用しない。
 */
export function buildAreaIndex(catalog, options = {}) {
  const legacyGeneratedAt = Object.prototype.hasOwnProperty.call(options, 'generatedAt');
  const rows = catalogRows(catalog);
  const grouped = groupRowsByArea(rows);
  const baseCandidates = rows
    .filter(
      (row) =>
        row.type_en === 'bldg' &&
        row.format === '3D Tiles' &&
        numericLod(row) === 1 &&
        row.texture === true &&
        isAreaCode(areaCode(row)) &&
        buildingUrl(row, areaCode(row), Number(row.year)),
    );
  const basesByCode = new Map();
  for (const row of baseCandidates) {
    const code = areaCode(row);
    const current = basesByCode.get(code);
    if (
      !current
      || Number(row.year) > Number(current.year)
      || (
        Number(row.year) === Number(current.year)
        && String(row.id).localeCompare(String(current.id)) < 0
      )
    ) {
      basesByCode.set(code, row);
    }
  }
  const baseRows = [...basesByCode.values()]
    .sort((left, right) => areaCode(left).localeCompare(areaCode(right)));
  const areas = {};

  for (const baseRow of baseRows) {
    const code = areaCode(baseRow);
    const ownRows = grouped.get(code) || [];
    const parentRows = baseRow.ward_code
      ? (grouped.get(baseRow.city_code) || [])
      : [];
    areas[code] = buildArea(baseRow, ownRows, parentRows, {
      includeDisplayName: !legacyGeneratedAt,
    });
  }

  const core = {
    prefix: URL_PREFIX,
    count: Object.keys(areas).length,
    areas,
  };
  const contentHash = createHash('sha256')
    .update(JSON.stringify(core))
    .digest('hex');
  return {
    prefix: core.prefix,
    contentHash,
    ...(legacyGeneratedAt ? { generatedAt: options.generatedAt } : {}),
    count: core.count,
    areas: core.areas,
  };
}

/**
 * 生成結果の件数と、全自治体の建物URLに含まれる自治体コードを検証する。
 */
export function validateAreaIndex(areaIndex, { sanityMin = 400 } = {}) {
  if (!Number.isInteger(sanityMin) || sanityMin < 0) {
    throw new Error('sanityMinには0以上の整数を指定してください');
  }
  if (!areaIndex || areaIndex.count !== Object.keys(areaIndex.areas || {}).length) {
    throw new Error('自治体数とareasの件数が一致しません');
  }
  if (areaIndex.count < sanityMin) {
    throw new Error(`自治体数が下限を下回りました: ${areaIndex.count} < ${sanityMin}`);
  }

  let checked = 0;
  for (const [code, area] of Object.entries(areaIndex.areas)) {
    for (const key of ['b1', 'b2', 'b2n']) {
      if (!area[key]) continue;
      checked += 1;
      const url = restoreUrl(areaIndex.prefix, area[key]);
      if (!urlContainsAreaCode(url, code)) {
        throw new Error(`${code}: ${key}のURL内自治体コードが一致しません: ${url}`);
      }
    }
  }
  return { areas: areaIndex.count, buildingUrls: checked };
}

export async function fetchCatalog(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetch関数が利用できません');
  }
  const response = await fetchImpl(CATALOG_URL, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`カタログ取得に失敗しました: HTTP ${response.status}`);
  }
  return response.json();
}

function parseArgs(argv) {
  const options = {
    out: 'data/area-index.json',
    sanityMin: 400,
    sanity: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--out には出力先を指定してください');
      }
      options.out = value;
      index += 1;
    } else if (arg === '--sanity-min') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--sanity-min には自治体数の下限を指定してください');
      }
      options.sanityMin = Number(value);
      index += 1;
    } else if (arg === '--no-sanity') {
      options.sanity = false;
    } else {
      throw new Error(`未対応の引数です: ${arg}`);
    }
  }
  if (!options.out) throw new Error('--out の出力先が空です');
  if (!Number.isInteger(options.sanityMin) || options.sanityMin < 0) {
    throw new Error('--sanity-min には0以上の整数を指定してください');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`PLATEAUカタログをGETします: ${CATALOG_URL}`);
  const catalog = await fetchCatalog();
  const areaIndex = buildAreaIndex(catalog);
  if (options.sanity) {
    const sanity = validateAreaIndex(areaIndex, { sanityMin: options.sanityMin });
    console.log(
      `sanity確認: ${sanity.areas}自治体 / 建物URL ${sanity.buildingUrls}件の自治体コードが一致`,
    );
  } else {
    console.warn('sanity確認を--no-sanityで無効化しました');
  }

  const outputPath = path.resolve(options.out);
  const json = `${JSON.stringify(areaIndex, null, 2)}\n`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, json, 'utf8');
  console.log(
    `自治体対応表を生成しました: ${areaIndex.count}自治体 / ${Buffer.byteLength(json)} B / ${outputPath}`,
  );
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(`生成に失敗しました: ${error.message}`);
    process.exitCode = 1;
  });
}
