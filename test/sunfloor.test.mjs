// sunlight.js の純関数（階数→高さ変換・ウォームアップ方向）の単体テスト
// 実行: node test/sunfloor.test.mjs （ブラウザ不要。Cesium/DOM非依存であることの担保も兼ねる）
//
// P1.1（レビュー指摘の修正）で追加した境界も対象:
//   入力の厳格パース（null/空文字を0にしない）・縮退建物（包絡<1.5m）のフォールバック・
//   推定階数の60階クランプ・floorHeightsForFeature（getPropertyスタブ）・
//   boostTilesetCache の参照カウント
//
// 期待値は docs/plans/R3.md §3.1.1 ＋「P0後の設計確定」#3 #4 の確定仕様。
//   一般地点: h(k) = base + 1.2 + 3.0×(k−1)
//   建物    : F = bldg:storeysAboveGround（1..60の整数）/ 無ければ max(1, round((zmax−zmin)/4.0))
//             perFloor = (zmax−zmin)/F, h(k) = min(zmin + 1.2 + perFloor×(k−1), zmax − 0.3)
//             h(屋上) = zmax + 1.2

import {
  floorHeights,
  floorHeightsForFeature,
  sunPathWarmDirections,
  preloadForSunlight,
  boostTilesetCache,
  tilesetCacheBoostDepth,
  EYE_HEIGHT,
  GROUND_FLOOR_HEIGHT,
  FLOOR_ESTIMATE_DIVISOR,
  GROUND_FLOOR_MAX,
  BUILDING_FLOOR_MAX,
  BUILDING_MIN_SPAN,
  ROOF_CLEARANCE,
  MIN_SUN_ELEVATION,
  WARM_UP_MAX_RAYS,
  DEFAULT_BASE_HEIGHT,
  STOREYS_PROPERTY,
  SUNLIGHT_CACHE_BYTES,
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

// 1.5m の建物: 1階既定値 zmin+1.2 とクランプ上限 zmax−0.3 が厳密に一致する
const flat = floorHeights('building', { zmin: 10, zmax: 11.5 });
equal('1.5mの建物でもF=1（0階にはならない）', flat.floorCount, 1);
near('1階は zmin+1.2 の既定値と一致する', byKey(flat, 'f1').height, 11.2, 1e-9);
near('1階は zmax−0.3 の上限とも一致する', byKey(flat, 'f1').height, 11.2, 1e-9);
check('1階は屋上より低い', byKey(flat, 'f1').height < byKey(flat, 'roof').height);

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

// ---- R3 P1.1: 入力の厳格パース（null/空文字を数値0として通さない） ---------------------
//
// `Number(null) === 0` / `Number('') === 0` のため、素の Number() では
// 「属性が無い」ことと「値が0である」ことを区別できない。
// 例えば zmin=null の建物は「0m〜60mの60m級ビル」として内挿されてしまう。

equal('縮退とみなす最小の包絡は1.5m', BUILDING_MIN_SPAN, 1.5);
equal('階数プロパティの上限は60', BUILDING_FLOOR_MAX, 60);

for (const [label, bad] of [['null', null], ['undefined', undefined], ['空文字', ''],
  ['空白のみ', '  '], ['真偽値', true], ['配列', []], ['オブジェクト', {}], ['NaN', NaN]]) {
  const r = floorHeights('building', { base: 40, zmin: bad, zmax: 60 });
  equal(`zminが${label}なら一般地点仕様へフォールバック`, r.kind, 'ground');
  check(`zminが${label}のとき0mの建物として内挿しない`, r.zmin === null, JSON.stringify(r.zmin));
  const r2 = floorHeights('building', { base: 40, zmin: 38, zmax: bad });
  equal(`zmaxが${label}なら一般地点仕様へフォールバック`, r2.kind, 'ground');
}

const baseNull = floorHeights('ground', { base: null });
near('baseがnullなら既定値35mを使う（0mにしない）',
  byKey(baseNull, 'f1').height, DEFAULT_BASE_HEIGHT + EYE_HEIGHT, 1e-9);
near('baseが空文字でも既定値35m',
  byKey(floorHeights('ground', { base: '' }), 'f1').height, 36.2, 1e-9);
near('baseが真偽値でも既定値35m',
  byKey(floorHeights('ground', { base: true }), 'f1').height, 36.2, 1e-9);
near('baseがnullでzminがあればzminを使う',
  byKey(floorHeights('building', { base: null, zmin: 38 }), 'f1').height, 39.2, 1e-9);
near('base=0 は有効な値として扱う（既定値に寄せない）',
  byKey(floorHeights('ground', { base: 0 }), 'f1').height, 1.2, 1e-9);
near('baseが数字文字列なら数値として扱う',
  byKey(floorHeights('ground', { base: '35' }), 'f1').height, 36.2, 1e-9);

equal('maxFloorsがnullなら既定の15階',
  floorHeights('ground', { base: 10, maxFloors: null }).floors.length, GROUND_FLOOR_MAX);
equal('maxFloorsが空文字なら既定の15階',
  floorHeights('ground', { base: 10, maxFloors: '' }).floors.length, GROUND_FLOOR_MAX);
equal('maxFloorsは60階でクランプする',
  floorHeights('ground', { base: 10, maxFloors: 1000 }).floors.length, BUILDING_FLOOR_MAX);

// ---- R3 P2.1: 縮退建物（zmax − zmin < 1.5m）は一般地点仕様へフォールバック -----------------

for (const [label, zmin, zmax] of [
  ['0.1m', 50, 50.1],
  ['1.49m', 10, 11.49],
  ['0m（同値）', 20, 20],
  ['負（zmax<zmin）', 20, 19],
]) {
  const r = floorHeights('building', { zmin, zmax });
  equal(`包絡${label}の建物は一般地点仕様へ`, r.kind, 'ground');
  equal(`包絡${label}のfallbackフラグが立つ`, r.fallback, true);
  check(`包絡${label}では屋上の選択肢が出ない`, !r.floors.some((f) => f.isRoof));
  near(`包絡${label}の1階 = zmin + 1.2`, byKey(r, 'f1').height, zmin + EYE_HEIGHT, 1e-9);
}

// 境界のちょうど1.5mは建物として扱い、1階は初期計算の zmin+1.2 と厳密に一致する
const span1_5 = floorHeights('building', { zmin: 10, zmax: 11.5 });
equal('包絡ちょうど1.5mは建物として扱う', span1_5.kind, 'building');
near('包絡1.5mの1階は zmin+1.2 と一致する',
  byKey(span1_5, 'f1').height, 11.2, 1e-9);

// 建物として成立する範囲では、どの階も zmin 以上 zmax−0.3 以下に収まる
for (const [zmin, zmax, storeys] of [[0, 1.5, undefined], [37.36, 137.95, 22], [10, 12, 30], [5, 6.5, 3]]) {
  const r = floorHeights('building', { zmin, zmax, storeys });
  const inner = r.floors.filter((f) => !f.isRoof);
  check(`包絡${zmax - zmin}mの各階が zmin 以上 zmax−0.3 以下`,
    inner.every((f) => f.height >= zmin - 1e-9 && f.height <= zmax - ROOF_CLEARANCE + 1e-9),
    JSON.stringify(inner.map((f) => +f.height.toFixed(3))));
}

// ---- R3 P1.1: 推定階数の上限クランプ ----------------------------------------------------

const huge = floorHeights('building', { zmin: 0, zmax: 400 });
equal('推定階数は60階でクランプされる（400/4=100階にしない）', huge.floorCount, BUILDING_FLOOR_MAX);
equal('クランプ後の選択肢は屋上+60階', huge.floors.length, BUILDING_FLOOR_MAX + 1);
near('クランプ後のper floorは包絡/60', huge.perFloor, 400 / BUILDING_FLOOR_MAX, 1e-9);
equal('240mちょうどは60階（クランプ前と一致）',
  floorHeights('building', { zmin: 0, zmax: 240 }).floorCount, BUILDING_FLOOR_MAX);
equal('244mは61階ではなく60階',
  floorHeights('building', { zmin: 0, zmax: 244 }).floorCount, BUILDING_FLOOR_MAX);
check('クランプされた建物でも各階が zmax−0.3 以下',
  huge.floors.filter((f) => !f.isRoof).every((f) => f.height <= 400 - ROOF_CLEARANCE + 1e-9));

// ---- R3 P1.1: floorHeightsForFeature（getProperty をスタブ） ----------------------------

/** Cesium3DTileFeature の getProperty だけを持つスタブ */
const stubFeature = (props, opts = {}) => ({
  getProperty(name) {
    if (opts.throwOn && opts.throwOn.includes(name)) throw new Error('属性なし');
    return props[name];
  },
});

const featFull = floorHeightsForFeature(
  stubFeature({ _zmin: 37.36, _zmax: 137.95, [STOREYS_PROPERTY]: 22 }), 35);
equal('フィーチャから建物として解釈する', featFull.kind, 'building');
equal('フィーチャの階数プロパティを使う', featFull.floorCount, 22);
equal('階数プロパティがあれば推定にならない', featFull.estimated, false);
near('フィーチャの屋上 = _zmax + 1.2', byKey(featFull, 'roof').height, 139.15, 1e-9);

const featStr = floorHeightsForFeature(
  stubFeature({ _zmin: '37.36', _zmax: '137.95', [STOREYS_PROPERTY]: '22' }), 35);
equal('getPropertyが文字列を返しても解釈する', featStr.floorCount, 22);
near('文字列プロパティでも屋上高さは同じ', byKey(featStr, 'roof').height, 139.15, 1e-9);

const featNoStoreys = floorHeightsForFeature(stubFeature({ _zmin: 38.72, _zmax: 44.86 }), 35);
equal('階数プロパティ欠落なら高さから推定する', featNoStoreys.estimated, true);
equal('推定された階数は2', featNoStoreys.floorCount, 2);

const featNullStoreys = floorHeightsForFeature(
  stubFeature({ _zmin: 38.72, _zmax: 44.86, [STOREYS_PROPERTY]: null }), 35);
equal('階数プロパティがnullでも推定に落ちる', featNullStoreys.estimated, true);

const featNoZ = floorHeightsForFeature(stubFeature({ [STOREYS_PROPERTY]: 5 }), 41);
equal('_zmin/_zmax 欠落は一般地点仕様へ', featNoZ.kind, 'ground');
equal('_zmin/_zmax 欠落でfallbackフラグが立つ', featNoZ.fallback, true);
near('_zmin/_zmax 欠落時は baseHeight を使う', byKey(featNoZ, 'f1').height, 42.2, 1e-9);

const featNullZ = floorHeightsForFeature(
  stubFeature({ _zmin: null, _zmax: 60, [STOREYS_PROPERTY]: 10 }), 41);
equal('_zminがnullなら0m起点の建物にしない', featNullZ.kind, 'ground');
near('_zminがnullでも baseHeight を使う', byKey(featNullZ, 'f1').height, 42.2, 1e-9);

const featThrows = floorHeightsForFeature(
  stubFeature({ _zmax: 60 }, { throwOn: ['_zmin', '_zmax', STOREYS_PROPERTY] }), 41);
equal('getPropertyが例外を投げても一般地点仕様で返す', featThrows.kind, 'ground');
near('例外時も baseHeight を使う', byKey(featThrows, 'f1').height, 42.2, 1e-9);

const featNull = floorHeightsForFeature(null, 41);
equal('フィーチャなしは一般地点', featNull.kind, 'ground');
equal('フィーチャなしはfallbackフラグを立てない', featNull.fallback, false);
near('フィーチャなしは baseHeight を使う', byKey(featNull, 'f1').height, 42.2, 1e-9);

const featNoBase = floorHeightsForFeature(null, undefined);
near('baseHeightが未指定なら既定値35m',
  byKey(featNoBase, 'f1').height, DEFAULT_BASE_HEIGHT + EYE_HEIGHT, 1e-9);

// ---- R3 P1.1: boostTilesetCache の参照カウント -------------------------------------------

const ORIGINAL_BYTES = 512 * 1024 * 1024;
const fakeTileset = (bytes = ORIGINAL_BYTES) => ({ cacheBytes: bytes });

equal('初期状態では引き上げ中の区間が無い', tilesetCacheBoostDepth(), 0);

const ts1 = fakeTileset();
const release1 = boostTilesetCache(ts1);
equal('引き上げでcacheBytesが上がる', ts1.cacheBytes, SUNLIGHT_CACHE_BYTES);
equal('引き上げ中の深さは1', tilesetCacheBoostDepth(), 1);
const release2 = boostTilesetCache(ts1);
equal('入れ子の引き上げで深さが2になる', tilesetCacheBoostDepth(), 2);
release1();
equal('先に抜けた側では復元しない（レース防止）', ts1.cacheBytes, SUNLIGHT_CACHE_BYTES);
release1();
equal('復元関数の多重呼び出しでは深さが減らない', tilesetCacheBoostDepth(), 1);
release2();
equal('最後の区間が抜けたら元に戻す', ts1.cacheBytes, ORIGINAL_BYTES);
equal('復元後の深さは0', tilesetCacheBoostDepth(), 0);

// 別のタイルセットが引き上げ中なら触らない（建物レイヤー切替の途中）
const tsA = fakeTileset();
const tsB = fakeTileset();
const releaseA = boostTilesetCache(tsA);
const releaseB = boostTilesetCache(tsB);
equal('別タイルセットのcacheBytesは変更しない', tsB.cacheBytes, ORIGINAL_BYTES);
equal('別タイルセットでは深さが増えない', tilesetCacheBoostDepth(), 1);
releaseB();
equal('別タイルセットの復元関数はno-op（深さを壊さない）', tilesetCacheBoostDepth(), 1);
releaseA();
equal('本来の区間は正しく復元される', tsA.cacheBytes, ORIGINAL_BYTES);
equal('すべて抜けたら深さ0', tilesetCacheBoostDepth(), 0);

// 既に十分大きい / タイルセットが無い場合は何もしない
const tsBig = fakeTileset(SUNLIGHT_CACHE_BYTES * 2);
const releaseBig = boostTilesetCache(tsBig);
equal('既に十分大きいなら触らない', tsBig.cacheBytes, SUNLIGHT_CACHE_BYTES * 2);
equal('既に十分大きい場合は深さも増えない', tilesetCacheBoostDepth(), 0);
releaseBig();
equal('no-op復元後も深さ0', tilesetCacheBoostDepth(), 0);
check('タイルセットがnullでも関数が返る', typeof boostTilesetCache(null) === 'function');
const tsBroken = { get cacheBytes() { return ORIGINAL_BYTES; }, set cacheBytes(_v) { throw new Error('読み取り専用'); } };
const warn = console.warn;
console.warn = () => {}; // 想定内の警告なのでテスト出力を汚さない
const releaseBroken = boostTilesetCache(tsBroken);
console.warn = warn;
equal('cacheBytesが書けなくても深さを汚さない', tilesetCacheBoostDepth(), 0);
releaseBroken();
equal('書けなかった場合の復元もno-op', tilesetCacheBoostDepth(), 0);

// ---- R3 P1.1: 先読み（preloadForSunlight）の分岐 -----------------------------------------
//
// カメラ強奪レースの回帰テスト。Cesium非依存で通る経路だけを検証する
// （キャンセル時・方向0本時は Cesium を1度も触らずに返るのが仕様）。
// prepareTiles まで進む経路のために Cesium は最小スタブを置く
// ——「キャンセルしたのにカメラが動いた」を例外ではなくアサーション失敗として観測するため。

class FakeCartesian3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static fromDegrees(lon, lat, height = 0) { return new FakeCartesian3(lon, lat, height); }
  static normalize(v, out) {
    const m = Math.hypot(v.x, v.y, v.z) || 1;
    out.x = v.x / m; out.y = v.y / m; out.z = v.z / m;
    return out;
  }
}

