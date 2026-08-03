// 都市計画レイヤーのカラーオーバーレイ
//
// PLATEAU配信のMVT（ベクトルタイル）をその場でcanvasにラスタライズし、
// Cesium の ImageryProvider として背景地図に重ねる。
//
// 実測（2026-07-27）: UseDistrict の MVT は z=10〜16 で配信されている（z=17 は404）。
//   z=10 のタイルは 2.6MB あるので、実用ズーム帯の z=14〜16 に限定して使う。
//   （z14 ≒ 135KB / z15 ≒ 49KB / z16 ≒ 17KB）
//
// タイル取得は zoning.js の共用キャッシュ（loadMvtLib / fetchTileBuffer）を使い、
// 点診断とオーバーレイで同じタイルを二重に取りに行かないようにしている。

import {
  ZONING_TILES,
  USE_DISTRICT_COLORS,
  USE_DISTRICT_OTHER_COLOR,
  FIRE_COLORS,
  HEIGHT_DISTRICT_COLOR,
  AREA_RECT,
  OVERLAY_KEYS,
  OVERLAY_MIN_LEVEL,
  OVERLAY_MAX_LEVEL,
  OVERLAY_TILE_CACHE_MAX,
  OVERLAY_DEFAULT_ALPHA,
} from './config.js';
import { loadMvtLib, fetchTileBuffer } from './zoning.js';
import { tileUrl } from './tilemath.js';
import { escapeHtml } from './util.js';
import { resolveServiceRect } from './area.js';

export const TILE_SIZE = 256;

/**
 * フィーチャの属性からオーバーレイの塗り色を決める。
 * DOM非依存なので Node からも単体テストできる。
 *
 * @param {string} kind 'use' | 'fire' | 'height'
 * @param {object} props MVTフィーチャの properties
 * @returns {string} CSSカラー
 */
export function featureColor(kind, props) {
  const fn = props?.urf_function != null ? String(props.urf_function) : '';
  if (kind === 'use') return USE_DISTRICT_COLORS[fn] || USE_DISTRICT_OTHER_COLOR;
  if (kind === 'fire') return FIRE_COLORS[fn] || USE_DISTRICT_OTHER_COLOR;
  return HEIGHT_DISTRICT_COLOR;
}

/**
 * MVTのリング（タイル座標 0〜extent）を 256px canvas 座標のパスへ変換する。
 * 変換は線形（px = v / extent * 256）のみ。タイル境界の切り落としは canvas に任せる。
 *
 * @param {Array<Array<{x:number,y:number}>>} rings feature.loadGeometry() の戻り
 * @param {number} extent
 * @param {number} size 出力サイズ（既定 256）
 * @returns {Array<Array<[number, number]>>}
 */
export function ringsToPath(rings, extent, size = TILE_SIZE) {
  const k = size / extent;
  const out = [];
  for (const ring of rings) {
    if (!ring || ring.length < 3) continue; // 3点未満は面にならない
    out.push(ring.map((p) => [p.x * k, p.y * k]));
  }
  return out;
}

/** パス配列を canvas コンテキストへ流し込む（evenodd で穴を抜く） */
function drawPaths(ctx, paths, color) {
  if (!paths.length) return;
  ctx.beginPath();
  for (const ring of paths) {
    ctx.moveTo(ring[0][0], ring[0][1]);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0], ring[i][1]);
    ctx.closePath();
  }
  ctx.fillStyle = color;
  ctx.fill('evenodd');
}

function createCanvas(size) {
  // Cesium のテクスチャ生成は HTMLCanvasElement をそのまま受け取れる。
  // OffscreenCanvas は環境差（transferToImageBitmap の有無）があるため使わない。
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/**
 * MVTのタイルバッファを 256×256 の canvas に描画する。
 * @returns {HTMLCanvasElement}
 */
export function renderTileToCanvas(kind, tile, size = TILE_SIZE) {
  const canvas = createCanvas(size);
  const ctx = canvas.getContext('2d');
  if (!tile) return canvas; // 空タイル＝透明
  for (const name of Object.keys(tile.layers)) {
    const layer = tile.layers[name];
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const paths = ringsToPath(f.loadGeometry(), layer.extent, size);
      drawPaths(ctx, paths, featureColor(kind, f.properties));
    }
  }
  return canvas;
}

/**
 * 都市計画MVTをラスタライズする Cesium ImageryProvider。
 *
 * Cesium 1.130 の ImageryProvider は「ready 不要・プロパティ直参照」のインターフェースで、
 * ImageryLayer は tilingScheme / tileWidth / tileHeight / minimumLevel / maximumLevel /
 * rectangle / tileDiscardPolicy / errorEvent / credit / hasAlphaChannel /
 * getTileCredits() / requestImage() / pickFeatures() を参照する。
 */
