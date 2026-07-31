import { mkdir, writeFile } from 'node:fs/promises';
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

function buildingRow(rows, lod, texture) {
  return rows.find(
    (row) =>
      row.type_en === 'bldg' &&
      row.format === '3D Tiles' &&
      numericLod(row) === lod &&
      row.texture === texture,
  );
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

function buildArea(baseRow, ownRows, parentRows) {
  const ancillaryRows = [
    ...ownRows.filter((row) => row.type_en !== 'bldg'),
    ...parentRows.filter((row) => row.type_en !== 'bldg'),
  ];
  const b1 = buildingRow(ownRows, 1, true);
  const b2 = buildingRow(ownRows, 2, true);
  const b2n = buildingRow(ownRows, 2, false);
  const year = Number(baseRow.year);
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
 * generatedAtを引数で受け取るため、同じ入力に対して同じ結果を返す。
 */
export function buildAreaIndex(catalog, { generatedAt = null } = {}) {
  const rows = catalogRows(catalog);
  const grouped = groupRowsByArea(rows);
  const baseRows = rows
    .filter(
      (row) =>
        row.type_en === 'bldg' &&
        row.format === '3D Tiles' &&
        numericLod(row) === 1 &&
        row.texture === true &&
        isAreaCode(areaCode(row)),
    )
    .sort((left, right) => areaCode(left).localeCompare(areaCode(right)));
  const areas = {};

  for (const baseRow of baseRows) {
    const code = areaCode(baseRow);
    const ownRows = grouped.get(code) || [];
    const parentRows = baseRow.ward_code
      ? (grouped.get(baseRow.city_code) || [])
      : [];
    areas[code] = buildArea(baseRow, ownRows, parentRows);
  }

  return {
    prefix: URL_PREFIX,
    generatedAt,
    count: Object.keys(areas).length,
    areas,
  };
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
    sanityMin: 0,
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
  const areaIndex = buildAreaIndex(catalog, {
    generatedAt: new Date().toISOString(),
  });
  if (areaIndex.count < options.sanityMin) {
    throw new Error(
      `自治体数が下限を下回りました: ${areaIndex.count} < ${options.sanityMin}`,
    );
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