globalThis.Cesium = {
  Cartesian3: FakeCartesian3,
  // ENU→ECEF変換は恒等でよい（ここで見たいのは本数と除外リストの受け渡し）
  Transforms: { eastNorthUpToFixedFrame: () => ({}) },
  Matrix4: {
    multiplyByPointAsVector: (_m, v, out) => { out.x = v.x; out.y = v.y; out.z = v.z; return out; },
  },
  Ray: class { constructor(origin, direction) { this.origin = origin; this.direction = direction; } },
  Math: { toRadians: (deg) => (deg * Math.PI) / 180 },
};

/** camera.setView の呼び出し回数を数えるだけのビューア */
const fakeViewer = (scene = {}) => {
  const calls = { setView: 0 };
  return { calls, camera: { setView: () => { calls.setView++; } }, scene };
};

// (1) キャンセル済みなら prepareTiles へ落ちずカメラを動かさない
const vCancelled = fakeViewer({ camera: {} }); // pickFromRayMostDetailed なし＝warm-up非対応
const preCancelled = await preloadForSunlight(vCancelled, null, 139.6659, 35.7010, 35, {
  fly: true,
  isCancelled: () => true,
});
equal('キャンセル済みなら cancelled:true を返す', preCancelled.cancelled, true);
equal('キャンセル済みならカメラを一切動かさない', vCancelled.calls.setView, 0);
equal('キャンセル済みなら prepareTiles へ落ちない', preCancelled.method, 'warmUpSunPath');

