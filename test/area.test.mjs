// 自治体動的リゾルバの単体テスト
// 実行: node test/area.test.mjs

import fs from 'node:fs';
import { check, equal, report } from './harness.mjs';
import {
  DEFAULT_CITY,
  AREA_INDEX_URL,
  TILESETS,
  ZONING_TILES,
  PRESETS,
  AREA_RECT,
} from '../js/config.js';
import {
  parseCityCode,
  resolveArea,
  buildNakanoFallback,
} from '../js/area.js';

const index = JSON.parse(
  fs.readFileSync(new URL('../data/area-index.json', import.meta.url), 'utf8'),
);
const nakano = resolveArea(index, '13114');

console.log('--- config追加定数 ---');
equal('既定自治体コードは中野区', DEFAULT_CITY, '13114');
equal('対応表URLは同梱JSON', AREA_INDEX_URL, 'data/area-index.json');

console.log('--- 13114 現行設定との移行等価性 ---');
check('中野区を解決できる', nakano !== null);
equal('自治体コード', nakano.code, '13114');
equal('自治体名', nakano.name, '中野区');
equal('都道府県名', nakano.pref, '東京都');
equal('年度', nakano.year, 2025);

const resolvedTilesetUrls = [
  nakano.tilesets.bldgLod1,
  nakano.tilesets.bldgLod2,
  nakano.tilesets.bldgLod2NoTex,
  ...nakano.tilesets.fld.map(({ url }) => url),
  nakano.tilesets.tranLod3,
  nakano.tilesets.wtrLod1,
].sort();
equal(
  'TILESETSの全URLが完全一致',
  JSON.stringify(resolvedTilesetUrls),
  JSON.stringify(Object.values(TILESETS).sort()),
);
equal('LOD1 URLが完全一致', nakano.tilesets.bldgLod1, TILESETS.bldgLod1);
equal('LOD2 URLが完全一致', nakano.tilesets.bldgLod2, TILESETS.bldgLod2);
equal(
  'LOD2テクスチャなしURLが完全一致',
  nakano.tilesets.bldgLod2NoTex,
  TILESETS.bldgLod2NoTex,
);
equal('洪水モデル数', nakano.tilesets.fld.length, 2);
equal(
  '洪水モデルURL群が完全一致',
  JSON.stringify(nakano.tilesets.fld.map(({ url }) => url).sort()),
  JSON.stringify([TILESETS.fldKandaL2, TILESETS.fldArakawaL2].sort()),
);
equal('交通URLが完全一致', nakano.tilesets.tranLod3, TILESETS.tranLod3);
equal('水部URLが完全一致', nakano.tilesets.wtrLod1, TILESETS.wtrLod1);

for (const key of ['use', 'fire', 'height']) {
  equal(
    `都市計画${key} URLが完全一致`,
    nakano.zoning[key].url,
    ZONING_TILES[key].url,
  );
  equal(`都市計画${key}ズーム`, nakano.zoning[key].z, ZONING_TILES[key].z);
  equal(
    `都市計画${key}ラベル`,
    nakano.zoning[key].label,
    ZONING_TILES[key].label,
  );
}
equal('プリセットが完全一致', JSON.stringify(nakano.presets), JSON.stringify(PRESETS));
equal('矩形が完全一致', JSON.stringify(nakano.rect), JSON.stringify(AREA_RECT));
equal('中野区の地盤高', nakano.groundHeight, 35);

console.log('--- 未知コードと欠損フィールド ---');
equal('未知コードはnull', resolveArea(index, '99999'), null);
equal('null対応表はnull', resolveArea(null, '13114'), null);

