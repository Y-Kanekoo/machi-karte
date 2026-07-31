// 自治体対応表生成器の単体テスト
// 実行: node test/area-index.test.mjs
//
// 実カタログ抜粋fixtureだけを使い、ネットワークには接続しない。

import fs from 'node:fs';
import { check, equal, report } from './harness.mjs';
import { TILESETS, ZONING_TILES } from '../js/config.js';
import {
  buildAreaIndex,
  restoreUrl,
  URL_PREFIX,
} from '../scripts/build-area-index.mjs';

const fixture = JSON.parse(
  fs.readFileSync(
    new URL('./fixtures/plateau-catalog-sample.json', import.meta.url),
    'utf8',
  ),
);
const generatedAt = '2026-07-31T00:00:00.000Z';
const index = buildAreaIndex(fixture, { generatedAt });
const restore = (url) => restoreUrl(index.prefix, url);

console.log('--- トップレベルと自治体スキーマ ---');
equal('共通URLプレフィックス', index.prefix, URL_PREFIX);
equal('生成日時', index.generatedAt, generatedAt);
equal('fixtureの自治体数', index.count, 4);
equal('自治体数とareasのキー数が一致', Object.keys(index.areas).length, 4);
equal('建物がない親市は自治体一覧に含めない', index.areas['15100'], undefined);

const allowedAreaKeys = new Set([
  'name',
  'pref',
  'year',
  'b1',
  'b2',
  'b2n',
  'fld',
  'urf',
  'tran',
  'wtr',
]);
for (const [code, area] of Object.entries(index.areas)) {
  check(`${code}: nameは空でない文字列`, typeof area.name === 'string' && area.name.length > 0);
  check(`${code}: prefは空でない文字列`, typeof area.pref === 'string' && area.pref.length > 0);
  check(`${code}: yearは整数`, Number.isInteger(area.year));
  check(`${code}: b1は短縮URL`, typeof area.b1 === 'string' && !area.b1.startsWith('http'));
  check(`${code}: fldは配列`, Array.isArray(area.fld));
  check(`${code}: urfはオブジェクト`, area.urf && !Array.isArray(area.urf));
  check(
    `${code}: 未定義キーを含まない`,
    Object.keys(area).every((key) => allowedAreaKeys.has(key)),
  );
}

console.log('--- 13114 現行設定との移行等価性 ---');
const nakano = index.areas['13114'];
const generatedTilesetUrls = [
  nakano.b1,
  nakano.b2,
  nakano.b2n,
  ...nakano.fld.map(({ url }) => url),
  nakano.tran,
  nakano.wtr,
]
  .map(restore)
  .sort();
const currentTilesetUrls = Object.values(TILESETS).sort();
equal(
  'TILESETSの全URL群が完全一致',
  JSON.stringify(generatedTilesetUrls),
  JSON.stringify(currentTilesetUrls),
);

const generatedZoningUrls = Object.fromEntries(
  Object.entries(nakano.urf).map(([key, url]) => [key, restore(url)]),
);
const currentZoningUrls = Object.fromEntries(
  Object.entries(ZONING_TILES).map(([key, value]) => [key, value.url]),
);
equal(
  'ZONING_TILESの全URLがキー単位で完全一致',
  JSON.stringify(generatedZoningUrls),
  JSON.stringify(currentZoningUrls),
);

console.log('--- 正規化ルール ---');
check(
  '文字列lod="1"を数値変換してLOD1を抽出',
  restore(nakano.b1) === TILESETS.bldgLod1,
);
check(
  '文字列lod="2"を数値変換してLOD2を抽出',
  restore(nakano.b2) === TILESETS.bldgLod2,
);
check(
  '文字列lod="2"とtexture=falseからテクスチャなしを抽出',
  restore(nakano.b2n) === TILESETS.bldgLod2NoTex,
);
equal('中野区の洪水モデルは2河川に重複排除', nakano.fld.length, 2);
check(
  '同一河川のl1ではなくl2を採用',
  nakano.fld.some(({ url }) => restore(url) === TILESETS.fldArakawaL2) &&
    nakano.fld.every(({ url }) => !url.includes('_3dtiles_l1_')),
);

const mishima = index.areas['22206'];
equal('urfは指定3種以外を除外', Object.keys(mishima.urf).join(','), 'use');
equal('3D Tilesがないtranは省略', mishima.tran, undefined);
equal('LOD2がないb2は省略', mishima.b2, undefined);
check(
  '三島市の洪水モデルもl2を優先',
  mishima.fld.length === 1 && mishima.fld[0].url.includes('_3dtiles_l2_'),
);

console.log('--- 政令市の区への親市データマージ ---');
const niigataKita = index.areas['15101'];
equal('区名を自治体名に採用', niigataKita.name, '北区');
equal('区の年度は建物モデル由来', niigataKita.year, 2023);
check(
  '親市のfldをl2優先でマージ',
  niigataKita.fld.length === 1 &&
    niigataKita.fld[0].url.includes('_3dtiles_l2_'),
);
equal(
  '親市のurf 3種をマージ',
  Object.keys(niigataKita.urf).sort().join(','),
  'fire,height,use',
);
check('親市のtranをマージ', niigataKita.tran.includes('_tran_3dtiles_lod3/'));
check('親市のwtrをマージ', niigataKita.wtr.includes('_wtr_3dtiles_lod1/'));

console.log('--- URLプレフィックスの短縮と復元 ---');
const fixtureNakanoLod1 = fixture.datasets.find(
  ({ id }) => id === '13114_bldg_lod1',
).url;
check('生成値から共通プレフィックスを除去', !nakano.b1.startsWith(URL_PREFIX));
equal('prefixと生成値から元URLを復元', restore(nakano.b1), fixtureNakanoLod1);
equal('完全URLは二重にprefixを付けない', restoreUrl(URL_PREFIX, fixtureNakanoLod1), fixtureNakanoLod1);

console.log('--- 純粋関数としての決定性 ---');
equal(
  '同じfixtureと生成日時から同じJSONを生成',
  JSON.stringify(buildAreaIndex(fixture, { generatedAt })),
  JSON.stringify(index),
);

report('area-index.test.mjs');