// (2) キャンセルされていなければ従来方式（カメラ移動）へフォールバックする
const vFallback = fakeViewer({ camera: {} });
const preFallback = await preloadForSunlight(vFallback, null, 139.6659, 35.7010, 35, {
  fly: true,
  isCancelled: () => false,
});
equal('warm-up非対応なら prepareTiles へフォールバックする', preFallback.method, 'prepareTiles');
equal('フォールバック時はカメラを動かす', vFallback.calls.setView, 1);
check('フォールバック理由が記録される', !!preFallback.fallbackReason, String(preFallback.fallbackReason));
equal('フォールバックはキャンセル扱いにしない', preFallback.cancelled, false);

// (3) 発射する方向が0本なら成功扱いにせず method:'none' として注記対象にする
//     （lon=-30 では JST 8〜16時がすべて夜になり、太陽高度5度以上の方向が1本も無い）
const vNoRays = fakeViewer({ camera: {}, pickFromRayMostDetailed: () => Promise.resolve(undefined) });
const preNoRays = await preloadForSunlight(vNoRays, null, -30, 0, 35, { fly: true });
equal('レイ0本のとき rays は0', preNoRays.warmUp.rays, 0);
equal('レイ0本を成功扱いにしない', preNoRays.ok, false);
equal('レイ0本は method:none として扱う', preNoRays.method, 'none');
check('レイ0本でも理由が記録される', !!preNoRays.fallbackReason, String(preNoRays.fallbackReason));
equal('レイ0本ではカメラを動かさない', vNoRays.calls.setView, 0);
equal('レイ0本では発射本数も0', preNoRays.warmUp.attempted, 0);

