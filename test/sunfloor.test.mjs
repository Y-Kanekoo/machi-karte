// sunlight.js の純関数（階数→高さ変換・ウォームアップ方向）の単体テスト
// 実行: node test/sunfloor.test.mjs （ブラウザ不要。Cesium/DOM非依存であることの担保も兼ねる）
//
// 期待値は docs/plans/R3.md §3.1.1 ＋「P0後の設計確定」#3 #4 の確定仕様。
//   一般地点: h(k) = base + 1.2 + 3.0×(k−1)
//   建物    : F = bldg:storeysAboveGround（1..60の整数）/ 無ければ max(1, round((zmax−zmin)/4.0))
//             perFloor = (zmax−zmin)/F, h(k) = min(zmin + 1.2 + perFloor×(k−1), zmax − 0.3)
//             h(屋上) = zmax + 1.2

import {
  floorHeights,
  sunPathWarmDirections,
  EYE_HEIGHT,
  GROUND_FLOOR_HEIGHT,
  FLOOR_ESTIMATE_DIVISOR,
  GROUND_FLOOR_MAX,
  ROOF_CLEARANCE,
  MIN_SUN_ELEVATION,
  WARM_UP_MAX_RAYS,
} from '../js/sunlight.js';
import { check, equal, near, report } from './harness.mjs';

/** key で選択肢を引く */
const byKey = (r, key) => r.floors.find((f) => f.key === key);

// ---- 定数の確定値 --------------------------------------------------------------

equal('視点高さは1.2m', EYE_HEIGHT, 1.2);
equal('一般地点の階高は3.0m', GROUND_FLOOR_HEIGHT, 3.0);
equal('階数推定の除数は4.0（3.0ではない）', FLOOR_ESTIMATE_DIVISOR, 4.0);
equal('一般地点の最大階数は15', GROUND_FLOOR_MAX, 15);
equal('屋上クリアランスは0.3m', ROOF_CLEARANCE, 0.3);

// ---- 一般地点 -------------------------------------------------------------------

const ground = floorHeights('ground', { base: 35 });
equal('一般地点は15階分の選択肢', ground.floors.length, 15);
equal('一般地点のkindはground', ground.kind, 'ground');
equal('一般地点は推定フラグが立たない', ground.estimated, false);
equal('一般地点はフォールバックではない', ground.fallback, false);
near('一般地点の1階 = base + 1.2', byKey(ground, 'f1').height, 36.2, 1e-9);
near('一般地点の2階 = base + 4.2', byKey(ground, 'f2').height, 39.2, 1e-9);
near('一般地点の15階 = base + 1.2 + 3.0×14', byKey(ground, 'f15').height, 78.2, 1e-9);
check('一般地点は昇順（1階が先頭）', ground.floors[0].key === 'f1' && ground.floors[14].key === 'f15');
check('一般地点に屋上の選択肢は無い', !ground.floors.some((f) => f.isRoof));
equal('一般地点のラベルは「1階」', byKey(ground, 'f1').label, '1階');
equal('一般地点のperFloorは3.0', ground.perFloor, 3.0);

// base が無いときは既定値35mに寄せる
const groundNoBase = floorHeights('ground', {});
near('baseなしは既定値35mを使う', byKey(groundNoBase, 'f1').height, 36.2, 1e-9);

// maxFloors で階数を絞れる（P2のUIで使う想定）
const ground3 = floorHeights('ground', { base: 10, maxFloors: 3 });
equal('maxFloorsで階数を絞れる', ground3.floors.length, 3);
near('maxFloors指定時の3階', byKey(ground3, 'f3').height, 17.2, 1e-9);

// ---- 建物（階数プロパティあり）: P0実測の建物A -------------------------------------