export class ZoningImageryProvider {
  /**
   * @param {{kind:string, url:string, minimumLevel?:number, maximumLevel?:number,
   *          solidColor?:string, rectangle?:object}} options
   */
  constructor(options) {
    this._kind = options.kind;
    this._url = options.url;
    this._solidColor = options.solidColor || null; // 起動確認用の最小プロバイダモード
    this._tilingScheme = new Cesium.WebMercatorTilingScheme();
    this._tileWidth = TILE_SIZE;
    this._tileHeight = TILE_SIZE;
    this._minimumLevel = options.minimumLevel ?? OVERLAY_MIN_LEVEL;
    this._maximumLevel = options.maximumLevel ?? OVERLAY_MAX_LEVEL;
    const rect = options.rectangle || AREA_RECT;
    this._rectangle = Cesium.Rectangle.fromDegrees(
      rect.west, rect.south, rect.east, rect.north
    );
    this._errorEvent = new Cesium.Event();
    this._credit = new Cesium.Credit('都市計画決定情報 (Project PLATEAU)');
    this._cache = new Map(); // "z/x/y" -> canvas（挿入順＝LRU代わり）
    this.stats = { requested: 0, drawn: 0, empty: 0, failed: 0 };
  }

  get tilingScheme() { return this._tilingScheme; }
  get tileWidth() { return this._tileWidth; }
  get tileHeight() { return this._tileHeight; }
  get minimumLevel() { return this._minimumLevel; }
  get maximumLevel() { return this._maximumLevel; }
  get rectangle() { return this._rectangle; }
  get tileDiscardPolicy() { return undefined; }
  get errorEvent() { return this._errorEvent; }
  get credit() { return this._credit; }
  get proxy() { return undefined; }
  get hasAlphaChannel() { return true; }
  // 1.104 以前との互換のため残す（1.130 では参照されない）
  get ready() { return true; }
  get readyPromise() { return Promise.resolve(true); }

  getTileCredits() { return undefined; }

  pickFeatures() { return undefined; }

  _cacheGet(key) {
    if (!this._cache.has(key)) return undefined;
    const v = this._cache.get(key);
    this._cache.delete(key);
    this._cache.set(key, v); // 参照したものを末尾へ（LRU）
    return v;
  }

  _cacheSet(key, canvas) {
    this._cache.set(key, canvas);
    while (this._cache.size > OVERLAY_TILE_CACHE_MAX) {
      this._cache.delete(this._cache.keys().next().value);
    }
  }

  /**
   * @returns {Promise<HTMLCanvasElement>} 失敗時も例外は投げず透明タイルを返す
   */
  async requestImage(x, y, level) {
    this.stats.requested++;
    const key = `${level}/${x}/${y}`;
    const hit = this._cacheGet(key);
    if (hit) return hit;

    if (this._solidColor) {
      const canvas = createCanvas(TILE_SIZE);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = this._solidColor;
      ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
      this._cacheSet(key, canvas);
      this.stats.drawn++;
      return canvas;
    }

    let canvas;
    try {
      const { Pbf, VectorTile } = await loadMvtLib();
      const buf = await fetchTileBuffer(tileUrl(this._url, level, x, y));
      if (!buf) {
        this.stats.empty++;
        canvas = createCanvas(TILE_SIZE); // 404 = 配信範囲外 → 透明
      } else {
        canvas = renderTileToCanvas(this._kind, new VectorTile(new Pbf(buf)), TILE_SIZE);
        this.stats.drawn++;
      }
    } catch (e) {
      // デコード失敗で Cesium のタイル読み込みを止めない（透明を返して続行）
      console.warn('zoning-overlay: tile failed', key, e);
      this.stats.failed++;
      canvas = createCanvas(TILE_SIZE);
    }
    this._cacheSet(key, canvas);
    return canvas;
  }
}

// ---- UI（トグル・透明度スライダー・凡例） ---------------------------------------

/** 凡例に出す項目（用途地域は config の配色定義をそのまま使う） */
function legendItems(key) {
  if (key === 'use') {
    return Object.entries(USE_DISTRICT_COLORS)
      .map(([label, color]) => ({ label, color }))
      .concat([{ label: 'その他', color: USE_DISTRICT_OTHER_COLOR }]);
  }
  if (key === 'fire') {
    return Object.entries(FIRE_COLORS).map(([label, color]) => ({ label, color }));
  }
  return [{ label: '高度地区', color: HEIGHT_DISTRICT_COLOR }];
}

/**
 * 都市計画レイヤーのトグル・透明度・凡例を配線する。
 *
 * @param {{viewer: object, requestRender?:()=>void}} ctx
 */