const sparseIndex = {
  prefix: 'https://example.test/assets/',
  areas: {
    '99998': {
      name: '欠損市',
      pref: '試験県',
      year: 2024,
      b1: 'bldg/tileset.json',
    },
    '99997': {
      name: '完全URL市',
      pref: '試験県',
      year: 2023,
      b1: 'https://cdn.example.test/bldg/tileset.json',
      fld: [
        {
          label: '試験河川',
          url: 'https://cdn.example.test/fld/tileset.json',
        },
      ],
      urf: {
        use: 'urf/{z}/{x}/{y}.mvt',
      },
    },
  },
};
const sparse = resolveArea(sparseIndex, '99998');
equal(
  '短縮URLにprefixを付ける',
  sparse.tilesets.bldgLod1,
  'https://example.test/assets/bldg/tileset.json',
);
equal('b2欠損はnull', sparse.tilesets.bldgLod2, null);
equal('b2n欠損はnull', sparse.tilesets.bldgLod2NoTex, null);
equal('fld欠損は空配列', JSON.stringify(sparse.tilesets.fld), '[]');
equal('urf欠損で用途地域はnull', sparse.zoning.use, null);
equal('urf欠損で防火地域はnull', sparse.zoning.fire, null);
equal('urf欠損で高度地区はnull', sparse.zoning.height, null);
equal('tranキー省略はnull', sparse.tilesets.tranLod3, null);
equal('wtrキー省略はnull', sparse.tilesets.wtrLod1, null);
equal('他自治体のプリセットはnull', sparse.presets, null);
equal('他自治体の矩形はnull', sparse.rect, null);
equal('他自治体の地盤高はnull', sparse.groundHeight, null);

const absolute = resolveArea(sparseIndex, '99997');
equal(
  '完全URLにはprefixを二重付与しない',
  absolute.tilesets.bldgLod1,
  'https://cdn.example.test/bldg/tileset.json',
);
equal(
  'fldの完全URLにもprefixを二重付与しない',
  absolute.tilesets.fld[0].url,
  'https://cdn.example.test/fld/tileset.json',
);
equal(
  'urfの短縮URLを復元する',
  absolute.zoning.use.url,
  'https://example.test/assets/urf/{z}/{x}/{y}.mvt',
);
equal('urfの省略キーはnull', absolute.zoning.fire, null);

console.log('--- citycodeの優先順とバリデーション ---');
equal(
  'パラメータなしは既定コード',
  parseCityCode({ hash: '', search: '' }),
  '13114',
);
equal(
  'クエリからcityを読む',
  parseCityCode({ hash: '', search: '?city=13113' }),
  '13113',
);
equal(
  'ハッシュはクエリより優先',
  parseCityCode({ hash: '#v=1&city=22206', search: '?city=13113' }),
  '22206',
);
equal(
  'city以外のハッシュならクエリを使う',
  parseCityCode({ hash: '#v=1&spot=x', search: '?city=13113' }),
  '13113',
);
equal(
  '不正なハッシュcityはクエリへ戻らずnull',
  parseCityCode({ hash: '#city=abcde', search: '?city=13113' }),
  null,
);
equal(
  '不正なクエリcityはnull',
  parseCityCode({ hash: '', search: '?city=abcde' }),
  null,
);
equal(
  '4桁コードはnull',
  parseCityCode({ hash: '', search: '?city=1311' }),
  null,
);
equal(
  '6桁コードはnull',
  parseCityCode({ hash: '#city=131140', search: '' }),
  null,
);
equal(
  '空のcityはnull',
  parseCityCode({ hash: '#city=', search: '' }),
  null,
);

console.log('--- 中野区の静的フォールバック ---');
const fallback = buildNakanoFallback();
equal(
  'フォールバックは対応表経由と完全一致',
  JSON.stringify(fallback),
  JSON.stringify(nakano),
);
equal('フォールバックのコード', fallback.code, '13114');
equal('フォールバックの地盤高', fallback.groundHeight, 35);
equal(
  'フォールバックの全URLが現行値と一致',
  JSON.stringify([
    fallback.tilesets.bldgLod1,
    fallback.tilesets.bldgLod2,
    fallback.tilesets.bldgLod2NoTex,
    ...fallback.tilesets.fld.map(({ url }) => url),
    fallback.tilesets.tranLod3,
    fallback.tilesets.wtrLod1,
  ].sort()),
  JSON.stringify(Object.values(TILESETS).sort()),
);

report('area.test.mjs');
