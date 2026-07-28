// floodviz.js の純粋ロジックの単体テスト（Node直接実行・ブラウザ不要）
// 実行: node test/floodviz.test.mjs
//
// Cesium に触る showFloodDepth / clearFloodDepth は e2e 側（test/e2e.test.mjs）で検証する。

import { check, equal, report } from './harness.mjs';
import {
  floodVizDepth,
  canShowFloodDepth,
  resolveBaseHeight,
  MIN_PLAUSIBLE_BASE_HEIGHT,
} from '../js/floodviz.js';
import { FLOOD_VIZ_MAX_DEPTH } from '../js/config.js';
import { FLOOD_LEGEND } from '../js/hazard.js';

console.log('--- floodVizDepth ---');
equal('0.5m未満の上限は0.5m', floodVizDepth(0.5).depth, 0.5);
equal('0.5〜3.0mの上限は3m', floodVizDepth(3).depth, 3);
equal('3.0〜5.0mの上限は5m', floodVizDepth(5).depth, 5);
check('通常の深さはキャップされない', floodVizDepth(3).capped === false);
check('通常の深さは表示できる', floodVizDepth(3).usable === true);

console.log('--- 「20.0m以上」（Infinity）のキャップ ---');
equal('Infinityは上限にキャップ', floodVizDepth(Infinity).depth, FLOOD_VIZ_MAX_DEPTH);
check('Infinityはキャップされた扱い', floodVizDepth(Infinity).capped === true);
check('Infinityでも表示はできる', floodVizDepth(Infinity).usable === true);
equal('上限超（25m）もキャップ', floodVizDepth(25).depth, FLOOD_VIZ_MAX_DEPTH);
check('上限超はキャップされた扱い', floodVizDepth(25).capped === true);
equal('ちょうど上限はキャップしない', floodVizDepth(FLOOD_VIZ_MAX_DEPTH).capped, false);

console.log('--- 表示できない入力 ---');
check('nullは表示不可', floodVizDepth(null).usable === false);
check('undefinedは表示不可', floodVizDepth(undefined).usable === false);
check('NaNは表示不可', floodVizDepth(NaN).usable === false);
check('0は表示不可', floodVizDepth(0).usable === false);
check('負の値は表示不可', floodVizDepth(-3).usable === false);
equal('表示不可なら深さは0', floodVizDepth(null).depth, 0);

console.log('--- canShowFloodDepth ---');
check('nullは不可', canShowFloodDepth(null) === false);
check('区域外は不可', canShowFloodDepth({ rank: '区域外', depthMax: null }) === false);
check('判定不能は不可', canShowFloodDepth({ rank: '判定不能', depthMax: null }) === false);
check('0.5m未満は可', canShowFloodDepth({ rank: '0.5m未満', depthMax: 0.5 }) === true);
check('20.0m以上は可', canShowFloodDepth({ rank: '20.0m以上', depthMax: Infinity }) === true);
// 凡例の全ランクが（区域外・判定不能以外は）3D表示できること
for (const l of FLOOD_LEGEND) {
  check(`凡例「${l.rank}」は3D表示できる`,
    canShowFloodDepth({ rank: l.rank, depthMax: l.depthMax }) === true, l.rank);
}

console.log('--- resolveBaseHeight（楕円体0m へのフォールバック） ---');
// 実測（2026-07-28 e2e）: 建物タイル未読込の南台で sampleHeightMostDetailed が
// -0.0175m を返し、水面が地下に沈んだ。この値は採用してはいけない。
equal('実測 -0.0175m は既定値にフォールバック', resolveBaseHeight(-0.0175, 35), 35);
equal('0m は既定値にフォールバック', resolveBaseHeight(0, 35), 35);
equal('下限ちょうどは既定値', resolveBaseHeight(MIN_PLAUSIBLE_BASE_HEIGHT, 35), 35);
equal('null は既定値', resolveBaseHeight(null, 35), 35);
equal('undefined は既定値', resolveBaseHeight(undefined, 35), 35);
equal('NaN は既定値', resolveBaseHeight(NaN, 35), 35);
equal('妥当な実測値（33.4m）はそのまま', resolveBaseHeight(33.4, 35), 33.4);
equal('屋上の実測値（81.1m）もそのまま', resolveBaseHeight(81.067, 35), 81.067);
check('下限は1m', MIN_PLAUSIBLE_BASE_HEIGHT === 1, String(MIN_PLAUSIBLE_BASE_HEIGHT));

report('floodviz.test.mjs');
