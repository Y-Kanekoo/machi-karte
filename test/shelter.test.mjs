// shelter.js の単体テスト（Node直接実行・ブラウザ不要）
// 実行: node test/shelter.test.mjs
//
// 同梱の data/shelters.geojson をそのまま読んで検証する（外部通信なし）。
// 期待値は R2計画書 §3.3 の表。2026-07-28 に tools/fetch-shelters.mjs で再生成した
// データに対して再確認済み。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, equal, near, report } from './harness.mjs';
import { parseShelters, nearestShelter, formatDistance } from '../js/shelter.js';
import { parseCsv, parseCsvRecords, toFeatures } from '../tools/fetch-shelters.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const geojson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'shelters.geojson'), 'utf8')
);

// ---- 1. 同梱GeoJSONの中身 -----------------------------------------------------

console.log('--- data/shelters.geojson ---');
equal('FeatureCollection', geojson.type, 'FeatureCollection');
equal('件数は102件', geojson.features.length, 102);
equal('metadata.count が件数と一致', geojson.metadata?.count, geojson.features.length);
equal('ライセンスはCC BY 4.0', geojson.metadata?.license, 'CC BY 4.0');
check('出典表記がある', /中野区/.test(geojson.metadata?.attribution || ''), geojson.metadata?.attribution);
check('生成日がYYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(geojson.metadata?.generated || ''),
  geojson.metadata?.generated);
