// compare.js（比較スナップショット・比較表）の純粋関数の単体テスト
// 実行: node test/compare.test.mjs
//
// DOM・Cesium・ネットワークに触れない関数だけを対象にしている
// （initCompare のDOM挙動は e2e-r1.test.mjs で検証）。

import { check, equal, near, report } from './harness.mjs';
import {
  snapshotFromResult,
  worstLandslide,
  distanceMeters,
  buildCompareTable,
  COMPARE_ROWS,
} from '../js/compare.js';

// ---- 比較スナップショット --------------------------------------------------------

const full = {
  lon: 139.673935,
  lat: 35.691502,
  title: '東京都中野区弥生町二丁目',
  flood: { rank: '0.5m未満' },
  landslide: [
    { label: '土石流', rank: '区域外' },
    { label: '急傾斜地の崩壊', rank: '警戒区域（イエロー）' },
    { label: '地すべり', rank: '区域外' },
  ],
  zoning: {
    use: { name: '近隣商業地域', coverage: 80, floorArea: 400 },
    fire: { name: '防火地域' },
    height: { name: '高度地区' },
  },
  sunlight: {
    days: [
      { label: '冬至', hours: 3.33 },
      { label: '春分', hours: 6.0 },
      { label: '夏至', hours: 8.67 },
    ],
  },
  buildingHeight: 24.53,
};

console.log('--- snapshotFromResult ---');
{
  const s = snapshotFromResult(full);
  equal('住所が入る', s.title, '東京都中野区弥生町二丁目');
  equal('洪水ランク', s.flood, '0.5m未満');
  equal('用途地域', s.use, '近隣商業地域');
  equal('建蔽率', s.coverage, 80);
  equal('容積率', s.floorArea, 400);
  equal('防火地域', s.fire, '防火地域');
  equal('高度地区', s.heightDistrict, '高度地区');
  equal('土砂3種の最悪値', s.landslideWorst, '警戒区域（イエロー）');
  equal('日照3値が入る', s.sun.length, 3);
  near('建物の計測高さ', s.buildingHeight, 24.53, 1e-9);
  check('追加時刻が入る', typeof s.at === 'number' && s.at > 0);
}
{
  // 診断途中（コア項目のみ）のスナップショット
  const s = snapshotFromResult({ lon: 139.6, lat: 35.7, flood: { rank: '区域外' } });
  equal('未取得の用途地域はnull', s.use, null);
  equal('未計算の日照はnull', s.sun, null);
  equal('建物高さが無ければnull', s.buildingHeight, null);
  equal('土砂が無ければ最悪値もnull', s.landslideWorst, null);
}
equal('nullを渡すとnull', snapshotFromResult(null), null);
equal('座標が無ければnull', snapshotFromResult({ title: 'x' }), null);

console.log('--- worstLandslide ---');
equal('すべて区域外', worstLandslide([{ rank: '区域外' }, { rank: '区域外' }]), '区域外');
equal('イエローが混ざる',
  worstLandslide([{ rank: '区域外' }, { rank: '警戒区域（イエロー）' }]), '警戒区域（イエロー）');
equal('レッドが最優先',
  worstLandslide([{ rank: '警戒区域（イエロー）' }, { rank: '特別警戒区域（レッド）' }]),
  '特別警戒区域（レッド）');
equal('空配列は区域外', worstLandslide([]), '区域外');

console.log('--- distanceMeters ---');
near('同一地点は0m', distanceMeters({ lon: 139.6659, lat: 35.7056 }, { lon: 139.6659, lat: 35.7056 }), 0, 1e-6);
{
  // 緯度 0.0001度 ≒ 11.05m
  const d = distanceMeters({ lon: 139.6659, lat: 35.7056 }, { lon: 139.6659, lat: 35.7057 });
  near('緯度0.0001度は約11m', d, 11.05, 0.5);
  check('11mは重複判定（<10m）に引っかからない', d >= 10);
}
{
  const d = distanceMeters({ lon: 139.6659, lat: 35.7056 }, { lon: 139.635, lat: 35.725 });
  check('中野駅〜鷺宮は2km以上', d > 2000, `${d}m`);
}

console.log('--- buildCompareTable ---');
{
  const a = snapshotFromResult(full);
  const b = snapshotFromResult({
    lon: 139.635, lat: 35.725,
    title: '東京都中野区鷺宮三丁目',
    flood: { rank: '区域外' },
    landslide: [{ label: '土石流', rank: '区域外' }],
    zoning: { use: { name: '第1種低層住居専用地域', coverage: 50, floorArea: 150 }, fire: null, height: null },
  });
  const t = buildCompareTable([a, b]);
  equal('列が2つ', t.headers.length, 2);
  equal('1列目の見出しは住所', t.headers[0].title, '東京都中野区弥生町二丁目');
  equal('行数はCOMPARE_ROWSと一致', t.rows.length, COMPARE_ROWS.length);

  const row = (key) => t.rows.find((r) => r.key === key);
  equal('洪水の行', row('flood').cells.join(' vs '), '0.5m未満 vs 区域外');
  equal('用途地域の行', row('use').cells.join(' vs '), '近隣商業地域 vs 第1種低層住居専用地域');
  equal('建蔽率の行', row('coverage').cells.join(' vs '), '80% vs 50%');
  equal('容積率の行', row('floorArea').cells.join(' vs '), '400% vs 150%');
  equal('防火地域が無い列は「指定なし」', row('fire').cells[1], '指定なし');
  equal('日照（冬至）', row('sunWinter').cells[0], '3.3 h');
  equal('日照未計算の列は「未計算」', row('sunWinter').cells[1], '未計算');
  equal('建物高さ', row('buildingHeight').cells[0], '24.5 m');
  equal('建物高さ未取得は「未計算」', row('buildingHeight').cells[1], '未計算');
  check('洪水の行にはバッジ指定がある', row('flood').badge === 'flood');
}
{
  const noTitle = snapshotFromResult({ lon: 139.6659, lat: 35.7056, flood: { rank: '区域外' } });
  const t = buildCompareTable([noTitle]);
  equal('住所が無ければ座標を見出しにする', t.headers[0].title, '139.66590, 35.70560');
}
{
  const many = [1, 2, 3, 4].map((i) =>
    snapshotFromResult({ lon: 139.6 + i / 1000, lat: 35.7, flood: { rank: '区域外' } })
  );
  equal('4件渡しても3列まで', buildCompareTable(many).headers.length, 3);
}
equal('空配列でも落ちない', buildCompareTable([]).headers.length, 0);

report('compare.test.mjs');
