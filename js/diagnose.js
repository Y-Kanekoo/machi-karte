// 街カルテ: 地点診断のオーケストレータ + 診断カードDOM生成
//
// 各項目は独立した非同期処理で、取得でき次第カードに順次埋める（全体をブロックしない）。
// 失敗した項目は「判定できませんでした」を出して他の項目には影響させない。

import { escapeHtml } from './util.js';
import { search as geocodeSearch } from './geocode.js';
import { queryFlood, queryLandslide } from './hazard.js';
import { queryZoning } from './zoning.js';
import { estimateSunlight, estimateBaseHeight, prepareTiles, MIN_SUN_ELEVATION } from './sunlight.js';

const SPINNER = '<span class="diag-loading"><span class="spinner"></span>取得中…</span>';

/** 洪水ランク → 表示色 */
const FLOOD_COLORS = {
  '区域外': '#7fd6a2',
  '0.5m未満': '#f7f5a9',
  '0.5〜3.0m': '#ffd8c0',
  '3.0〜5.0m': '#ffb7b7',
  '5.0〜10.0m': '#ff9191',
  '10.0〜20.0m': '#f285c9',
  '20.0m以上': '#dc7adc',
};

export function initDiagnosis(ctx) {
  const { viewer, getCurrentBuildingTileset, buildingTableHtml, setStatus } = ctx;

  const panel = document.getElementById('diagnosisPanel');
  const body = document.getElementById('diagBody');
  const closeBtn = document.getElementById('closeDiag');
  const toggle = document.getElementById('diagMode');
  const searchInput = document.getElementById('searchInput');
  const searchBtn = document.getElementById('searchBtn');
  const searchResults = document.getElementById('searchResults');
  const searchMsg = document.getElementById('searchMsg');

  const closeHandlers = [];
  let pinEntity = null;
  let runToken = 0;
  let lastResult = null;

  // ---- ピン --------------------------------------------------------------

  function setPin(lon, lat, label) {
    clearPin();
    pinEntity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
      point: {
        pixelSize: 14,
        color: Cesium.Color.fromCssColorString('#ff4d4d'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 3,
        heightReference: Cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: label || '診断地点',
        font: '13px "Hiragino Kaku Gothic ProN", sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('rgba(20,26,34,0.85)'),
        pixelOffset: new Cesium.Cartesian2(0, -26),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    return pinEntity;
  }

  function clearPin() {
    if (pinEntity) {
      viewer.entities.remove(pinEntity);
      pinEntity = null;
    }
  }

  // ---- カードDOM ----------------------------------------------------------

  function sectionShell() {
    body.innerHTML = `
      <section class="diag-sec" data-sec="place">
        <h3>📍 地点</h3>
        <div class="diag-content" id="secPlace">${SPINNER}</div>
      </section>
      <section class="diag-sec" data-sec="flood">
        <h3>🌊 洪水浸水想定（想定最大規模）</h3>
        <div class="diag-content" id="secFlood">${SPINNER}</div>
      </section>
      <section class="diag-sec" data-sec="landslide">
        <h3>⛰️ 土砂災害警戒区域</h3>
        <div class="diag-content" id="secLandslide">${SPINNER}</div>
      </section>
      <section class="diag-sec" data-sec="zoning">
        <h3>🏘️ 都市計画</h3>
        <div class="diag-content" id="secZoning">${SPINNER}</div>
      </section>
      <section class="diag-sec" data-sec="sun">
        <h3>☀️ 日照（簡易シミュレーション）</h3>
        <div class="diag-content" id="secSun">${SPINNER}</div>
      </section>
      <section class="diag-sec hidden" data-sec="building">
        <h3>🏢 建物</h3>
        <div class="diag-content" id="secBuilding"></div>
      </section>
      <p class="diag-source">
        出典:
        <a href="https://disaportal.gsi.go.jp/" target="_blank" rel="noopener">ハザードマップポータルサイト</a>（洪水・土砂災害）／
        <a href="https://www.mlit.go.jp/plateau/" target="_blank" rel="noopener">Project PLATEAU</a>（都市計画決定情報・建物）／
        <a href="https://msearch.gsi.go.jp/" target="_blank" rel="noopener">国土地理院 住所検索API</a>
      </p>`;
  }

  const $ = (id) => document.getElementById(id);
  function fill(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }
  function failMsg(text) {
    return `<span class="diag-fail">${escapeHtml(text)}</span>`;
  }

  // ---- 各項目のレンダリング ------------------------------------------------

  function renderPlace(lon, lat, title) {
    const name = title ? escapeHtml(title) : '地図上で指定した地点';
    return `<div class="diag-title">${name}</div>
      <div class="diag-sub">東経 ${lon.toFixed(6)} / 北緯 ${lat.toFixed(6)}</div>`;
  }

  function renderFlood(r) {
    const color = FLOOD_COLORS[r.rank] || '#cccccc';
    const note = r.rank === '区域外'
      ? '想定最大規模の洪水でも浸水想定区域には含まれません。'
      : r.rank === '判定不能'
        ? 'タイルの色が凡例と一致しませんでした。'
        : '想定最大規模（おおむね1000年に1回程度）の降雨による想定です。';
    return `<div class="diag-badge" style="background:${color}">${escapeHtml(r.rank)}</div>
      <div class="diag-note">${escapeHtml(note)}</div>`;
  }

  function renderLandslide(list) {
    const rows = list
      .map((x) => {
        const inZone = x.rank !== '区域外';
        return `<div class="diag-row">
          <span class="diag-key">${escapeHtml(x.label)}</span>
          <span class="diag-val ${inZone ? 'warn' : ''}">${escapeHtml(x.rank)}</span>
        </div>`;
      })
      .join('');
    const any = list.some((x) => x.rank !== '区域外');
    const note = any
      ? '警戒区域に該当します。詳細は東京都の土砂災害警戒区域等の指定図をご確認ください。'
      : '3種いずれの警戒区域にも該当しません。';
    return rows + `<div class="diag-note">${escapeHtml(note)}</div>`;
  }

  function renderZoning(z) {
    if (z.error) return failMsg(z.error);
    const rows = [];
    if (z.use) {
      rows.push(`<div class="diag-badge zone">${escapeHtml(z.use.name || '不明')}</div>`);
      const nums = [];
      if (z.use.coverage != null) nums.push(`建蔽率 ${z.use.coverage}%`);
      if (z.use.floorArea != null) nums.push(`容積率 ${z.use.floorArea}%`);
      if (z.use.minSiteArea != null) nums.push(`敷地面積の最低限度 ${z.use.minSiteArea}㎡`);
      if (nums.length) rows.push(`<div class="diag-sub">${escapeHtml(nums.join('　'))}</div>`);
    } else {
      rows.push(`<div class="diag-row"><span class="diag-key">用途地域</span><span class="diag-val">該当なし</span></div>`);
    }
    rows.push(`<div class="diag-row"><span class="diag-key">防火地域</span><span class="diag-val">${
      escapeHtml(z.fire?.name || '指定なし')}</span></div>`);
    rows.push(`<div class="diag-row"><span class="diag-key">高度地区</span><span class="diag-val">${
      escapeHtml(z.height?.name || '指定なし')}</span></div>`);
    if (z.use?.location) {
      rows.push(`<div class="diag-note">告示上の区域名: ${escapeHtml(z.use.location)}</div>`);
    }
    return rows.join('');
  }

  function renderSunlight(result, baseInfo) {
    if (result.error && !result.days?.length) return failMsg('日照: ' + result.error);
    const bars = result.days
      .map((d) => {
        const cells = d.slots
          .map((s) => `<i class="${s.lit ? 'lit' : 'dark'}" title="${s.hourJst.toFixed(2)}時"></i>`)
          .join('');
        return `<div class="sun-day">
          <div class="sun-head"><span>${escapeHtml(d.label)}（${escapeHtml(d.dateLabel)}）</span><b>${d.hours.toFixed(1)} h</b></div>
          <div class="sun-bar">${cells}</div>
        </div>`;
      })
      .join('');
    const scale = `<div class="sun-scale"><span>${result.hourStart}時</span><span>12時</span><span>${result.hourEnd}時</span></div>`;
    const note = `${result.hourStart}:00〜${result.hourEnd}:00 JSTを20分刻みでサンプリング。`
      + `読み込み済みの建物のみを考慮した簡易計算です（地形・未読込の建物・樹木は考慮しません）。`
      + `太陽高度${MIN_SUN_ELEVATION}度未満は日照に数えません。地面高さ ${baseInfo.height.toFixed(1)}m（${baseInfo.source}）。`;
    const warn = result.error ? `<div class="diag-fail">${escapeHtml(result.error)}</div>` : '';
    return bars + scale + warn + `<div class="diag-note">${escapeHtml(note)}</div>`;
  }

  // ---- 診断の実行 ----------------------------------------------------------

  /**
   * @param {{lon:number, lat:number, title?:string|null, picked?:object|null, fly?:boolean}} req
   */
  async function diagnose(req) {
    const { lon, lat, title = null, picked = null, fly = true } = req;
    const token = ++runToken;
    const alive = () => token === runToken;

    panel.classList.remove('hidden');
    sectionShell();
    fill('secPlace', renderPlace(lon, lat, title));
    setPin(lon, lat, title || '診断地点');
    lastResult = { lon, lat, title, flood: null, landslide: null, zoning: null, sunlight: null };

    // 建物属性（同期・ピック時のみ）
    if (picked) {
      const sec = body.querySelector('[data-sec="building"]');
      sec.classList.remove('hidden');
      fill('secBuilding', `<table class="diag-table">${buildingTableHtml(picked)}</table>`);
    }

    // 洪水
    queryFlood(lon, lat)
      .then((r) => { if (alive()) { lastResult.flood = r; fill('secFlood', renderFlood(r)); } })
      .catch((e) => {
        console.warn('flood failed', e);
        if (alive()) fill('secFlood', failMsg('洪水浸水想定を取得できませんでした'));
      });

    // 土砂災害
    queryLandslide(lon, lat)
      .then((r) => { if (alive()) { lastResult.landslide = r; fill('secLandslide', renderLandslide(r)); } })
      .catch((e) => {
        console.warn('landslide failed', e);
        if (alive()) fill('secLandslide', failMsg('土砂災害警戒区域を取得できませんでした'));
      });

    // 都市計画
    queryZoning(lon, lat)
      .then((r) => { if (alive()) { lastResult.zoning = r; fill('secZoning', renderZoning(r)); } })
      .catch((e) => {
        console.warn('zoning failed', e);
        if (alive()) fill('secZoning', failMsg('都市計画情報を取得できませんでした'));
      });

    // 日照（重いので最後、カメラ移動＋タイル読み込み待ちを挟む）
    runSunlight(lon, lat, picked, alive, fly).catch((e) => {
      console.warn('sunlight failed', e);
      if (alive()) fill('secSun', failMsg('日照: 計算できませんでした'));
    });
  }

  async function runSunlight(lon, lat, picked, alive, fly) {
    const tileset = getCurrentBuildingTileset();
    fill('secSun', '<span class="diag-loading"><span class="spinner"></span>周辺の建物を読み込み中…</span>');
    if (fly) {
      await prepareTiles(viewer, tileset, lon, lat);
    }
    if (!alive()) return;

    const baseInfo = await estimateBaseHeight(viewer, lon, lat, picked);
    if (!alive()) return;

    fill('secSun', '<span class="diag-loading"><span class="spinner"></span>日照を計算中… <b id="sunPct">0%</b></span>');
    const result = await estimateSunlight(viewer, tileset, lon, lat, baseInfo.height, {
      excludeEntities: pinEntity ? [pinEntity] : [],
      onProgress: (f) => {
        const el = $('sunPct');
        if (el) el.textContent = Math.round(f * 100) + '%';
      },
    });
    if (!alive()) return;
    lastResult.sunlight = result;
    lastResult.baseHeight = baseInfo;
    fill('secSun', renderSunlight(result, baseInfo));
  }

  function close() {
    runToken++;
    panel.classList.add('hidden');
    clearPin();
    for (const h of closeHandlers) h();
  }

  closeBtn.addEventListener('click', close);

  // ---- 検索UI --------------------------------------------------------------

  function showSearchMsg(text, isError) {
    searchMsg.textContent = text || '';
    searchMsg.classList.toggle('hidden', !text);
    searchMsg.classList.toggle('error', !!isError);
  }

  function hideResults() {
    searchResults.classList.add('hidden');
    searchResults.innerHTML = '';
  }

  function flyToPoint(lon, lat) {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 600),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 },
      duration: 2.0,
    });
  }

  async function pickResult(r) {
    hideResults();
    showSearchMsg('');
    flyToPoint(r.lon, r.lat);
    // flyTo の途中でも診断は開始してよい（日照計算側で改めてカメラを合わせる）
    await diagnose({ lon: r.lon, lat: r.lat, title: r.title, picked: null });
  }

  async function doSearch() {
    const q = searchInput.value.trim();
    hideResults();
    if (!q) return;
    showSearchMsg('検索中…');
    searchBtn.disabled = true;
    try {
      const results = await geocodeSearch(q, 5);
      if (!results.length) {
        showSearchMsg('見つかりませんでした', true);
        return;
      }
      showSearchMsg('');
      if (results.length === 1) {
        await pickResult(results[0]);
        return;
      }
      searchResults.innerHTML = results
        .map((r, i) => `<li data-i="${i}">${escapeHtml(r.title)}</li>`)
        .join('');
      searchResults.classList.remove('hidden');
      searchResults.querySelectorAll('li').forEach((li) => {
        li.addEventListener('click', () => pickResult(results[Number(li.dataset.i)]));
      });
    } catch (e) {
      console.warn('geocode failed', e);
      showSearchMsg('住所検索に失敗しました', true);
    } finally {
      searchBtn.disabled = false;
    }
  }

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
    if (e.key === 'Escape') hideResults();
  });

  // ---- 診断モードトグル -----------------------------------------------------

  function setActive(on) {
    toggle.checked = on;
    document.body.classList.toggle('diag-mode', on);
    if (setStatus) setStatus(on ? '地図をクリックして診断する地点を指定してください' : '');
  }
  toggle.addEventListener('change', () => setActive(toggle.checked));

  return {
    diagnose,
    close,
    isActive: () => toggle.checked,
    setActive,
    onClose: (fn) => closeHandlers.push(fn),
    getLastResult: () => lastResult,
    searchAndDiagnose: async (q) => {
      searchInput.value = q;
      await doSearch();
    },
    isOpen: () => !panel.classList.contains('hidden'),
  };
}
