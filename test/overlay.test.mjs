// zoning-overlay.js の純粋関数（配色・座標変換）の単体テスト
// 実行: node test/overlay.test.mjs
//
// DOM・Cesium・ネットワークに触れない関数だけを対象にしている
// （ZoningImageryProvider の実行時挙動は e2e-r1.test.mjs で検証）。

import { check, equal, near, report } from './harness.mjs';
import { featureColor, ringsToPath, TILE_SIZE } from '../js/zoning-overlay.js';
import {
  USE_DISTRICT_COLORS,
  USE_DISTRICT_OTHER_COLOR,
  FIRE_COLORS,
  HEIGHT_DISTRICT_COLOR,
} from '../js/config.js';


console.log('--- featureColor ---');
equal('第1種低層住居専用地域',
  featureColor('use', { urf_function: '第1種低層住居専用地域' }),
  USE_DISTRICT_COLORS['第1種低層住居専用地域']);
equal('商業地域', featureColor('use', { urf_function: '商業地域' }), '#E77B8F');
equal('近隣商業地域', featureColor('use', { urf_function: '近隣商業地域' }), '#F2AEC4');
equal('未知の用途地域はその他色',
  featureColor('use', { urf_function: '謎地域' }), USE_DISTRICT_OTHER_COLOR);
equal('属性なしでもその他色', featureColor('use', {}), USE_DISTRICT_OTHER_COLOR);
equal('propsがnullでも落ちない', featureColor('use', null), USE_DISTRICT_OTHER_COLOR);
equal('防火地域', featureColor('fire', { urf_function: '防火地域' }), FIRE_COLORS['防火地域']);
equal('準防火地域', featureColor('fire', { urf_function: '準防火地域' }), FIRE_COLORS['準防火地域']);
equal('高度地区は単色', featureColor('height', { urf_function: '第2種高度地区' }), HEIGHT_DISTRICT_COLOR);
check('全12種の用途地域に色が定義されている', Object.keys(USE_DISTRICT_COLORS).length === 12);
check('用途地域の色はすべて異なる',
  new Set(Object.values(USE_DISTRICT_COLORS)).size === 12);

console.log('--- ringsToPath（extent → 256px 変換） ---');
{
  const extent = 65536;
  const rings = [[
    { x: 0, y: 0 }, { x: extent, y: 0 }, { x: extent, y: extent }, { x: 0, y: extent },
  ]];
  const p = ringsToPath(rings, extent);
  equal('リング数', p.length, 1);
  equal('頂点数', p[0].length, 4);
  equal('左上は(0,0)', p[0][0].join(','), '0,0');
  equal('右上は(256,0)', p[0][1].join(','), `${TILE_SIZE},0`);
  equal('右下は(256,256)', p[0][2].join(','), `${TILE_SIZE},${TILE_SIZE}`);
}
{
  const p = ringsToPath([[{ x: 32768, y: 16384 }, { x: 0, y: 0 }, { x: 100, y: 100 }]], 65536);
  near('中央のx', p[0][0][0], 128, 1e-9);
  near('1/4のy', p[0][0][1], 64, 1e-9);
}
{
  // extent が違っても比率で変換される（PLATEAU配信は65536だが将来4096も来うる）
  const p = ringsToPath([[{ x: 2048, y: 1024 }, { x: 0, y: 0 }, { x: 10, y: 10 }]], 4096);
  near('extent=4096でも中央は128', p[0][0][0], 128, 1e-9);
}
{
  const p = ringsToPath([[{ x: 0, y: 0 }, { x: 1, y: 1 }]], 65536);
  equal('2点のリング（面にならない）は捨てる', p.length, 0);
}
{
  const p = ringsToPath([null, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]], 65536);
  equal('nullリングを飛ばして残りを返す', p.length, 1);
}
{
  // タイル外にはみ出す座標もそのまま返す（クリップは canvas に任せる）
  const p = ringsToPath([[{ x: -6553, y: 0 }, { x: 72089, y: 0 }, { x: 0, y: 72089 }]], 65536);
  near('負の座標はそのまま', p[0][0][0], -25.598, 1e-3);
  near('extent超も外挿する', p[0][1][0], 281.598, 1e-3);
}
equal('空配列は空配列', ringsToPath([], 65536).length, 0);

report('overlay.test.mjs');
