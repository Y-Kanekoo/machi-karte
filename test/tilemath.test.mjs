// tilemath.js 単体テスト（Node直接実行・ブラウザ不要）
// 実行: node test/tilemath.test.mjs

import {
  lonLatToTileFloat,
  lonLatToPixel,
  lonLatToTileLocal,
  tileToLonLat,
  tileUrl,
  pointInRing,
  pointInRings,
  distanceMeters,
} from '../js/tilemath.js';
import { check, near, equal, report } from './harness.mjs';

// --- 既知の基準点 ---
// z=0 では世界全体が1タイル。経度0/緯度0（ヌル島）は中心 = (0.5, 0.5)
const origin = lonLatToTileFloat(0, 0, 0);
near('z=0 の (0,0) は xf=0.5', origin.xf, 0.5, 1e-9);
near('z=0 の (0,0) は yf=0.5', origin.yf, 0.5, 1e-9);

// 中野駅 (139.6659, 35.7010) の z=16 タイル
// 独立検算（Python）: xf=58193.4012, yf=25802.2055 → x=58193, y=25802, px=102, py=52
// 実タイル https://cyberjapandata.gsi.go.jp/xyz/pale/16/58193/25802.png が HTTP 200 で存在することも確認済（2026-07-27）
const nakano = lonLatToPixel(139.6659, 35.701, 16);
equal('中野駅 z=16 タイルX', nakano.x, 58193);
equal('中野駅 z=16 タイルY', nakano.y, 25802);
equal('中野駅 z=16 ピクセルX', nakano.px, 102);
equal('中野駅 z=16 ピクセルY', nakano.py, 52);
check('ピクセルXが0〜255', nakano.px >= 0 && nakano.px <= 255, `${nakano.px}`);
check('ピクセルYが0〜255', nakano.py >= 0 && nakano.py <= 255, `${nakano.py}`);

// --- 往復変換 ---
for (const [lon, lat, z] of [
  [139.6659, 35.701, 16],
  [139.6689, 35.7079, 14],
  [139.669, 35.697, 17],
  [-122.4194, 37.7749, 12],
]) {
  const { xf, yf } = lonLatToTileFloat(lon, lat, z);
  const back = tileToLonLat(xf, yf, z);
  near(`往復変換 lon (z=${z}, ${lon})`, back.lon, lon, 1e-9);
  near(`往復変換 lat (z=${z}, ${lat})`, back.lat, lat, 1e-9);
}

// --- ズームレベル間の整合性 ---
// z が1つ上がるとタイル番号は2倍(+0or1)
const z15 = lonLatToPixel(139.6659, 35.701, 15);
equal('z=15→z=16 のタイルX整合', Math.floor(nakano.x / 2), z15.x);
equal('z=15→z=16 のタイルY整合', Math.floor(nakano.y / 2), z15.y);

// --- MVTローカル座標 ---
// PLATEAU配信のMVTは extent=65536
const local = lonLatToTileLocal(139.6659, 35.701, 16, 65536);
equal('MVTタイルXがピクセル版と一致', local.x, nakano.x);
equal('MVTタイルYがピクセル版と一致', local.y, nakano.y);
check('ローカルXが0〜65536', local.lx >= 0 && local.lx < 65536, `${local.lx}`);
check('ローカルYが0〜65536', local.ly >= 0 && local.ly < 65536, `${local.ly}`);
// ピクセル座標とローカル座標のスケール整合（256倍）
near('ローカルX/256 ≒ ピクセルX', Math.floor(local.lx / 256), nakano.px, 0);
near('ローカルY/256 ≒ ピクセルY', Math.floor(local.ly / 256), nakano.py, 0);

// --- URLテンプレート ---
equal(
  'tileUrl展開',
  tileUrl('https://example.com/{z}/{x}/{y}.png', 16, 58193, 25813),
  'https://example.com/16/58193/25813.png'
);

// --- 点内包判定 ---
const square = [
  { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
];
check('正方形の中心は内部', pointInRing(5, 5, square));
check('正方形の外は外部', !pointInRing(15, 5, square));
check('正方形の外(負)は外部', !pointInRing(-1, 5, square));
check('正方形の上側外は外部', !pointInRing(5, 20, square));

// 凹多角形（L字）
const lshape = [
  { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 },
];
check('L字の腕の中は内部', pointInRing(2, 8, lshape));
check('L字の欠けた部分は外部', !pointInRing(8, 8, lshape));

// 穴あきポリゴン（偶奇規則）
const hole = [
  { x: 3, y: 3 }, { x: 7, y: 3 }, { x: 7, y: 7 }, { x: 3, y: 7 },
];
check('穴の中は外部（偶奇規則）', !pointInRings(5, 5, [square, hole]));
check('穴の外・外環の内は内部', pointInRings(1.5, 5, [square, hole]));
check('外環の外は外部', !pointInRings(20, 5, [square, hole]));

// --- Haversine距離（R2: 最寄り避難所・比較の重複判定で共用） ---
// 独立検算（Python geopy相当・球面半径6371008.8m）:
//   緯度1度（35.7→36.7、同経度）= 111194.9m / 経度0.0001度（緯度35.7）= 9.03m
near('同一地点は0m', distanceMeters(139.6659, 35.7056, 139.6659, 35.7056), 0, 1e-9);
near('緯度1度は約111.2km', distanceMeters(139.6659, 35.7, 139.6659, 36.7), 111194.9, 1);
near('緯度0.0001度は約11.1m', distanceMeters(139.6659, 35.7056, 139.6659, 35.7057), 11.12, 0.05);
near('経度0.0001度（緯度35.7）は約9.0m',
  distanceMeters(139.6659, 35.7056, 139.666, 35.7056), 9.03, 0.05);
// 中野駅 → 鷺宮（Python独立検算 3526.47m。誤差1%以内）
{
  const d = distanceMeters(139.6659, 35.7056, 139.635, 35.725);
  check('中野駅〜鷺宮が約3.53km', Math.abs(d - 3526.47) / 3526.47 < 0.01, `${d.toFixed(0)}m`);
}
check('引数の順序が対称', Math.abs(
  distanceMeters(139.6659, 35.7056, 139.635, 35.725) -
  distanceMeters(139.635, 35.725, 139.6659, 35.7056)
) < 1e-9);
// 赤道1度 = 111.195km（球面近似の妥当性チェック）
near('赤道の経度1度は約111.2km', distanceMeters(0, 0, 1, 0), 111194.9, 1);

report('tilemath.test.mjs');
