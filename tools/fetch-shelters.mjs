#!/usr/bin/env node
// 中野区オープンデータ（避難所・避難場所）のCSVを取得して data/shelters.geojson を生成する。
//
// 実行: npm run shelters
//
// このプロジェクトで唯一「前処理済みデータをリポジトリに同梱する」箇所（R2 §0）。
// 理由: (1) wagmapのリソースURLはID直打ちで恒久性の保証がない、
//       (2) 防災情報は外部サービス停止時にも表示できるべき、(3) e2eの安定性。
//
// 依存はNode標準のみ（fetch / node:fs）。devDependency は増やさない。
// 出典・ライセンス（CC BY 4.0）・取得日は生成物の metadata に必ず埋める。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, '..', 'data', 'shelters.geojson');

/**
 * 取得元。列名はCSVごとに違うので定数化しておく（列名が変わったら検証で落ちる）。
 * 3件とも東京都オープンデータカタログ（CKAN）経由の中野区データで、
 * license_id = CC-BY-4.0 を 2026-07-28 に API で確認済み。
 */
const SOURCES = [
  {
    type: 'quake',
    label: '震災時の避難所',
    url: 'https://www2.wagmap.jp/nakanodatamap/nakanodatamap/opendatafile/map_32/CSV/opendata_5000342.csv',
    dataset: '震災時の避難所一覧',
    nameCol: '避難所名称',
    addressCol: '住所',
    expected: 45,
  },
  {
    type: 'flood',
    label: '水害時避難所',
    url: 'https://www2.wagmap.jp/nakanodatamap/nakanodatamap/opendatafile/map_28/CSV/opendata_18000130.csv',
    dataset: '水害時避難所',
    nameCol: '名称',
    addressCol: '住所',
    expected: 44,
  },
  {
    type: 'wide',
    label: '広域避難場所',
    url: 'https://www2.wagmap.jp/nakanodatamap/nakanodatamap/opendatafile/map_32/CSV/opendata_6000680.csv',
    dataset: '広域避難場所',
    nameCol: 'NAME',
    addressCol: 'ADDRESS',
    expected: 13,
  },
];

const LON_COL = '経度';
const LAT_COL = '緯度';

/** 中野区を十分に覆う矩形。ここから外れた行は座標異常として除外する */
const BOUNDS = { west: 139.5, south: 35.6, east: 139.8, north: 35.8 };

// ---- CSV -------------------------------------------------------------------

/**
 * 引用符付きCSVをパースする（RFC4180の範囲。""によるエスケープに対応）。
 * 中野区のCSVは UTF-8 with BOM なので、呼び出し前にBOMを落としておくこと。
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // 末尾の空行を落とす
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** BOM除去 + ヘッダ行をキーにしたオブジェクト配列にする */
export function parseCsvRecords(text) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
  return { header, records };
}

// ---- 変換 -------------------------------------------------------------------

/**
 * 1ソース分のレコードを GeoJSON Feature に変換する。
 * 列名欠落・座標異常・名称空は warnings に積んで除外する（既存ファイルは壊さない）。
 * @returns {{features: object[], warnings: string[]}}
 */
export function toFeatures(src, records) {
  const features = [];
  const warnings = [];
  for (const [i, rec] of records.entries()) {
    const at = `${src.dataset} 行${i + 2}`;
    const name = rec[src.nameCol];
    if (name === undefined) {
      warnings.push(`${at}: 名称列「${src.nameCol}」がありません（列名の変更？）`);
      continue;
    }
    if (!name) { warnings.push(`${at}: 名称が空のため除外`); continue; }
    const lon = Number(rec[LON_COL]);
    const lat = Number(rec[LAT_COL]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      warnings.push(`${at}「${name}」: 経緯度が数値でないため除外 (${rec[LON_COL]}, ${rec[LAT_COL]})`);
      continue;
    }
    if (lon < BOUNDS.west || lon > BOUNDS.east || lat < BOUNDS.south || lat > BOUNDS.north) {
      warnings.push(`${at}「${name}」: 座標が中野区周辺の範囲外のため除外 (${lon}, ${lat})`);
      continue;
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [round6(lon), round6(lat)] },
      properties: {
        name,
        address: rec[src.addressCol] || '',
        type: src.type,
        typeLabel: src.label,
      },
    });
  }
  return { features, warnings };
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

// ---- メイン -----------------------------------------------------------------

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const all = [];
  const sources = [];
  let hasError = false;

  for (const src of SOURCES) {
    process.stdout.write(`取得中: ${src.dataset} … `);
    let text;
    try {
      const res = await fetch(src.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (e) {
      console.log('失敗');
      console.error(`  ✗ ${src.url} の取得に失敗: ${e.message}`);
      hasError = true;
      continue;
    }
    const { header, records } = parseCsvRecords(text);
    const { features, warnings } = toFeatures(src, records);
    console.log(`${features.length}件（CSV ${records.length}行）`);
    for (const w of warnings) console.warn('  ! ' + w);
    if (!features.length) {
      console.error(`  ✗ ${src.dataset} が0件です（列: ${header.join(', ')}）`);
      hasError = true;
      continue;
    }
    if (features.length !== src.expected) {
      console.warn(`  ! ${src.dataset} の件数が想定(${src.expected})と違います: ${features.length}件`);
    }
    all.push(...features);
    sources.push({
      dataset: src.dataset,
      type: src.type,
      label: src.label,
      url: src.url,
      count: features.length,
      retrieved: today,
    });
  }

  if (hasError) {
    console.error('\n取得または検証に失敗したソースがあるため、既存の shelters.geojson は更新しません。');
    process.exitCode = 1;
    return;
  }

  const geojson = {
    type: 'FeatureCollection',
    metadata: {
      generated: today,
      title: '中野区の避難所・避難場所',
      license: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.ja',
      attribution: '中野区オープンデータ（東京都オープンデータカタログサイト経由）',
      catalog: 'https://catalog.data.metro.tokyo.lg.jp/',
      note: '本ファイルは tools/fetch-shelters.mjs で上記CSVから生成した派生物です。'
        + '直線距離の目安表示に使うもので、開設状況は中野区の発表をご確認ください。',
      generator: 'tools/fetch-shelters.mjs',
      count: all.length,
      sources,
    },
    features: all,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(geojson, null, 1) + '\n', 'utf8');
  const kb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
  console.log(`\n書き出し: ${OUT_PATH}（${all.length}件 / ${kb}KB）`);
}

// import して parseCsv 等だけ使う場合は main を走らせない
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
