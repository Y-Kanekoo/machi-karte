// solar.js 単体テスト（Node直接実行・ブラウザ不要）
// 実行: node test/solar.test.mjs

import { sunPosition, jstDate, sampleDay, solarKeyDates } from '../js/solar.js';
import { check, near, report } from './harness.mjs';

// 東京（中野駅付近）
const LON = 139.6659;
const LAT = 35.7010;

// 理論値: 南中高度 = 90 - 緯度 ± 黄道傾斜角(23.44°)
//   冬至: 90 - 35.701 - 23.44 = 30.86°
//   夏至: 90 - 35.701 + 23.44 = 77.74°
//   春分: 90 - 35.701          = 54.30°
function maxElevation(year, month, day) {
  let best = -90;
  let bestHour = null;
  // 1分刻みで10:00〜14:00 JSTを走査して南中高度を求める
  for (let m = 0; m <= 240; m++) {
    const d = jstDate(year, month, day, 10, m);
    const p = sunPosition(d, LON, LAT);
    if (p.elevationDeg > best) {
      best = p.elevationDeg;
      bestHour = 10 + m / 60;
    }
  }
  return { elevation: best, hourJst: bestHour };
}

const winter = maxElevation(2025, 12, 22);
const summer = maxElevation(2026, 6, 21);
const equinox = maxElevation(2026, 3, 21);

console.log(`  冬至(2025-12-22) 南中: ${winter.elevation.toFixed(2)}° at ${winter.hourJst.toFixed(2)}h JST`);
console.log(`  春分(2026-03-21) 南中: ${equinox.elevation.toFixed(2)}° at ${equinox.hourJst.toFixed(2)}h JST`);
console.log(`  夏至(2026-06-21) 南中: ${summer.elevation.toFixed(2)}° at ${summer.hourJst.toFixed(2)}h JST`);

near('冬至の南中高度 ≒ 30.9°', winter.elevation, 30.9, 1.0);
near('夏至の南中高度 ≒ 77.8°', summer.elevation, 77.8, 1.0);
near('春分の南中高度 ≒ 54.3°', equinox.elevation, 54.3, 1.0);

// 東京の南中は JST 11:30〜12:00 頃（東経139.67 は明石135°より東なので正午より早い）
check('冬至の南中時刻が11:00〜12:30 JST', winter.hourJst > 11.0 && winter.hourJst < 12.5, `${winter.hourJst}`);
check('夏至の南中時刻が11:00〜12:30 JST', summer.hourJst > 11.0 && summer.hourJst < 12.5, `${summer.hourJst}`);

// 南中時の方位角は南（180°）付近
const noonWinter = sunPosition(jstDate(2025, 12, 22, 11, 39), LON, LAT);
near('冬至の南中時の方位角 ≒ 180°', noonWinter.azimuthDeg, 180, 3);

// 赤緯の検証（冬至 ≒ -23.44°、夏至 ≒ +23.44°、春分 ≒ 0°）
near('冬至の太陽赤緯 ≒ -23.4°', sunPosition(jstDate(2025, 12, 22, 12, 0), LON, LAT).declinationDeg, -23.44, 0.3);
near('夏至の太陽赤緯 ≒ +23.4°', sunPosition(jstDate(2026, 6, 21, 12, 0), LON, LAT).declinationDeg, 23.44, 0.3);
near('春分の太陽赤緯 ≒ 0°', sunPosition(jstDate(2026, 3, 21, 12, 0), LON, LAT).declinationDeg, 0, 0.6);

// 日の出方位: 春分の日の出はほぼ真東（90°）
let sunriseAz = null;
for (let m = 0; m < 24 * 60; m++) {
  const p = sunPosition(jstDate(2026, 3, 21, 0, m), LON, LAT);
  if (p.elevationDeg > 0) { sunriseAz = p.azimuthDeg; break; }
}
near('春分の日の出方位 ≒ 90°(真東)', sunriseAz, 90, 3);

// 夜は高度が負
const midnight = sunPosition(jstDate(2026, 3, 21, 0, 0), LON, LAT);
check('深夜0時の太陽高度が負', midnight.elevationDeg < -20, `${midnight.elevationDeg}`);

// 方位角は常に 0〜360
let azOk = true;
for (let h = 0; h < 24; h++) {
  const a = sunPosition(jstDate(2026, 7, 27, h, 0), LON, LAT).azimuthDeg;
  if (!(a >= 0 && a < 360)) azOk = false;
}
check('方位角が常に0〜360の範囲', azOk);

// 大気差補正: 地平線付近では見かけの高度が幾何高度より高い
const lowSun = (() => {
  for (let m = 0; m < 24 * 60; m++) {
    const p = sunPosition(jstDate(2026, 3, 21, 0, m), LON, LAT);
    if (p.elevationDeg > -0.2 && p.elevationDeg < 0.2) return p;
  }
  return null;
})();
check('地平線付近で大気差補正が正（約0.5°）',
  lowSun && lowSun.refractedElevationDeg - lowSun.elevationDeg > 0.4,
  lowSun ? String(lowSun.refractedElevationDeg - lowSun.elevationDeg) : 'not found');

// sampleDay のサンプル数（7:00〜17:00を20分刻み → 31点）
const samples = sampleDay(2025, 12, 22, LON, LAT);
check('sampleDayが31サンプル返す', samples.length === 31, `${samples.length}`);
check('sampleDayの先頭が7:00 JST', samples[0].hourJst === 7);
check('sampleDayの末尾が17:00 JST', samples[30].hourJst === 17);

// solarKeyDates
const keys = solarKeyDates(2026);
check('solarKeyDatesが3日付返す', keys.length === 3 && keys[0].label === '冬至');

report('solar.test.mjs');