// (4) 計画本数(rays)と実際に発射した本数(attempted)は別々に記録する
const picked = [];
const vRays = fakeViewer({
  camera: {},
  pickFromRayMostDetailed: (_ray, exclude) => { picked.push(exclude); return Promise.resolve(undefined); },
});
const preRays = await preloadForSunlight(vRays, null, 139.6659, 35.7010, 35, {
  fly: false, // カメラ停止待ちを省いて即実行する
});
equal('中野では計画12本', preRays.warmUp.rays, WARM_UP_MAX_RAYS);
equal('12本すべてを発射する', preRays.warmUp.attempted, WARM_UP_MAX_RAYS);
equal('12本すべてが解決する', preRays.warmUp.resolved, WARM_UP_MAX_RAYS);
equal('解決していれば先読み成功', preRays.ok, true);
equal('除外フィーチャ未指定なら第2引数はundefined', picked[0], undefined);

// (5) excludeFeatures はフィーチャのみ第2引数へ渡す（P2の自建物除外に備えたAPI整備）
const feature = { getProperty: () => 1 };
const passed = [];
const vExclude = fakeViewer({
  camera: {},
  pickFromRayMostDetailed: (_ray, exclude) => { passed.push(exclude); return Promise.resolve(undefined); },
});
await preloadForSunlight(vExclude, null, 139.6659, 35.7010, 35, {
  fly: false,
  excludeFeatures: [feature, null, 'primitive', { primitive: {} }],
});
check('除外フィーチャが第2引数に渡る', Array.isArray(passed[0]) && passed[0][0] === feature,
  JSON.stringify(passed[0]));
equal('フィーチャ以外は除外リストから落とす', passed[0].length, 1);

// (6) 実行中バッチが解決しなくても、キャンセルは待たされずに効く
//     （修正前は allSettled の解決待ちに引きずられ、最悪15秒のタイムアウトまで抜けられなかった）
let hangCancelled = false;
const vHang = fakeViewer({ camera: {}, pickFromRayMostDetailed: () => new Promise(() => {}) });
setTimeout(() => { hangCancelled = true; }, 150);
const hangStart = Date.now();
const preHang = await preloadForSunlight(vHang, null, 139.6659, 35.7010, 35, {
  fly: false,
  isCancelled: () => hangCancelled,
});
const hangMs = Date.now() - hangStart;
equal('解決しないバッチでもキャンセルで抜ける', preHang.cancelled, true);
check('キャンセルが1秒以内に効く（バッチの解決を待たない）', hangMs < 1000, `${hangMs}ms`);
equal('キャンセル時はカメラを動かさない', vHang.calls.setView, 0);

report('sunfloor.test.mjs');