equal('出典URLが3件', geojson.metadata?.sources?.length, 3);
check('全出典にURLと取得日がある',
  (geojson.metadata?.sources || []).every((s) => /^https:\/\//.test(s.url) && /^\d{4}-\d{2}-\d{2}$/.test(s.retrieved)),
  JSON.stringify(geojson.metadata?.sources?.map((s) => [s.url, s.retrieved])));

const shelters = parseShelters(geojson);
equal('parseSheltersで102件', shelters.length, 102);
const byType = {};
for (const s of shelters) byType[s.type] = (byType[s.type] || 0) + 1;
equal('震災時は45件', byType.quake, 45);
equal('水害時は44件', byType.flood, 44);
equal('広域は13件', byType.wide, 13);
check('全件に名称がある', shelters.every((s) => !!s.name));
check('全件が中野区周辺の座標',
  shelters.every((s) => s.lon > 139.5 && s.lon < 139.8 && s.lat > 35.6 && s.lat < 35.8));
// 同名施設が複数種別にある場合もマージしない（§3.4-4）
check('南台小学校は震災時・水害時の両方にある',
  shelters.filter((s) => s.name === '南台小学校').length >= 2,
  JSON.stringify(shelters.filter((s) => s.name === '南台小学校').map((s) => s.type)));

console.log('--- parseShelters の頑健性 ---');
equal('空オブジェクトは空配列', parseShelters({}).length, 0);
equal('nullは空配列', parseShelters(null).length, 0);
equal('座標欠落は除外',
  parseShelters({ features: [{ properties: { name: 'x' }, geometry: null }] }).length, 0);
equal('名称なしは除外',
  parseShelters({ features: [{ properties: {}, geometry: { coordinates: [139.6, 35.7] } }] }).length, 0);

// ---- 2. nearestShelter（§3.3の実測表） ------------------------------------------

console.log('--- nearestShelter（R2 §3.3 の実測値、±5m） ---');
function nearestAt(lon, lat, type) {
  return nearestShelter(shelters, lon, lat, type);
}

{
  const r = nearestAt(139.673935, 35.691502, 'quake');
  equal('弥生町二丁目の最寄り震災時避難所', r?.name, '第二中学校');
  near('弥生町二丁目の距離は約261m', r?.distance, 261, 5);
}
{
  const r = nearestAt(139.66893, 35.707859, 'quake');
  equal('中野五丁目の最寄り震災時避難所', r?.name, '大妻中野中学校･高等学校');
  near('中野五丁目の距離は約311m', r?.distance, 311, 5);
}
{
  const r = nearestAt(139.635, 35.725, 'quake');
  equal('鷺宮の最寄り震災時避難所', r?.name, '鷺の杜小学校');
  near('鷺宮の距離は約121m', r?.distance, 121, 5);
}
{
  const r = nearestAt(139.663, 35.688, 'quake');
  equal('南台五丁目の最寄り震災時避難所', r?.name, '南台小学校');
  near('南台五丁目の距離は約440m', r?.distance, 440, 5);
}
{
  const r = nearestAt(139.673935, 35.691502, 'flood');
  equal('弥生町二丁目の最寄り水害時避難所', r?.name, '中野本郷小学校');
  near('弥生町二丁目（水害時）の距離は約522m', r?.distance, 522, 5);
}

console.log('--- nearestShelter の性質 ---');
check('種別で絞り込まれる', nearestAt(139.663, 35.688, 'flood')?.type === 'flood');
check('広域避難場所も引ける', !!nearestAt(139.66893, 35.707859, 'wide'));
equal('存在しない種別はnull', nearestAt(139.66, 35.70, 'nosuch'), null);
equal('空配列はnull', nearestShelter([], 139.66, 35.70, 'quake'), null);
equal('座標がNaNならnull', nearestShelter(shelters, NaN, 35.70, 'quake'), null);
{
  // 避難所そのものの座標で引けば距離0・その避難所自身になる
  const s = shelters.find((x) => x.type === 'quake');
  const r = nearestShelter(shelters, s.lon, s.lat, 'quake');
  equal('避難所の座標では距離0', Math.round(r.distance), 0);
  equal('避難所の座標ではその避難所', r.name, s.name);
}
{
  // 全件を総当たりして最小であることを確認（線形走査の正しさ）
  const lon = 139.6659, lat = 35.7056;
  const r = nearestAt(lon, lat, 'quake');
  const minD = Math.min(
    ...shelters.filter((s) => s.type === 'quake')
      .map((s) => Math.hypot((s.lon - lon) * Math.cos(lat * Math.PI / 180), s.lat - lat))
  );
  const rd = Math.hypot((r.lon - lon) * Math.cos(lat * Math.PI / 180), r.lat - lat);
  near('中野駅の最寄りが全件中の最小', rd, minD, 1e-12);
}

console.log('--- formatDistance ---');
equal('440m', formatDistance(440), '約440m');
equal('261m→260m（10m丸め）', formatDistance(261), '約260m');
equal('999m', formatDistance(999), '約1000m');
equal('1200m→1.2km', formatDistance(1234), '約1.2km');
equal('NaNは―', formatDistance(NaN), '―');
equal('nullは―', formatDistance(null), '―');

// ---- 3. CSVパーサ（tools/fetch-shelters.mjs） ------------------------------------

console.log('--- CSVパーサ ---');
equal('単純な2行', JSON.stringify(parseCsv('a,b\n1,2\n')), JSON.stringify([['a', 'b'], ['1', '2']]));
equal('引用符つきフィールド',
  JSON.stringify(parseCsv('"a,1","b"\n')), JSON.stringify([['a,1', 'b']]));
equal('""によるエスケープ',
  JSON.stringify(parseCsv('"a""b",c\n')), JSON.stringify([['a"b', 'c']]));
equal('引用符内の改行',
  JSON.stringify(parseCsv('"a\nb",c\n')), JSON.stringify([['a\nb', 'c']]));
equal('CRLFを扱える',
  JSON.stringify(parseCsv('a,b\r\n1,2\r\n')), JSON.stringify([['a', 'b'], ['1', '2']]));
equal('空行は落とす', parseCsv('a,b\n\n1,2\n').length, 2);
{
  // UTF-8 BOM を落としてヘッダをキーにできること
  const { header, records } = parseCsvRecords('﻿"名称","経度","緯度"\n"A","139.6","35.7"\n');
  equal('BOMを除去したヘッダ', header[0], '名称');
  equal('レコード数', records.length, 1);
  equal('レコードの値', records[0]['名称'], 'A');
}

console.log('--- toFeatures の検証（異常行の除外） ---');
{
  const src = { type: 'quake', label: '震災時の避難所', dataset: 'test', nameCol: '名称', addressCol: '住所' };
  const { features, warnings } = toFeatures(src, [
    { 名称: '正常', 住所: '中野区中野1-1', 経度: '139.66', 緯度: '35.70' },
    { 名称: '', 住所: 'x', 経度: '139.66', 緯度: '35.70' },
    { 名称: '座標が数値でない', 住所: 'x', 経度: 'abc', 緯度: '35.70' },
    { 名称: '範囲外（大阪）', 住所: 'x', 経度: '135.5', 緯度: '34.7' },
  ]);
  equal('正常な1件だけ残る', features.length, 1);
  equal('警告が3件', warnings.length, 3);
  equal('typeが入る', features[0].properties.type, 'quake');
  equal('typeLabelが入る', features[0].properties.typeLabel, '震災時の避難所');
  equal('GeoJSONのPoint', features[0].geometry.type, 'Point');
  equal('座標は[lon,lat]の順', JSON.stringify(features[0].geometry.coordinates), '[139.66,35.7]');
}
{
  // 列名が変わったら全件除外＋警告（＝生成スクリプトが異常を検知できる）
  const src = { type: 'quake', label: 'x', dataset: 'test', nameCol: '避難所名称', addressCol: '住所' };
  const { features, warnings } = toFeatures(src, [{ 名称: 'A', 経度: '139.66', 緯度: '35.70' }]);
  equal('列名不一致で0件', features.length, 0);
  check('列名変更の警告が出る', warnings[0].includes('避難所名称'), warnings[0]);
}

report('shelter.test.mjs');
