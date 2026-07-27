// Webメルカトル タイル座標変換（ブラウザ／Node 共用、依存なし）
//
// 標準のXYZタイル（Google/OSM方式、原点は左上）を前提とする。
// 地理院・ハザードマップポータルのラスタタイルも PLATEAU の MVT も同方式。

/**
 * 経緯度をタイル座標（小数）に変換する。
 * @returns {{xf:number, yf:number}} タイル単位の連続座標（xf=3.25 なら x=3 のタイルの左から25%）
 */
export function lonLatToTileFloat(lon, lat, z) {
  const n = Math.pow(2, z);
  const xf = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { xf, yf };
}

/**
 * 経緯度 → タイル番号 + タイル内ピクセル座標（ラスタタイル用）。
 * @param {number} tileSize タイルの一辺のピクセル数（既定 256）
 * @returns {{z:number, x:number, y:number, px:number, py:number}}
 */
export function lonLatToPixel(lon, lat, z, tileSize = 256) {
  const { xf, yf } = lonLatToTileFloat(lon, lat, z);
  const x = Math.floor(xf);
  const y = Math.floor(yf);
  const clamp = (v) => Math.min(tileSize - 1, Math.max(0, v));
  return {
    z,
    x,
    y,
    px: clamp(Math.floor((xf - x) * tileSize)),
    py: clamp(Math.floor((yf - y) * tileSize)),
  };
}

/**
 * 経緯度 → タイル番号 + タイル内ローカル座標（MVT用、0〜extent）。
 * @param {number} extent MVTのextent（PLATEAU配信は 65536）
 * @returns {{z:number, x:number, y:number, lx:number, ly:number}}
 */
export function lonLatToTileLocal(lon, lat, z, extent = 4096) {
  const { xf, yf } = lonLatToTileFloat(lon, lat, z);
  const x = Math.floor(xf);
  const y = Math.floor(yf);
  return {
    z,
    x,
    y,
    lx: (xf - x) * extent,
    ly: (yf - y) * extent,
  };
}

/** タイル番号の左上隅の経緯度（逆変換。テスト・検算用） */
export function tileToLonLat(x, y, z) {
  const n = Math.pow(2, z);
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lon, lat: (latRad * 180) / Math.PI };
}

/** URLテンプレート（{z}/{x}/{y}）を展開する */
export function tileUrl(template, z, x, y) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

/**
 * 点がリング（閉じていなくてよい）の内部にあるかを ray-casting 法で判定する。
 * @param {number} px @param {number} py
 * @param {Array<{x:number,y:number}>} ring
 */
export function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y;
    const xj = ring[j].x, yj = ring[j].y;
    const intersect = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * MVTフィーチャのジオメトリ（リング配列）に対する点内包判定。
 * MVTは外環と穴を区別しないリスト（loadGeometry()の戻り）で来るため、
 * 全リングの交差数の偶奇で判定する（＝穴は自動的に除外される）。
 */
export function pointInRings(px, py, rings) {
  let inside = false;
  for (const ring of rings) {
    if (pointInRing(px, py, ring)) inside = !inside;
  }
  return inside;
}