// #0 bldg_ceb5ebbc… : storeysAboveGround=22 / _zmin=37.36 / _zmax=137.95
const bldgA = floorHeights('building', { zmin: 37.36, zmax: 137.95, storeys: 22 });
equal('建物のkindはbuilding', bldgA.kind, 'building');
equal('階数プロパティがあれば推定フラグは立たない', bldgA.estimated, false);
equal('建物Aの階数は22', bldgA.floorCount, 22);
equal('選択肢は屋上+22階の23個', bldgA.floors.length, 23);
equal('先頭は屋上', bldgA.floors[0].key, 'roof');
equal('末尾は1階', bldgA.floors[22].key, 'f1');
check('屋上のisRoofがtrue', byKey(bldgA, 'roof').isRoof === true);
near('屋上 = _zmax + 1.2', byKey(bldgA, 'roof').height, 139.15, 1e-9);
near('建物Aのper floor = (zmax−zmin)/22', bldgA.perFloor, (137.95 - 37.36) / 22, 1e-9);
near('建物Aの1階 = zmin + 1.2', byKey(bldgA, 'f1').height, 38.56, 1e-9);
near('建物Aの3階 = zmin + 1.2 + perFloor×2',
  byKey(bldgA, 'f3').height, 37.36 + 1.2 + ((137.95 - 37.36) / 22) * 2, 1e-9);
check('建物Aの最上階は屋上より低い', byKey(bldgA, 'f22').height < byKey(bldgA, 'roof').height);
check('建物Aの各階は昇順に並ぶ（降順リストの逆順）',
  bldgA.floors.slice(1).every((f, i, a) => i === 0 || f.height < a[i - 1].height));
check('建物Aは階数≒4.57m/階（3.0m/階ではない）',
  Math.abs(bldgA.perFloor - 4.572) < 0.01, String(bldgA.perFloor));

// 文字列で来ても整数として解釈する（getProperty は文字列を返すことがある）
const bldgStr = floorHeights('building', { zmin: 0, zmax: 44, storeys: '11' });
equal('階数が文字列でも解釈する', bldgStr.floorCount, 11);
equal('文字列の階数でも推定フラグは立たない', bldgStr.estimated, false);

// ---- 建物（階数プロパティなし）: 除数4.0の検証 ---------------------------------------

// #1 bldg_baaf5831… : 階数19 / _zmax−_zmin = 115.06 → /4.0 = 28.765 → 29（/3.0なら38になる）
const est1 = floorHeights('building', { zmin: 39.15, zmax: 154.21 });
equal('階数欠落時は推定フラグが立つ', est1.estimated, true);
equal('除数4.0での推定階数は29（3.0なら38）', est1.floorCount, 29);
check('除数3.0の結果（38階）にはならない', est1.floorCount !== 38, String(est1.floorCount));
near('推定時のper floor = (zmax−zmin)/29', est1.perFloor, (154.21 - 39.15) / 29, 1e-9);
near('推定時も屋上は zmax + 1.2', byKey(est1, 'roof').height, 155.41, 1e-9);

// #2 bldg_753fbfb6… : 階数プロパティ欠落の実例 / _zmin=38.72 / _zmax=44.86（6.14m）
const est2 = floorHeights('building', { zmin: 38.72, zmax: 44.86, storeys: undefined });
equal('6.14mの建物は2階と推定される', est2.floorCount, 2);
equal('推定フラグが立つ', est2.estimated, true);
near('推定2階建ての1階', byKey(est2, 'f1').height, 39.92, 1e-9);
near('推定2階建ての2階', byKey(est2, 'f2').height, 38.72 + 1.2 + 6.14 / 2, 1e-9);

// 不正な階数プロパティは推定へ落ちる
for (const [label, v] of [['0', 0], ['61', 61], ['小数3.5', 3.5], ['文字列', 'なし'], ['null', null]]) {
  const r = floorHeights('building', { zmin: 0, zmax: 40, storeys: v });
  check(`階数プロパティ ${label} は不正として推定に落ちる`, r.estimated === true, JSON.stringify(r.floorCount));
}
equal('40mの建物の推定階数は10', floorHeights('building', { zmin: 0, zmax: 40 }).floorCount, 10);

// ---- 境界: F=1 / zmax−zmin < 3m / クランプ ------------------------------------------

// 3.5m の建物: 3.5/4.0 = 0.875 → round → 1 階
const tiny = floorHeights('building', { zmin: 0, zmax: 3.5 });
equal('3.5mの建物はF=1', tiny.floorCount, 1);
equal('F=1でも屋上+1階の2択', tiny.floors.length, 2);
near('F=1の1階 = zmin + 1.2（クランプ前）', byKey(tiny, 'f1').height, 1.2, 1e-9);
near('F=1の屋上 = zmax + 1.2', byKey(tiny, 'roof').height, 4.7, 1e-9);

