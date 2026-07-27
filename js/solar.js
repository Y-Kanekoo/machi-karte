// 太陽位置計算（NOAA Solar Calculator のアルゴリズム）
// 純粋関数のみ。Cesium非依存・DOM非依存なので Node でそのまま単体テストできる。
// 参考: NOAA ESRL Solar Calculation Details
//   https://gml.noaa.gov/grad/solcalc/calcdetails.html

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

const sin = (d) => Math.sin(d * RAD);
const cos = (d) => Math.cos(d * RAD);
const tan = (d) => Math.tan(d * RAD);

/** UNIX時刻(ms) → ユリウス日 */
export function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * 太陽位置を計算する。
 * @param {Date} date 時刻（内部ではUTCとして扱う。JSTを渡したい場合は正しいDateを作ること）
 * @param {number} lon 経度（東経正）
 * @param {number} lat 緯度（北緯正）
 * @returns {{azimuthDeg:number, elevationDeg:number, refractedElevationDeg:number, declinationDeg:number, hourAngleDeg:number}}
 *   azimuthDeg: 北=0, 東=90, 南=180, 西=270
 *   elevationDeg: 幾何学的な太陽高度（大気差補正なし）
 *   refractedElevationDeg: 大気差補正込みの見かけの高度
 */
export function sunPosition(date, lon, lat) {
  const jd = julianDay(date);
  const t = (jd - 2451545.0) / 36525.0; // ユリウス世紀

  // 太陽の幾何平均黄経・平均近点角
  const L0 = mod360(280.46646 + t * (36000.76983 + t * 0.0003032));
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  // 中心差
  const C =
    sin(M) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    sin(2 * M) * (0.019993 - 0.000101 * t) +
    sin(3 * M) * 0.000289;

  const trueLong = L0 + C;
  const appLong = trueLong - 0.00569 - 0.00478 * sin(125.04 - 1934.136 * t);

  // 黄道傾斜角
  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * cos(125.04 - 1934.136 * t);

  // 赤緯
  const declin = Math.asin(sin(obliqCorr) * sin(appLong)) * DEG;

  // 均時差（分）
  const varY = tan(obliqCorr / 2) * tan(obliqCorr / 2);
  const eqTime =
    4 *
    DEG *
    (varY * sin(2 * L0) -
      2 * e * sin(M) +
      4 * e * varY * sin(M) * cos(2 * L0) -
      0.5 * varY * varY * sin(4 * L0) -
      1.25 * e * e * sin(2 * M));

  // UTCの当日0時からの経過分
  const utcMinutes =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60000;

  // 真太陽時（分）— タイムゾーンはUTC基準なので補正項は 4*lon のみ
  const trueSolarTime = mod(utcMinutes + eqTime + 4 * lon, 1440);

  // 時角（度）: 正午で0、午前は負、午後は正
  let hourAngle = trueSolarTime / 4;
  hourAngle += hourAngle < 0 ? 180 : -180;

  // 天頂角
  const cosZenith = sin(lat) * sin(declin) + cos(lat) * cos(declin) * cos(hourAngle);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith))) * DEG;
  const elevation = 90 - zenith;

  // 方位角（北=0, 時計回り）
  let azimuth;
  const denom = cos(lat) * sin(zenith);
  if (Math.abs(denom) < 1e-9) {
    azimuth = declin > lat ? 0 : 180; // 天頂・天底付近の縮退
  } else {
    const c = Math.min(1, Math.max(-1, (sin(lat) * cos(zenith) - sin(declin)) / denom));
    const a = Math.acos(c) * DEG;
    azimuth = hourAngle > 0 ? mod360(a + 180) : mod360(540 - a);
  }

  return {
    azimuthDeg: azimuth,
    elevationDeg: elevation,
    refractedElevationDeg: elevation + refraction(elevation),
    declinationDeg: declin,
    hourAngleDeg: hourAngle,
    equationOfTimeMin: eqTime,
  };
}

/** 大気差（度）。NOAAの近似式 */
function refraction(elev) {
  if (elev > 85) return 0;
  const te = tan(elev);
  let r;
  if (elev > 5) r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elev > -0.575) r = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
  else r = -20.772 / te;
  return r / 3600;
}

function mod(v, m) {
  return ((v % m) + m) % m;
}
function mod360(v) {
  return mod(v, 360);
}

/**
 * JST（UTC+9）の年月日時分から Date を作る。
 * 太陽位置計算はUTCベースなので、JSTの時刻はここで必ず変換して渡す。
 */
export function jstDate(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, 0));
}

/**
 * 指定日のJST hourStart〜hourEnd を stepMinutes 刻みでサンプリングした
 * 太陽位置の配列を返す。
 * @returns {Array<{date:Date, hourJst:number, azimuthDeg:number, elevationDeg:number}>}
 */
export function sampleDay(year, month, day, lon, lat, opts = {}) {
  const { hourStart = 7, hourEnd = 17, stepMinutes = 20 } = opts;
  const out = [];
  const totalMin = (hourEnd - hourStart) * 60;
  for (let m = 0; m <= totalMin; m += stepMinutes) {
    const hourJst = hourStart + m / 60;
    const date = jstDate(year, month, day, hourStart, m);
    const p = sunPosition(date, lon, lat);
    out.push({ date, hourJst, azimuthDeg: p.azimuthDeg, elevationDeg: p.elevationDeg });
  }
  return out;
}

/**
 * 指定年の二至二分（近似日）。日本の暦での一般的な日付。
 * 厳密な瞬間ではなく「その日の日照を見る」用途なので日付固定で十分。
 */
export function solarKeyDates(year) {
  return [
    { key: 'winter', label: '冬至', month: 12, day: 22 },
    { key: 'equinox', label: '春分', month: 3, day: 21 },
    { key: 'summer', label: '夏至', month: 6, day: 21 },
  ].map((d) => ({ ...d, year }));
}