export function initZoningOverlay(ctx) {
  const {
    viewer,
    areaConfig = null,
    requestRender = () => viewer.scene.requestRender(),
  } = ctx;
  const zoningTiles = areaConfig?.zoning || ZONING_TILES;
  const areaRectangle = resolveServiceRect(areaConfig);
  const layers = {};    // key -> Cesium.ImageryLayer
  const providers = {}; // key -> ZoningImageryProvider
  let alpha = OVERLAY_DEFAULT_ALPHA;

  const legendBox = document.getElementById('zoningLegend');
  const alphaRow = document.getElementById('overlayAlphaRow');
  const alphaInput = document.getElementById('overlayAlpha');
  const alphaLabel = document.getElementById('overlayAlphaLabel');
  const hint = document.getElementById('overlayHint');

  function renderLegend() {
    if (!legendBox) return;
    const active = OVERLAY_KEYS.filter((k) => layers[k]);
    if (!active.length) {
      legendBox.classList.add('hidden');
      legendBox.innerHTML = '';
      return;
    }
    legendBox.innerHTML = active
      .map((k) => {
        const rows = legendItems(k)
          .map(
            (it) =>
              `<div class="legend-row"><span class="swatch" style="background:${it.color}"></span>${escapeHtml(it.label)}</div>`
          )
          .join('');
        return `<div class="legend-block"><strong>${escapeHtml(
          zoningTiles[k]?.label || ZONING_TILES[k].label,
        )}</strong>${rows}</div>`;
      })
      .join('');
    legendBox.classList.remove('hidden');
  }

  function updateChrome() {
    const any = OVERLAY_KEYS.some((k) => layers[k]);
    if (alphaRow) alphaRow.classList.toggle('hidden', !any);
    if (hint) {
      if (!areaRectangle) {
        hint.textContent = 'このエリアは範囲不明のため、都市計画レイヤーの地図表示を利用できません。';
        hint.classList.remove('hidden');
      } else {
        hint.textContent =
          '重なりで見づらいときは背景地図を「淡色地図」に切り替えると見やすくなります。';
        hint.classList.toggle('hidden', !any);
      }
    }
    renderLegend();
  }

  function setEnabled(key, on) {
    if (!OVERLAY_KEYS.includes(key)) return;
    const checkbox = document.getElementById('ov-' + key);
    if (!zoningTiles[key] || !areaRectangle) {
      if (checkbox) checkbox.checked = false;
      return;
    }
    if (on && !layers[key]) {
      const provider = new ZoningImageryProvider({
        kind: key,
        url: zoningTiles[key].url,
        rectangle: areaRectangle,
      });
      // addImageryProvider ではなく ImageryLayer を明示的に作って add する
      // （Cesium 1.130 で確実に通る経路）
      const layer = new Cesium.ImageryLayer(provider, { alpha });
      viewer.imageryLayers.add(layer);
      providers[key] = provider;
      layers[key] = layer;
    } else if (!on && layers[key]) {
      viewer.imageryLayers.remove(layers[key], true);
      delete layers[key];
      delete providers[key];
    }
    if (checkbox) checkbox.checked = !!layers[key];
    updateChrome();
    requestRender();
  }

  function setAlpha(v) {
    alpha = Math.min(1, Math.max(0, v));
    for (const key of Object.keys(layers)) layers[key].alpha = alpha;
    if (alphaLabel) alphaLabel.textContent = Math.round(alpha * 100) + '%';
    requestRender();
  }

  for (const key of OVERLAY_KEYS) {
    const el = document.getElementById('ov-' + key);
    if (el) el.addEventListener('change', () => setEnabled(key, el.checked));
  }
  if (alphaInput) {
    alphaInput.addEventListener('input', () => setAlpha(Number(alphaInput.value) / 100));
    alphaInput.value = String(Math.round(OVERLAY_DEFAULT_ALPHA * 100));
  }
  if (alphaLabel) alphaLabel.textContent = Math.round(OVERLAY_DEFAULT_ALPHA * 100) + '%';
  updateChrome();

  /**
   * 起動確認用: 全タイル単色のプロバイダを1枚足す。
   * カスタムImageryProviderがCesiumの要件を満たしているかを、MVT描画と切り離して確かめる。
   * （e2eの「最小プロバイダ」チェックから呼ぶ）
   */
  function addSolidTestLayer(color = '#ff00ff') {
    if (!areaRectangle) return null;
    const provider = new ZoningImageryProvider({
      kind: 'use',
      url: '',
      solidColor: color,
      rectangle: areaRectangle,
    });
    const layer = new Cesium.ImageryLayer(provider, { alpha });
    viewer.imageryLayers.add(layer);
    requestRender();
    return {
      layer,
      provider,
      remove: () => {
        const removed = viewer.imageryLayers.remove(layer, true);
        if (removed) requestRender();
        return removed;
      },
    };
  }

  return {
    setEnabled,
    setAlpha,
    addSolidTestLayer,
    getAlpha: () => alpha,
    getActive: () => OVERLAY_KEYS.filter((k) => layers[k]),
    getLayer: (key) => layers[key] || null,
    getProvider: (key) => providers[key] || null,
  };
}