// 1m の建物: round(0.25)=0 → max(1, 0) = 1 階。zmin+1.2 > zmax−0.3 なのでクランプが効く
const flat = floorHeights('building', { zmin: 10, zmax: 11 });
equal('1mの建物でもF=1（0階にはならない）', flat.floorCount, 1);
near('zmax−0.3 にクランプされる', byKey(flat, 'f1').height, 10.7, 1e-9);
check('クランプ後も屋上より低い', byKey(flat, 'f1').height < byKey(flat, 'roof').height);

// 2m（<3m）の建物: 2/4.0 = 0.5 → round → 1 階。クランプは効かない
const low = floorHeights('building', { zmin: 10, zmax: 12 });
equal('2mの建物はF=1', low.floorCount, 1);
near('2mの建物の1階はクランプされない', byKey(low, 'f1').height, 11.2, 1e-9);

// 階数が多く階高が低いケース: 上階が zmax−0.3 にクランプされる
const clamped = floorHeights('building', { zmin: 0, zmax: 10, storeys: 10 });
equal('階高1mで10階', clamped.floorCount, 10);
near('クランプ上限は zmax − 0.3', byKey(clamped, 'f10').height, 9.7, 1e-9);
check('クランプは全階に適用される（どの階も zmax−0.3 以下）',
  clamped.floors.filter((f) => !f.isRoof).every((f) => f.height <= 10 - 0.3 + 1e-9));
check('クランプされても zmin を下回らない',
  clamped.floors.filter((f) => !f.isRoof).every((f) => f.height >= 0));

// 退化（zmax−zmin < 0.3）でも zmin を下回らない
const degenerate = floorHeights('building', { zmin: 50, zmax: 50.1 });
check('退化した建物でも高さが zmin 以上',
  byKey(degenerate, 'f1').height >= 50, String(byKey(degenerate, 'f1').height));

// ---- zmin/zmax 欠損 → 一般地点仕様へフォールバック -------------------------------------

for (const [label, params] of [
  ['zmin欠損', { base: 40, zmax: 60 }],
  ['zmax欠損', { base: 40, zmin: 38 }],
  ['両方欠損', { base: 40 }],
  ['zmaxがzmin以下', { base: 40, zmin: 60, zmax: 60 }],
  ['zminが数値でない', { base: 40, zmin: 'なし', zmax: 60 }],
]) {
  const r = floorHeights('building', params);
  equal(`${label}は一般地点仕様へフォールバック`, r.kind, 'ground');
  equal(`${label}のfallbackフラグが立つ`, r.fallback, true);
  equal(`${label}は15階分`, r.floors.length, 15);
  near(`${label}の1階 = base + 1.2`, r.floors[0].height, 41.2, 1e-9);
  check(`${label}では屋上の選択肢が出ない`, !r.floors.some((f) => f.isRoof));
}

// 未知のkindも一般地点扱い（呼び出し側のtypoで壊れない）
equal('未知のkindは一般地点扱い', floorHeights('unknown', { base: 5 }).kind, 'ground');

// ---- ウォームアップ方向（純関数） ------------------------------------------------------

const dirs = sunPathWarmDirections(139.6659, 35.7010, { year: 2026 });
check('ウォームアップ方向が8〜12本', dirs.length >= 8 && dirs.length <= WARM_UP_MAX_RAYS, String(dirs.length));
check('すべて太陽高度5度以上', dirs.every((d) => d.elevationDeg >= MIN_SUN_ELEVATION),
  JSON.stringify(dirs.map((d) => +d.elevationDeg.toFixed(1))));
check('方位が10度粒度で重複しない',
  new Set(dirs.map((d) => Math.round(d.azimuthDeg / 10))).size === dirs.length,
  JSON.stringify(dirs.map((d) => +d.azimuthDeg.toFixed(1))));
check('冬至の方向が含まれる（低い太陽を優先）', dirs.some((d) => d.label.startsWith('winter')),
  JSON.stringify(dirs.map((d) => d.label)));
check('夏至の方向も含まれる', dirs.some((d) => d.label.startsWith('summer')),
  JSON.stringify(dirs.map((d) => d.label)));
equal('maxで本数を絞れる', sunPathWarmDirections(139.6659, 35.7010, { year: 2026, max: 4 }).length, 4);
console.log('  ウォームアップ方向: ' + JSON.stringify(
  dirs.map((d) => `${d.label} az=${d.azimuthDeg.toFixed(0)} el=${d.elevationDeg.toFixed(0)}`)));

report('sunfloor.test.mjs');
