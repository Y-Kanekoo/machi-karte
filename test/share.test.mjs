// share.js（共有URLのserialize/parse）の単体テスト
// 実行: node test/share.test.mjs
//
// 純粋関数のみを対象にしているのでネットワークもブラウザも不要（SKIP_NETWORK に依存しない）。

import { check, equal, near, report } from './harness.mjs';
import {
  serializeState,
  parseHash,
  isValidLonLat,
  SCHEMA_VERSION,
  ADDR_MAX_LENGTH,
} from '../js/share.js';

// ---- 1. 座標バリデーション ----------------------------------------------------

console.log('--- 座標バリデーション ---');
check('中野駅の座標は有効', isValidLonLat(139.6659, 35.7056));
check('NaNは無効', !isValidLonLat(NaN, 35.7));
check('undefinedは無効', !isValidLonLat(undefined, 35.7));
check('日本域外（ロンドン）は無効', !isValidLonLat(-0.1276, 51.5072));
check('経度の範囲外（200）は無効', !isValidLonLat(200, 35.7));
check('緯度の範囲外（80）は無効', !isValidLonLat(139.6, 80));

// ---- 2. serialize --------------------------------------------------------------

console.log('--- serializeState ---');
equal('spotのみ',
  serializeState({ spot: { lon: 139.6659, lat: 35.7056 } }),
  'v=1&spot=139.6659,35.7056');

equal('spotは小数6桁に丸める',
  serializeState({ spot: { lon: 139.66591234567, lat: 35.70561987654 } }),
  'v=1&spot=139.665912,35.70562');

equal('camのheight/heading/pitchは整数丸め',
  serializeState({ cam: { lon: 139.6659, lat: 35.7056, height: 612.7, heading: 30.4, pitch: -49.6 } }),
  'v=1&cam=139.6659,35.7056,613,30,-50');

equal('headingは0〜359に正規化',
  serializeState({ cam: { lon: 139.6659, lat: 35.7056, height: 100, heading: -30, pitch: -45 } }),
  'v=1&cam=139.6659,35.7056,100,330,-45');

equal('addrはURLエンコードされる',
  serializeState({ addr: '東京都中野区中野五丁目', spot: { lon: 139.66893, lat: 35.707859 } }),
  'v=1&spot=139.66893,35.707859&addr=' + encodeURIComponent('東京都中野区中野五丁目'));

equal('overlaysはconfigの順に並ぶ',
  serializeState({ spot: { lon: 139.6, lat: 35.7 }, overlays: ['height', 'use'] }),
  'v=1&spot=139.6,35.7&ov=use,height');

equal('未知のoverlayは落とす',
  serializeState({ spot: { lon: 139.6, lat: 35.7 }, overlays: ['use', 'bogus'] }),
  'v=1&spot=139.6,35.7&ov=use');

equal('compareはセミコロン区切り',
  serializeState({ compare: [{ lon: 139.6659, lat: 35.7056 }, { lon: 139.635, lat: 35.725 }] }),
  'v=1&compare=139.6659,35.7056;139.635,35.725');

equal('compareは最大3地点で切る',
  serializeState({
    compare: [
      { lon: 139.61, lat: 35.71 }, { lon: 139.62, lat: 35.72 },
      { lon: 139.63, lat: 35.73 }, { lon: 139.64, lat: 35.74 },
    ],
  }),
  'v=1&compare=139.61,35.71;139.62,35.72;139.63,35.73');

equal('範囲外のspotは書き出さない',
  serializeState({ spot: { lon: 999, lat: 35.7 } }), 'v=1');
equal('空stateでもバージョンだけは出す', serializeState({}), 'v=1');
equal('nullを渡しても落ちない', serializeState(null), 'v=1');

// ---- 3. parse ------------------------------------------------------------------

