#!/usr/bin/env node
// 不動産情報ライブラリAPI（国土交通省）から取引価格を取得し、
// data/price-<city>.json（静的スナップショット）を生成する。
//
// 実行: REINFOLIB_API_KEY=<キー> npm run price-snapshot -- --city 13114
//       （--area は city の先頭2桁から自動決定。--max-back で遡る四半期数を変更可）
//
// なぜスナップショット方式か:
// 公式マニュアルが「CORS回避のためブラウザから直接リクエストしない」よう求めており、
// APIキーをクライアント側に埋め込むこともできないため。静的サイトでは
// 「サーバ側（このツール）で取得 → JSONを同梱配信」が唯一の正規ルートになる。
// shelters.geojson と同じ「前処理済みデータを同梱する」方針（R2 §0）に揃えた。
//
// APIキーは環境変数 REINFOLIB_API_KEY からのみ読む。リポジトリに書かないこと。
// キーが無い場合は何も生成せず、その旨を表示して正常終了する。
// 出典・取得日は生成物の metadata に必ず埋める。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchLatestTransactions,
  summarizeTransactions,
  resolveReinfolibApiKey,
} from '../js/reinfolib.js';
import { REINFOLIB_ATTRIBUTION } from '../js/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const city = arg('city');
if (!city || !/^\d{5}$/.test(city)) {
  console.error('使い方: npm run price-snapshot -- --city <5桁の自治体コード>');
  process.exit(1);
}
const area = arg('area', city.slice(0, 2));
const maxBack = Number(arg('max-back', '6'));

if (!resolveReinfolibApiKey()) {
  console.log(
    'REINFOLIB_API_KEY が未設定のため、スナップショットは生成しません。\n' +
      'APIキーは不動産情報ライブラリの利用申請（無料・審査あり）で取得できます:\n' +
      'https://www.reinfolib.mlit.go.jp/help/apiManual/'
  );
  process.exit(0);
}

const result = await fetchLatestTransactions({ area, city }, { maxBack });
if (!result.available || result.rows.length === 0) {
  console.error(`取引価格データが取得できませんでした（city=${city}, area=${area}）`);
  process.exit(1);
}

const snapshot = {
  metadata: {
    source: REINFOLIB_ATTRIBUTION,
    api: 'XIT001 不動産価格（取引価格・成約価格）情報取得API',
    city,
    area,
    year: result.year,
    quarter: result.quarter,
    fetchedAt: new Date().toISOString().slice(0, 10),
    count: result.rows.length,
  },
  summary: {
    all: summarizeTransactions(result.rows),
    condominium: summarizeTransactions(result.rows, { typeIncludes: 'マンション' }),
    land: summarizeTransactions(result.rows, { typeIncludes: '宅地' }),
  },
  rows: result.rows,
};

const outPath = path.join(__dirname, '..', 'data', `price-${city}.json`);
fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');
console.log(
  `生成しました: data/price-${city}.json（${result.year}年Q${result.quarter}、${result.rows.length}件）`
);