console.log('--- parseHash ---');
{
  const s = parseHash('#v=1&spot=139.6659,35.7056');
  equal('spotのlon', s?.spot.lon, 139.6659);
  equal('spotのlat', s?.spot.lat, 35.7056);
  equal('camは無ければnull', s?.cam, null);
  equal('overlaysは既定で空配列', s?.overlays.length, 0);
}
{
  const s = parseHash('v=1&spot=139.6659,35.7056'); // 先頭 # なしでも読める
  check('先頭#なしでも解析できる', !!s?.spot);
}
{
  const s = parseHash('#v=1&cam=139.6659,35.7056,613,30,-50&ov=use,fire');
  equal('camのheight', s?.cam.height, 613);
  equal('camのheading', s?.cam.heading, 30);
  equal('camのpitch', s?.cam.pitch, -50);
  equal('ovが2つ', s?.overlays.join(','), 'use,fire');
}
{
  const s = parseHash('#v=1&compare=139.6659,35.7056;139.635,35.725');
  equal('compareが2地点', s?.compare.length, 2);
  near('compare[1].lat', s?.compare[1].lat, 35.725, 1e-9);
}
{
  const s = parseHash('#v=1&spot=139.66893,35.707859&addr=' + encodeURIComponent('東京都中野区中野五丁目'));
  equal('addrがデコードされる', s?.addr, '東京都中野区中野五丁目');
}

console.log('--- parseHash 異常系 ---');
equal('空ハッシュはnull', parseHash(''), null);
equal('#だけはnull', parseHash('#'), null);
equal('文字列以外はnull', parseHash(null), null);
equal('vが無ければnull', parseHash('#spot=139.6659,35.7056'), null);
equal('未知バージョン v=9 はnull', parseHash('#v=9&spot=139.6659,35.7056'), null);
equal('壊れたハッシュはnull', parseHash('#%%%%'), null);
equal('vだけで中身が無ければnull', parseHash('#v=1'), null);
equal('spotが範囲外ならnull（他に情報が無いため）', parseHash('#v=1&spot=999,999'), null);
equal('spotがNaNならnull', parseHash('#v=1&spot=abc,def'), null);
equal('spotの要素数が違えばnull', parseHash('#v=1&spot=139.6659'), null);
{
  const s = parseHash('#v=1&spot=139.6659,35.7056&cam=139.6,35.7,0,0,0');
  equal('height=0の壊れたcamは捨ててspotだけ残る', s?.cam, null);
  check('spotは残る', !!s?.spot);
}
{
  const s = parseHash('#v=1&spot=139.6659,35.7056&cam=1,2,3');
  equal('camの要素数不足は無視', s?.cam, null);
}
{
  const s = parseHash('#v=1&spot=139.6659,35.7056&ov=bogus,use');
  equal('未知のovは落とす', s?.overlays.join(','), 'use');
}
{
  const long = 'あ'.repeat(500);
  const s = parseHash('#v=1&spot=139.6,35.7&addr=' + encodeURIComponent(long));
  equal('addrは上限長で切り詰める', s?.addr.length, ADDR_MAX_LENGTH);
}
{
  const s = parseHash('#v=1&compare=139.6659,35.7056;999,999');
  equal('compareの不正な地点だけ落とす', s?.compare.length, 1);
}
{
  // XSS: <script> を含む住所を渡してもそのまま返るだけ（DOM挿入側でescapeHtmlする）
  const evil = '<script>alert(1)</script>';
  const s = parseHash('#v=1&spot=139.6,35.7&addr=' + encodeURIComponent(evil));
  equal('addrはparse段階では素通し（挿入側でエスケープ）', s?.addr, evil);
}

// ---- 4. 往復 --------------------------------------------------------------------

console.log('--- serialize → parse 往復 ---');
{
  const state = {
    spot: { lon: 139.66893, lat: 35.707859 },
    addr: '東京都中野区中野五丁目',
    cam: { lon: 139.6659, lat: 35.7056, height: 613, heading: 30, pitch: -50 },
    overlays: ['use', 'height'],
  };
  const back = parseHash('#' + serializeState(state));
  equal('往復: spot.lon', back.spot.lon, state.spot.lon);
  equal('往復: spot.lat', back.spot.lat, state.spot.lat);
  equal('往復: addr', back.addr, state.addr);
  equal('往復: cam.height', back.cam.height, state.cam.height);
  equal('往復: cam.pitch', back.cam.pitch, state.cam.pitch);
  equal('往復: overlays', back.overlays.join(','), 'use,height');
}
{
  const state = { compare: [{ lon: 139.6659, lat: 35.7056 }, { lon: 139.635, lat: 35.725 }] };
  const back = parseHash('#' + serializeState(state));
  equal('往復: compare件数', back.compare.length, 2);
  equal('往復: compare[0].lon', back.compare[0].lon, 139.6659);
}
equal('スキーマバージョンは1', SCHEMA_VERSION, 1);

report('share.test.mjs');
