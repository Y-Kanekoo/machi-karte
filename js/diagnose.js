// 街カルテ: 地点診断のオーケストレータ + 診断カードDOM生成
//
// 各項目は独立した非同期処理で、取得でき次第カードに順次埋める（全体をブロックしない）。
// 失敗した項目は「判定できませんでした」を出して他の項目には影響させない。

import { escapeHtml } from './util.js';
import { search as geocodeSearch } from './geocode.js';
import { queryFlood, queryFloodKeizoku, queryFloodL1, queryLandslide } from './hazard.js';
import { queryNearestShelters, formatDistance } from './shelter.js';
import {
  showFloodDepth,
  clearFloodDepth,
  isFloodDepthVisible,
  canShowFloodDepth,
  floodVizDepth,
  resolveBaseHeight,
} from './floodviz.js';
import { queryZoning } from './zoning.js';
import { resolveServiceRect } from './area.js';
import { isValidCityCode, serializeState } from './share.js';
import {
  estimateSunlight,
  estimateBaseHeight,
  preloadForSunlight,
  boostTilesetCache,
  floorHeights,
  floorHeightsForFeature,
  MIN_SUN_ELEVATION,
  DEFAULT_BASE_HEIGHT,
} from './sunlight.js';
import {
  FLOOD_COLORS,
  HEIGHT_PROP_CANDIDATES,
  AREA_RECT,
  DEFAULT_CITY,
  HISTORY_MAX,
  HISTORY_STORAGE_KEY,
  COLLAPSE_STORAGE_KEY,
  GEOLOCATION_TIMEOUT,
  FLOOD_VIZ_RADIUS,
  FLOOD_VIZ_MAX_DEPTH,
} from './config.js';

/**
 * sessionStorage の読み書き。
 * プライベートモード等で例外になっても診断本体には影響させない（黙って既定値を返す）。
 */
function sessionGet(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.warn('sessionStorage read failed', key, e);
    return fallback;
  }
}

function sessionSet(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('sessionStorage write failed', key, e);
  }
}

const SPINNER = '<span class="diag-loading"><span class="spinner"></span>取得中…</span>';

/** R3 F3-1: 視点高さセレクタ変更から再計算までのデバウンス（ms） */
const SUN_RECALC_DEBOUNCE_MS = 400;

/** 対応エリア矩形の内側か。範囲外では建物3Dと日照が使えない旨を出す */
export function isInServiceArea(lon, lat, rect = AREA_RECT) {
  return (
    lon >= rect.west && lon <= rect.east &&
    lat >= rect.south && lat <= rect.north
  );
}

/** ピックした建物フィーチャから計測高さ（m）を取り出す（比較表で使う） */
function measuredHeightOf(picked) {
  if (!picked) return null;
  for (const key of HEIGHT_PROP_CANDIDATES) {
    try {
      const n = Number(picked.getProperty(key));
      if (Number.isFinite(n) && n > 0) return n;
    } catch (_) { /* 属性なし */ }
  }
  return null;
}

export function initDiagnosis(ctx) {
  const {
    viewer,
    areaConfig,
    getCurrentBuildingTileset,
    buildingTableHtml,
    setStatus,
    onDiagnosisStart = null,
  } = ctx;
  const serviceRect = resolveServiceRect(areaConfig);
  const serviceAreaName = areaConfig?.displayName || areaConfig?.name || '中野区';
  const currentCity = areaConfig?.code || DEFAULT_CITY;
  const sheltersAvailable = areaConfig?.disaster?.shelters === true;
  const inlandFloodMapUrl = areaConfig?.disaster?.inlandFloodMapUrl || null;
  const landslidePrefName = areaConfig?.pref || '東京都';
  const fallbackGroundHeight = Number.isFinite(areaConfig?.groundHeight)
    ? areaConfig.groundHeight
    : DEFAULT_BASE_HEIGHT;
  // 非中野で矩形を取得できなかった場合は、範囲判定を行わず全国扱いで診断を続ける。
  const inServiceArea = (lon, lat) =>
    !serviceRect || isInServiceArea(lon, lat, serviceRect);

  const panel = document.getElementById('diagnosisPanel');
  const body = document.getElementById('diagBody');
  const closeBtn = document.getElementById('closeDiag');
  const toggle = document.getElementById('diagMode');
  const searchInput = document.getElementById('searchInput');
  const searchBtn = document.getElementById('searchBtn');
  const searchResults = document.getElementById('searchResults');
  const searchMsg = document.getElementById('searchMsg');

  const closeHandlers = [];
  const resultHandlers = [];
  let pinEntity = null;
  let runToken = 0;
  let lastResult = null;

  // ---- R3 F3-1: 視点高さセレクタの再計算文脈 ---------------------------------
  // セレクタのchange時点で sunRunToken を進め、デバウンス中も古い再計算を止める。
  let sunRunToken = 0;
  /** 現在の日照の再計算に必要な文脈。診断のたびに作り直す（診断カード全体の runToken と対応） */
  let sunCtx = null;
  let sunDebounceTimer = null;
  // e2e用の観測値。window.__nakano.diagnosis.getSunlightTestState() から読み取る。
  let sunlightRunCount = 0;
  let sunlightCancelledRunCount = 0;
  let lastCancelledRaysCast = null;
  let sunlightRecalcProgress = null;

  /** 診断開始・日照再計算開始を同じフックで通知し、日影マップとの排他に使う。 */
  function notifyDiagnosisStart() {
    if (typeof onDiagnosisStart !== 'function') return;
    try {
      onDiagnosisStart();
    } catch (e) {
      console.warn('診断開始フックの実行に失敗しました', e);
    }
  }

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
    const shelterSource = sheltersAvailable
      ? `／
        <a href="https://catalog.data.metro.tokyo.lg.jp/" target="_blank" rel="noopener">中野区オープンデータ</a>（避難所・CC BY 4.0）`
      : '';
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
      <section class="diag-sec" data-sec="shelter">
        <h3>🏫 避難所</h3>
        <div class="diag-content" id="secShelter">${SPINNER}</div>
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
        <a href="https://msearch.gsi.go.jp/" target="_blank" rel="noopener">国土地理院 住所検索API</a>${shelterSource}
      </p>`;
    applyCollapse();
  }

  // ---- セクションの折りたたみ（状態は sessionStorage に記憶） ---------------------

  /** @returns {Record<string, boolean>} data-sec → 開いているか */
  function collapseState() {
    const s = sessionGet(COLLAPSE_STORAGE_KEY, {});
    return s && typeof s === 'object' ? s : {};
  }

  function applyCollapse() {
    const state = collapseState();
    body.querySelectorAll('.diag-sec').forEach((sec) => {
      const key = sec.dataset.sec;
      const h3 = sec.querySelector('h3');
      if (!h3 || !key) return;
      h3.classList.add('collapsible');
      h3.setAttribute('role', 'button');
      h3.setAttribute('tabindex', '0');
      h3.setAttribute('aria-expanded', String(state[key] !== false));
      const toggle = () => {
        const open = h3.getAttribute('aria-expanded') === 'true';
        h3.setAttribute('aria-expanded', String(!open));
        const next = collapseState();
        next[key] = !open;
        sessionSet(COLLAPSE_STORAGE_KEY, next);
      };
      h3.addEventListener('click', toggle);
      h3.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
  }

  // ---- 診断履歴（直近5件） ---------------------------------------------------

  function pushHistory(entry) {
    const list = sessionGet(HISTORY_STORAGE_KEY, []);
    const rest = (Array.isArray(list) ? list : []).filter(
      (x) => (isValidCityCode(x.city) ? x.city : DEFAULT_CITY) !== entry.city
        || Math.abs(x.lon - entry.lon) > 1e-5
        || Math.abs(x.lat - entry.lat) > 1e-5
    );
    rest.unshift(entry);
    sessionSet(HISTORY_STORAGE_KEY, rest.slice(0, HISTORY_MAX));
  }

  function readHistory() {
    const list = sessionGet(HISTORY_STORAGE_KEY, []);
    return (Array.isArray(list) ? list : []).filter(
      (x) => x && Number.isFinite(x.lon) && Number.isFinite(x.lat)
    ).map((x) => ({
      ...x,
      city: isValidCityCode(x.city) ? x.city : DEFAULT_CITY,
    }));
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

  /** 「キー｜値」の1行。value が要注意なら warn クラスを付ける */
  function kvRow(key, value, warn = false) {
    return `<div class="diag-row"><span class="diag-key">${escapeHtml(key)}</span>` +
      `<span class="diag-val${warn ? ' warn' : ''}">${escapeHtml(value)}</span></div>`;
  }

  /**
   * 洪水セクション。想定最大規模（L2）のバッジに加えて
   * 浸水継続時間（F2-1）と計画規模（F2-5）の行を並べる。
   *
   * 継続時間の表示ルール（R2 §2.1。透明を「浸水しない」と読ませないため）:
   *   - 洪水ランクが「区域外」          → 「―」（そもそも浸水想定区域の外）
   *   - 洪水ランクあり＋継続時間が透明  → 「データなし」（浸水するが継続時間の配信がない）
   *
   * @param {object} r      queryFlood の結果（想定最大規模）
   * @param {object|null} k queryFloodKeizoku の結果（取得失敗時は null）
   * @param {object|null} l1 queryFloodL1 の結果（取得失敗時は null）
   */
  function renderFlood(r, k, l1) {
    const color = FLOOD_COLORS[r.rank] || '#cccccc';
    const outOfZone = r.rank === '区域外';
    const parts = [`<div class="diag-badge" style="background:${color}">${escapeHtml(r.rank)}</div>`];

    const keizokuVal = !k ? '取得できませんでした'
      : outOfZone ? '―'
        : k.rank;
    parts.push(kvRow('浸水継続時間', keizokuVal,
      !!k && !outOfZone && k.rank !== 'データなし' && k.rank !== '判定不能'));

    const l1Val = !l1 ? '取得できませんでした' : l1.rank;
    parts.push(kvRow('計画規模の想定', l1Val, !!l1 && l1.rank !== '区域外' && l1.rank !== '判定不能'));

    // F2-4: 浸水深の3D表示（区域外・判定不能では押せない）
    const can = canShowFloodDepth(r);
    parts.push(`<button type="button" class="diag-btn" data-act="flooddepth"` +
      ` aria-pressed="${isFloodDepthVisible()}"${can ? '' : ' disabled'}>${
        escapeHtml(floodDepthBtnLabel())}</button>`);
    if (can) {
      const { depth, capped } = floodVizDepth(r.depthMax);
      parts.push(`<div class="diag-note">${escapeHtml(
        `左パネルの洪水レイヤー（PLATEAU）は区全域の想定を面で表示します。この水面は診断地点の`
        + `想定浸水深の上限（${depth.toFixed(1)}m）を、周囲${FLOOD_VIZ_RADIUS}mに柱状で示した目安です。`
        + (capped ? `「${r.rank}」は${FLOOD_VIZ_MAX_DEPTH}mで表示しています。` : '')
      )}</div>`);
    }

    const note = outOfZone
      ? '想定最大規模の洪水でも浸水想定区域には含まれません。'
      : r.rank === '判定不能'
        ? 'タイルの色が凡例と一致しませんでした。'
        : '想定最大規模（おおむね1000年に1回程度）の降雨による想定です。';
    parts.push(`<div class="diag-note">${escapeHtml(note)}</div>`);
    parts.push(`<div class="diag-note">${escapeHtml(
      '「浸水継続時間」は浸水が引くまでのおおよその目安、「計画規模」はおおむね30〜100年に1回程度の降雨による想定です。'
      + (!outOfZone && k && k.rank === 'データなし'
        ? 'この地点は浸水想定区域内ですが、継続時間のデータは配信されていません。'
        : '')
    )}</div>`);
    // 凡例注記: 重ねるハザードマップの原文どおり、自治体により意味が変わりうる
    if (k && k.rank === '2週間〜4週間') {
      parts.push(`<div class="diag-note">${escapeHtml(
        '「2週間〜4週間」の色は、自治体により「2週間以上」を意味する場合があります。'
      )}</div>`);
    }
    parts.push(`<div class="diag-note">浸水想定が公表されていない河川は表示されません。</div>`);
    const inlandFloodGuidance = inlandFloodMapUrl
      ? `<a href="${escapeHtml(inlandFloodMapUrl)}" target="_blank" rel="noopener">中野区ハザードマップ</a>` +
        `をご確認ください。`
      : 'お住まいの市区町村の公式ハザードマップをご確認ください。';
    parts.push(`<div class="diag-note">内水（雨水出水）の浸水想定は本ツール未対応です。` +
      `${inlandFloodGuidance}いずれも参考情報であり、避難の判断は必ず公式の発表に従ってください。</div>`);
    return parts.join('');
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
      ? `警戒区域に該当します。詳細は${landslidePrefName}の土砂災害警戒区域等の指定図をご確認ください。`
      : '3種いずれの警戒区域にも該当しません。';
    return rows + `<div class="diag-note">${escapeHtml(note)}</div>`;
  }

  /**
   * 避難所セクション。最寄りの震災時／水害時を1件ずつ（直線距離）。
   * 経路距離・開設状況は保証できないので注記で明示する。
   * @param {{quake:object|null, flood:object|null, error:string|null}} r
   */
  function renderShelter(r) {
    if (r.unavailable) {
      return '<div class="diag-note">このエリアでは提供されていません</div>';
    }
    if (r.error) return failMsg(r.error);
    const line = (label, s) =>
      kvRow(label, s ? `${s.name}（${formatDistance(s.distance)}）` : '該当なし');
    const parts = [line('震災時', r.quake), line('水害時', r.flood)];
    parts.push(`<div class="diag-note">${escapeHtml(
      '中野区オープンデータの位置からの直線距離です。経路距離や当日の開設状況は中野区の発表をご確認ください。'
    )}</div>`);
    parts.push(`<button type="button" class="diag-btn" data-act="shelters" aria-pressed="${
      shelterLayerOn()}">${escapeHtml(shelterBtnLabel())}</button>`);
    return parts.join('');
  }

  /** 左パネルの避難所トグル。カードのボタンはこのチェックボックスの表示にすぎない */
  const shelterCheckbox = () => document.getElementById('shelterLayer');
  const shelterLayerOn = () => !!shelterCheckbox()?.checked;
  const shelterBtnLabel = () => (shelterLayerOn() ? '地図の避難所を隠す' : '地図に避難所を表示');

  /** 左パネル側でトグルされたときにカードのボタン表示を追従させる（main.js から呼ぶ） */
  function updateShelterButton() {
    const btn = body.querySelector('button[data-act="shelters"]');
    if (!btn) return;
    btn.textContent = shelterBtnLabel();
    btn.setAttribute('aria-pressed', String(shelterLayerOn()));
  }

  // ---- 浸水深の3D表示（F2-4） ---------------------------------------------------

  const floodDepthBtnLabel = () =>
    (isFloodDepthVisible() ? '💧 3D表示を消す' : '💧 浸水深を3Dで表示');

  function updateFloodDepthButton() {
    const btn = body.querySelector('button[data-act="flooddepth"]');
    if (!btn) return;
    btn.textContent = floodDepthBtnLabel();
    btn.setAttribute('aria-pressed', String(isFloodDepthVisible()));
  }

  /**
   * 水面のON/OFF。地面高さは日照計算で求めた値があれば流用し、
   * 無ければその場で estimateBaseHeight を呼ぶ（地形なし構成なので建物と整合する）。
   */
  async function toggleFloodDepth(btn) {
    if (isFloodDepthVisible()) {
      clearFloodDepth();
      updateFloodDepthButton();
      return;
    }
    const r = lastResult;
    if (!r || !canShowFloodDepth(r.flood)) return;
    btn.disabled = true;
    try {
      const base = Number.isFinite(r.baseHeight?.height)
        ? r.baseHeight
        : await estimateBaseHeight(viewer, r.lon, r.lat, null, fallbackGroundHeight);
      r.baseHeight = base;
      showFloodDepth(viewer, {
        lon: r.lon,
        lat: r.lat,
        depthMax: r.flood.depthMax,
        // 建物タイル未読込の地点では 0m（楕円体）が返るので、その場合は既定値に寄せる
        baseHeight: resolveBaseHeight(base.height, fallbackGroundHeight),
      });
    } catch (e) {
      console.warn('flood depth 3D failed', e);
    } finally {
      btn.disabled = false;
    }
    updateFloodDepthButton();
  }

  function renderZoning(z) {
    if (z.unavailable) {
      return '<div class="diag-note">このエリアでは都市計画データが提供されていません</div>';
    }
    if (z.error) return failMsg(z.error);
    const rows = [];
    if (z.use?.unavailable) {
      rows.push(kvRow('用途地域', 'このエリアでは提供されていません'));
    } else if (z.use) {
      rows.push(`<div class="diag-badge zone">${escapeHtml(z.use.name || '不明')}</div>`);
      const nums = [];
      if (z.use.coverage != null) nums.push(`建蔽率 ${z.use.coverage}%`);
      if (z.use.floorArea != null) nums.push(`容積率 ${z.use.floorArea}%`);
      if (z.use.minSiteArea != null) nums.push(`敷地面積の最低限度 ${z.use.minSiteArea}㎡`);
      if (nums.length) rows.push(`<div class="diag-sub">${escapeHtml(nums.join('　'))}</div>`);
    } else {
      rows.push(`<div class="diag-row"><span class="diag-key">用途地域</span><span class="diag-val">該当なし</span></div>`);
    }
    rows.push(kvRow(
      '防火地域',
      z.fire?.unavailable ? 'このエリアでは提供されていません' : z.fire?.name || '指定なし',
    ));
    rows.push(kvRow(
      '高度地区',
      z.height?.unavailable ? 'このエリアでは提供されていません' : z.height?.name || '指定なし',
    ));
    if (z.use?.location) {
      rows.push(`<div class="diag-note">告示上の区域名: ${escapeHtml(z.use.location)}</div>`);
    }
    return rows.join('');
  }

  // ---- R3 F3-1: 視点の高さセレクタ ------------------------------------------

  /**
   * 階選択肢のoption文言に併記する実高さ。
   * 一般地点は地面からの相対高さ（+○○m、EYE_HEIGHT起点で直感的）、
   * 建物は絶対高さ（○○m。zmin/zmaxからの内挿値そのもの）を表示する。
   */
  function floorOptionLabel(entry, floorCtx) {
    if (floorCtx.kind === 'building') {
      return `${entry.label}（${entry.height.toFixed(1)}m）`;
    }
    const rel = entry.height - floorCtx.base;
    return `${entry.label}（+${rel.toFixed(1)}m）`;
  }

  function sunFloorSelectHtml(floorCtx, selectedKey) {
    const options = floorCtx.floors
      .map((f) => `<option value="${escapeHtml(f.key)}"${f.key === selectedKey ? ' selected' : ''}>${
        escapeHtml(floorOptionLabel(f, floorCtx))}</option>`)
      .join('');
    return `<div class="sun-floor-row">
      <label for="sunFloorSelect">視点の高さ</label>
      <select id="sunFloorSelect" aria-label="視点の高さ">${options}</select>
    </div>`;
  }

  /** 建物クリック時は picked から、それ以外は地面高さから階数の選択肢を作る */
  function buildFloorContext(picked, baseHeight) {
    return picked ? floorHeightsForFeature(picked, baseHeight) : floorHeights('ground', { base: baseHeight });
  }

  /** `.sun-day`/`.sun-bar`（93セル）のタイムライン。stale=true で再計算中の薄表示にする */
  function sunDaysHtml(result, stale) {
    return result.days
      .map((d) => {
        const cells = d.slots
          .map((s) => `<i class="${s.lit ? 'lit' : 'dark'}" title="${s.hourJst.toFixed(2)}時"></i>`)
          .join('');
        return `<div class="sun-day${stale ? ' stale' : ''}">
          <div class="sun-head"><span>${escapeHtml(d.label)}（${escapeHtml(d.dateLabel)}）</span><b>${d.hours.toFixed(1)} h</b></div>
          <div class="sun-bar">${cells}</div>
        </div>`;
      })
      .join('');
  }

  function sunScaleHtml(result) {
    return `<div class="sun-scale"><span>${result.hourStart}時</span><span>12時</span><span>${result.hourEnd}時</span></div>`;
  }

  /** 「視点高さ ○○m（○階/屋上）」＋（推定時）「階数は高さからの推定です。」 */
  function floorNoteText(result, floorCtx, selectedKey) {
    const entry = floorCtx.floors.find((f) => f.key === selectedKey);
    let text = `視点高さ ${result.originHeight.toFixed(1)}m（${entry ? entry.label : '不明'}）。`;
    if (floorCtx.estimated) text += '階数は高さからの推定です。';
    return text;
  }

  function renderSunlight(result, baseInfo, floorCtx, selectedKey, opts = {}) {
    const { resultKey = selectedKey, recalcError = null } = opts;
    const selectHtml = sunFloorSelectHtml(floorCtx, selectedKey);
    if (result.error && !result.days?.length) return selectHtml + failMsg('日照: ' + result.error);
    const bars = sunDaysHtml(result, false);
    const scale = sunScaleHtml(result);
    // 既存文の順序（「簡易計算」を含む文が先）は変えず、視点高さの注記は末尾に足す
    const note = `${result.hourStart}:00〜${result.hourEnd}:00 JSTを20分刻みでサンプリング。`
      + `読み込み済みの建物のみを考慮した簡易計算です（地形・未読込の建物・樹木は考慮しません）。`
      + `太陽高度${MIN_SUN_ELEVATION}度未満は日照に数えません。地面高さ ${baseInfo.height.toFixed(1)}m（${baseInfo.source}）。`
      + preloadNote(result.preload)
      + floorNoteText(result, floorCtx, resultKey)
      + `区外の建物・樹木等は考慮しておらず、参考情報のため法的な検討には使用できません。`;
    const warn = result.error ? `<div class="diag-fail">${escapeHtml(result.error)}</div>` : '';
    const recalcWarn = recalcError
      ? `<div class="diag-note sun-recalc-error">${escapeHtml(recalcError)}</div>`
      : '';
    return selectHtml + bars + scale + warn + `<div class="diag-note">${escapeHtml(note)}</div>` + recalcWarn;
  }

  /** 再計算中の表示。旧タイムラインを .stale（薄表示）のまま残し、進捗%を出す */
  function renderSunStale(ctx, pct) {
    if (!ctx.lastResult) return;
    const selectHtml = sunFloorSelectHtml(ctx.floorCtx, ctx.selectedKey);
    const status = `<div class="diag-note sun-recalc-status"><span class="diag-loading">` +
      `<span class="spinner"></span>再計算中… <b id="sunRecalcPct">${pct}%</b></span></div>`;
    const bars = sunDaysHtml(ctx.lastResult, true);
    const scale = sunScaleHtml(ctx.lastResult);
    fill('secSun', selectHtml + status + bars + scale);
  }

  /**
   * 公開APIから呼べる日照計算のキャンセル。
   * 初回計算はrunSunlightが捕捉したsunRunToken、再計算はisCurrentRequestを通じて中断する。
   * 再計算中なら前回の完走結果へ戻し、初回計算中なら中断理由を表示してスピナーを残さない。
   */
  function cancelSunlight(message = '日照計算を中断しました。') {
    const secSun = $('secSun');
    const wasRunning = !!sunDebounceTimer
      || !!secSun?.querySelector('.spinner')
      || !!secSun?.querySelector('.sun-recalc-status');

    sunRunToken++;
    if (sunDebounceTimer) {
      clearTimeout(sunDebounceTimer);
      sunDebounceTimer = null;
    }
    sunlightRecalcProgress = null;
    if (!wasRunning) return false;

    if (sunCtx?.lastResult && sunCtx.alive()) {
      sunCtx.selectedKey = sunCtx.lastResultKey;
      fill('secSun', renderSunlight(
        sunCtx.lastResult,
        sunCtx.baseInfo,
        sunCtx.floorCtx,
        sunCtx.lastResultKey,
        { recalcError: message }
      ));
    } else if (!panel.classList.contains('hidden')) {
      fill('secSun', `<div class="diag-note sun-cancel-note">${escapeHtml(message)}</div>`);
    }
    return true;
  }

  /**
   * 建物レイヤー切替時は旧tileset・旧pickedを含む日照文脈を破棄する。
   * 既存結果は参照用に残すが、階セレクタから再計算できないよう無効化する。
   */
  function onBuildingLayerChange() {
    const message = '建物レイヤーが切り替わったため、再診断してください';
    const currentSection = $('secSun');
    const hadSunlightContext = !!sunCtx
      || !!currentSection?.querySelector('.spinner')
      || !!currentSection?.querySelector('#sunFloorSelect');
    cancelSunlight('日照計算を中断しました。');
    sunCtx = null;
    sunlightRecalcProgress = null;

    if (panel.classList.contains('hidden') || !hadSunlightContext) return;
    const secSun = $('secSun');
    if (!secSun) return;
    const select = $('sunFloorSelect');
    if (select) {
      select.disabled = true;
    } else {
      fill('secSun', '');
    }
    if (!secSun.querySelector('.sun-layer-change-note')) {
      secSun.insertAdjacentHTML(
        'beforeend',
        `<div class="diag-note sun-layer-change-note">${escapeHtml(message)}</div>`
      );
    }
  }

  /** キャンセルされた日照計算をe2eから観測できるよう記録する */
  function recordSunlightCancellation(result) {
    if (!result?.cancelled) return;
    sunlightCancelledRunCount++;
    lastCancelledRaysCast = result.raysCast;
  }

  /**
   * セレクタ変更のデバウンス後に呼ぶ。change時点で確定した要求世代だけを実行し、
   * 完了時にも同じ診断・要求世代・選択キーであることを確認してから結果を反映する。
   */
  async function recalcSunlight(key, requestToken) {
    const ctx = sunCtx;
    const isCurrentRequest = () => {
      const select = $('sunFloorSelect');
      return !!ctx && ctx === sunCtx && ctx.alive()
        && requestToken === sunRunToken
        && ctx.selectedKey === key
        && select?.value === key;
    };
    if (!isCurrentRequest()) return;

    const entry = ctx.floorCtx.floors.find((f) => f.key === key);
    if (!entry) return; // 不正な選択値は無視（DOM改変やレース以外では起きない）
    const isCancelled = () => !isCurrentRequest();
    notifyDiagnosisStart();
    sunlightRecalcProgress = 0;
    renderSunStale(ctx, 0);

    try {
      const restoreCache = boostTilesetCache(ctx.tileset);
      let preload = null;
      let result;
      try {
        // 初回の先読みが失敗していたときだけ、選んだ高さで再ウォームアップする
        // （カメラは動かさない。preloadForSunlight は fly:false ではカメラ移動しない）
        if (ctx.initialPreloadFailed) {
          preload = await preloadForSunlight(viewer, ctx.tileset, ctx.lon, ctx.lat, ctx.baseInfo.height, {
            fly: false,
            isCancelled,
            excludeFeatures: ctx.excludeFeatures,
            originHeight: entry.height,
          });
          // 再ウォームアップが成功したら次回以降は繰り返さない。
          if (preload.ok && !preload.cancelled && ctx.alive()) {
            ctx.initialPreload = preload;
            ctx.initialPreloadFailed = false;
          }
          if (isCancelled()) return;
        }

        sunlightRunCount++;
        result = await estimateSunlight(viewer, ctx.tileset, ctx.lon, ctx.lat, ctx.baseInfo.height, {
          excludeEntities: pinEntity ? [pinEntity] : [],
          excludeFeatures: ctx.excludeFeatures,
          originHeight: entry.height,
          isCancelled,
          onProgress: (f) => {
            if (!isCurrentRequest()) return;
            sunlightRecalcProgress = f;
            const el = $('sunRecalcPct');
            if (el) el.textContent = Math.round(f * 100) + '%';
          },
        });
      } finally {
        restoreCache();
      }

      recordSunlightCancellation(result);
      if (!isCurrentRequest() || result.cancelled) return;

      // 非同期計算の完了からDOM反映までの間にも、現在の要求世代と選択キーを再検証する。
      if (!isCurrentRequest()) return;
      result.preload = preload || ctx.initialPreload;
      ctx.lastResult = result;
      ctx.lastResultKey = key;
      sunlightRecalcProgress = 1;
      if (lastResult) lastResult.sunlight = result;
      fill('secSun', renderSunlight(result, ctx.baseInfo, ctx.floorCtx, key));
      for (const fn of resultHandlers) {
        try { fn(lastResult); } catch (e) { console.warn('onResult handler failed', e); }
      }
    } catch (e) {
      console.warn('日照の再計算に失敗しました', e);
      if (!isCurrentRequest()) return;
      sunlightRecalcProgress = null;
      fill('secSun', renderSunlight(ctx.lastResult, ctx.baseInfo, ctx.floorCtx, key, {
        resultKey: ctx.lastResultKey,
        recalcError: '再計算に失敗しました。前回の結果を表示しています。',
      }));
    }
  }

  /**
   * セレクタの change ハンドラ。400msデバウンスしてから再計算する。
   * changeごとに要求世代と selectedKey を即時更新し、デバウンス待ちのタイマーへ渡す。
   * 元の値へ選び直した場合も「戻す」という正当な変更として新しい世代を発行する。
   */
  function onSunFloorChange(key) {
    const ctx = sunCtx;
    if (!ctx || !ctx.alive() || !ctx.floorCtx.floors.some((f) => f.key === key)) return;

    // changeを受けた時点で世代を進め、デバウンス待ちの間も実行中の旧計算を無効化する。
    const requestToken = ++sunRunToken;
    ctx.selectedKey = key;
    sunlightRecalcProgress = 0;
    const pct = $('sunRecalcPct');
    if (pct) pct.textContent = '0%';

    if (sunDebounceTimer) clearTimeout(sunDebounceTimer);
    sunDebounceTimer = setTimeout(() => {
      sunDebounceTimer = null;
      recalcSunlight(key, requestToken).catch((e) => {
        // recalcSunlight内でも捕捉するが、タイマー起点のPromiseを未処理にしない最後の防御。
        console.warn('日照の再計算で未処理のエラーが発生しました', e);
      });
    }, SUN_RECALC_DEBOUNCE_MS);
  }

  /**
   * タイル先読みが既定（太陽経路ウォームアップ）以外になったときだけ注記を足す。
   * 非公開APIが使えない環境でも日本語で状況が分かるようにする（R3 §6-6）。
   */
  function preloadNote(preload) {
    if (!preload) return '';
    if (preload.method === 'prepareTiles') {
      return '周辺タイルの先読みは従来方式（カメラ移動）にフォールバックしました。';
    }
    if (preload.method === 'none') {
      return '周辺タイルの先読みができなかったため、未読み込みの建物が考慮されていない可能性があります。';
    }
    return '';
  }

  // ---- 診断の実行 ----------------------------------------------------------

  /**
   * 地点診断を実行する。
   * 洪水・土砂災害・都市計画（＝比較や共有で必要な「コア項目」）が揃うまで await できる。
   * 日照は重いので待たずにバックグラウンドで進める。
   *
   * @param {{lon:number, lat:number, title?:string|null, picked?:object|null,
   *          fly?:boolean, skipSunlight?:boolean}} req
   * @returns {Promise<object>} lastResult（コア項目まで埋まった状態）
   */
  async function diagnose(req) {
    notifyDiagnosisStart();
    const { lon, lat, title = null, picked = null, fly = true, skipSunlight = false } = req;
    const token = ++runToken;
    const alive = () => token === runToken;

    // 新しい診断が始まったら、前の地点のセレクタ再計算文脈は無効にする
    sunRunToken++;
    if (sunDebounceTimer) { clearTimeout(sunDebounceTimer); sunDebounceTimer = null; }
    sunCtx = null;
    sunlightRecalcProgress = null;

    panel.classList.remove('hidden');
    showSearchMsg(''); // 前の診断で出したメッセージを残さない
    clearFloodDepth();  // 前の地点の水面を残さない（日照のレイキャストにも影響させない）
    sectionShell();
    fill('secPlace', renderPlace(lon, lat, title));
    setPin(lon, lat, title || '診断地点');
    const result = {
      lon, lat, title,
      flood: null, floodKeizoku: null, floodL1: null,
      landslide: null, shelters: null, zoning: null, sunlight: null,
      buildingHeight: measuredHeightOf(picked),
      inArea: inServiceArea(lon, lat),
    };
    lastResult = result;
    pushHistory({ city: currentCity, title, lon, lat, at: Date.now() });

    // 建物属性（同期・ピック時のみ）
    if (picked) {
      const sec = body.querySelector('[data-sec="building"]');
      sec.classList.remove('hidden');
      fill('secBuilding', `<table class="diag-table">${buildingTableHtml(picked)}</table>`);
    }

    // 洪水（想定最大規模＋浸水継続時間＋計画規模）。
    // 継続時間・計画規模は補助情報なので、取れなくても本体（想定最大規模）は表示する。
    const soft = (label) => (e) => { console.warn(label + ' failed', e); return null; };
    const pFlood = Promise.all([
      queryFlood(lon, lat),
      queryFloodKeizoku(lon, lat).catch(soft('flood keizoku')),
      queryFloodL1(lon, lat).catch(soft('flood L1')),
    ])
      .then(([f, k, l1]) => {
        if (!alive()) return;
        result.flood = f;
        result.floodKeizoku = k;
        result.floodL1 = l1;
        fill('secFlood', renderFlood(f, k, l1));
      })
      .catch((e) => {
        console.warn('flood failed', e);
        if (alive()) fill('secFlood', failMsg('洪水浸水想定を取得できませんでした'));
      });

    // 土砂災害
    const pLand = queryLandslide(lon, lat)
      .then((r) => { if (alive()) { result.landslide = r; fill('secLandslide', renderLandslide(r)); } })
      .catch((e) => {
        console.warn('landslide failed', e);
        if (alive()) fill('secLandslide', failMsg('土砂災害警戒区域を取得できませんでした'));
      });

    // 避難所（同梱GeoJSON。初回だけ読み込み、以降はキャッシュ）
    const pShelter = (sheltersAvailable
      ? queryNearestShelters(lon, lat)
      : Promise.resolve({ unavailable: true, quake: null, flood: null, error: null }))
      .then((r) => { if (alive()) { result.shelters = r; fill('secShelter', renderShelter(r)); } })
      .catch((e) => {
        console.warn('shelter failed', e);
        if (alive()) fill('secShelter', failMsg('避難所データを読み込めませんでした'));
      });

    // 都市計画
    const pZone = queryZoning(lon, lat, areaConfig?.zoning)
      .then((r) => { if (alive()) { result.zoning = r; fill('secZoning', renderZoning(r)); } })
      .catch((e) => {
        console.warn('zoning failed', e);
        if (alive()) fill('secZoning', failMsg('都市計画情報を取得できませんでした'));
      });

    // 日照（重いので最後、カメラ移動＋タイル読み込み待ちを挟む）
    if (skipSunlight) {
      fill('secSun', '<div class="diag-note">日照は未計算です（比較URLからの復元では省略しています）。</div>');
    } else if (!result.inArea) {
      fill('secSun', failMsg(
        `対応エリア外です（建物3Dは${serviceAreaName}のみ）。日照は計算できません。`,
      ));
    } else {
      runSunlight(lon, lat, picked, alive, fly).catch((e) => {
        console.warn('sunlight failed', e);
        if (alive()) fill('secSun', failMsg('日照: 計算できませんでした'));
      });
    }

    if (!result.inArea) {
      const sec = body.querySelector('[data-sec="building"]');
      if (sec && !picked) {
        sec.classList.remove('hidden');
        fill(
          'secBuilding',
          `<div class="diag-note">対応エリア外です（建物3Dは${escapeHtml(serviceAreaName)}のみ）。` +
          `ハザードと都市計画は全国のデータで診断しています。</div>`,
        );
      }
    }

    await Promise.all([pFlood, pLand, pZone, pShelter]);
    if (alive()) {
      for (const fn of resultHandlers) {
        try { fn(result); } catch (e) { console.warn('onResult handler failed', e); }
      }
    }
    return result;
  }

  async function runSunlight(lon, lat, picked, alive, fly) {
    const tileset = getCurrentBuildingTileset();
    const requestToken = sunRunToken;
    const isCancelled = () => !alive() || requestToken !== sunRunToken;
    const excludeFeatures = picked ? [picked] : [];
    fill('secSun', '<span class="diag-loading"><span class="spinner"></span>周辺の建物を読み込み中…</span>');

    // 先読みのレイ原点に地面高さが要るので、先に地面高さを求める
    const estimatedBaseInfo = await estimateBaseHeight(
      viewer,
      lon,
      lat,
      picked,
      fallbackGroundHeight,
    );
    const resolvedBaseHeight = resolveBaseHeight(
      estimatedBaseInfo.height,
      fallbackGroundHeight,
    );
    const baseInfo = resolvedBaseHeight === estimatedBaseInfo.height
      ? estimatedBaseInfo
      : { height: resolvedBaseHeight, source: '既定値' };
    if (isCancelled()) return;

    // 先読みで読み込んだタイルが計算中に追い出されないよう、
    // 「先読み開始〜日照計算完了」を1つの区間としてキャッシュ上限を引き上げる（R3 P1.1）
    const restoreCache = boostTilesetCache(tileset);
    let preload;
    let result;
    try {
      // R3: カメラを動かさない太陽経路ウォームアップ。
      // 非対応環境では従来方式（カメラ移動）へフォールバックする
      preload = await preloadForSunlight(viewer, tileset, lon, lat, baseInfo.height, {
        fly,
        isCancelled,
        excludeFeatures,
      });
      if (isCancelled()) return;

      fill('secSun', '<span class="diag-loading"><span class="spinner"></span>日照を計算中… <b id="sunPct">0%</b></span>');
      sunlightRunCount++;
      result = await estimateSunlight(viewer, tileset, lon, lat, baseInfo.height, {
        excludeEntities: pinEntity ? [pinEntity] : [],
        excludeFeatures,
        isCancelled,
        onProgress: (f) => {
          if (isCancelled()) return;
          const el = $('sunPct');
          if (el) el.textContent = Math.round(f * 100) + '%';
        },
      });
    } finally {
      restoreCache();
    }
    recordSunlightCancellation(result);
    if (isCancelled() || result.cancelled) return;
    result.preload = preload;
    lastResult.sunlight = result;
    lastResult.baseHeight = baseInfo;

    // R3 F3-1: 視点高さセレクタの再計算文脈を用意する。
    // 既定選択（'f1' = 1階）は floorHeights の仕様上 base+EYE_HEIGHT と一致するため、
    // 上のestimateSunlight呼び出し（originHeight省略）の結果とズレない＝再計算にはならない。
    const floorCtx = buildFloorContext(picked, baseInfo.height);
    sunCtx = {
      lon, lat, tileset, picked,
      baseInfo, floorCtx, selectedKey: 'f1',
      excludeFeatures,
      initialPreload: preload,
      initialPreloadFailed: !!(preload && preload.ok === false),
      lastResult: result,
      lastResultKey: 'f1',
      alive,
    };
    fill('secSun', renderSunlight(result, baseInfo, floorCtx, 'f1'));
    // 日照が揃った時点でも通知する（比較スナップショットを取り直せるように）
    for (const fn of resultHandlers) {
      try { fn(lastResult); } catch (e) { console.warn('onResult handler failed', e); }
    }
  }

  function close() {
    runToken++;
    sunRunToken++;
    if (sunDebounceTimer) { clearTimeout(sunDebounceTimer); sunDebounceTimer = null; }
    sunCtx = null;
    sunlightRecalcProgress = null;
    panel.classList.add('hidden');
    clearPin();
    clearFloodDepth();
    for (const h of closeHandlers) h();
  }

  closeBtn.addEventListener('click', close);

  // ---- カード内のボタン ------------------------------------------------------
  // セクションは innerHTML で作り直されるので、個々のボタンではなく本文に委譲して拾う。
  // R3 F3-1: 視点高さセレクタも同じ理由（再計算のたびに innerHTML が作り直される）で委譲する。
  body.addEventListener('change', (e) => {
    const sel = e.target.closest?.('#sunFloorSelect');
    if (sel) onSunFloorChange(sel.value);
  });
  body.addEventListener('click', (e) => {
    const btn = e.target.closest?.('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'shelters') {
      const cb = shelterCheckbox();
      if (!cb) return;
      cb.checked = !cb.checked;
      // 左パネル側のハンドラに処理させる（表示状態の単一ソースはチェックボックス）
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      updateShelterButton();
      return;
    }
    if (btn.dataset.act === 'flooddepth') {
      toggleFloodDepth(btn);
    }
  });

  // ---- 検索UI --------------------------------------------------------------

  function showSearchMsg(text, isError) {
    searchMsg.textContent = text || '';
    searchMsg.classList.toggle('hidden', !text);
    searchMsg.classList.toggle('error', !!isError);
  }

  // 候補リスト（住所検索の結果 or 診断履歴）と、キーボードで選択中の位置
  let options = [];
  let activeIndex = -1;

  function hideResults() {
    searchResults.classList.add('hidden');
    searchResults.innerHTML = '';
    options = [];
    activeIndex = -1;
    searchInput.setAttribute('aria-expanded', 'false');
    searchInput.removeAttribute('aria-activedescendant');
  }

  /** 選択位置を DOM と aria-activedescendant に反映する */
  function highlightOption() {
    searchResults.querySelectorAll('li').forEach((li, i) => {
      li.setAttribute('aria-selected', String(i === activeIndex));
    });
    if (activeIndex >= 0) {
      searchInput.setAttribute('aria-activedescendant', 'search-opt-' + activeIndex);
      searchResults.querySelectorAll('li')[activeIndex]?.scrollIntoView({ block: 'nearest' });
    } else {
      searchInput.removeAttribute('aria-activedescendant');
    }
  }

  /**
   * 候補リストを描画する（combobox/listbox のARIAを付ける）。
   * @param {Array<{title:string, lon:number, lat:number, city?:string}>} items
   * @param {boolean} isHistory 履歴由来なら true（見た目を変える）
   */
  function renderOptions(items, isHistory = false) {
    options = items;
    activeIndex = -1;
    searchResults.innerHTML = items
      .map(
        (r, i) =>
          `<li id="search-opt-${i}" role="option" aria-selected="false" data-i="${i}"` +
          `${isHistory ? ' class="history-item"' : ''}>${escapeHtml(r.title)}</li>`
      )
      .join('');
    searchResults.classList.remove('hidden');
    searchInput.setAttribute('aria-expanded', 'true');
    searchInput.removeAttribute('aria-activedescendant');
    searchResults.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => pickResult(options[Number(li.dataset.i)]));
    });
  }

  /** 入力が空のときに直近の診断履歴をドロップダウンで出す */
  function showHistory() {
    const list = readHistory();
    if (!list.length) return;
    renderOptions(
      list.map((h) => ({
        title: h.title || `${h.lon.toFixed(5)}, ${h.lat.toFixed(5)}`,
        city: h.city,
        lon: h.lon,
        lat: h.lat,
      })),
      true
    );
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
    if (isValidCityCode(r.city) && r.city !== currentCity) {
      location.hash = serializeState({
        city: r.city,
        spot: { lon: r.lon, lat: r.lat },
        addr: r.title,
      });
      location.reload();
      return;
    }
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
      renderOptions(results);
    } catch (e) {
      console.warn('geocode failed', e);
      showSearchMsg('住所検索に失敗しました', true);
    } finally {
      searchBtn.disabled = false;
    }
  }

  searchBtn.addEventListener('click', doSearch);

  // ---- 検索のキーボード操作（↑↓で選択・Enterで確定・Escで閉じる） -----------------

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!options.length) return;
      e.preventDefault();
      const n = options.length;
      activeIndex = e.key === 'ArrowDown'
        ? (activeIndex + 1) % n
        : (activeIndex <= 0 ? n - 1 : activeIndex - 1);
      highlightOption();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // 候補を選んでいればそれで診断、選んでいなければ入力文字列で検索
      if (activeIndex >= 0 && options[activeIndex]) pickResult(options[activeIndex]);
      else doSearch();
      return;
    }
    if (e.key === 'Escape') hideResults();
  });

  // ---- 診断履歴のドロップダウン ------------------------------------------------

  // fill() でフォーカス済みの状態から click されても出せるよう focus/click 両方で拾う
  const maybeShowHistory = () => {
    if (!searchInput.value.trim() && !options.length) showHistory();
  };
  searchInput.addEventListener('focus', maybeShowHistory);
  searchInput.addEventListener('click', maybeShowHistory);
  searchInput.addEventListener('input', () => {
    if (searchResults.querySelector('.history-item')) hideResults();
  });

  // ---- 現在地診断 --------------------------------------------------------------

  const geoBtn = document.getElementById('geoBtn');

  function diagnoseCurrentLocation() {
    if (!navigator.geolocation) {
      showSearchMsg('この端末では現在地を取得できません', true);
      return;
    }
    hideResults();
    showSearchMsg('現在地を取得中…');
    if (geoBtn) geoBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (geoBtn) geoBtn.disabled = false;
        const lon = pos.coords.longitude;
        const lat = pos.coords.latitude;
        flyToPoint(lon, lat);
        // diagnose() が検索メッセージを消すので、エリア外の案内はその後に出す
        diagnose({ lon, lat, title: null, picked: null });
        if (!inServiceArea(lon, lat)) {
          // エリア外でもハザード・都市計画のタイルは全国分あるので診断自体は実行する
          showSearchMsg(
            `対応エリア外です（建物3Dは${serviceAreaName}のみ）。` +
            'ハザードと都市計画のみ診断します',
            true,
          );
        }
      },
      (err) => {
        if (geoBtn) geoBtn.disabled = false;
        const msg =
          err.code === err.PERMISSION_DENIED ? '現在地の利用が許可されませんでした'
            : err.code === err.TIMEOUT ? '現在地の取得がタイムアウトしました'
              : '現在地を取得できませんでした';
        showSearchMsg(msg, true);
      },
      // maximumAge=0: 直前の測位結果を使い回さない（移動直後でも今の位置を取る）
      { enableHighAccuracy: false, timeout: GEOLOCATION_TIMEOUT, maximumAge: 0 }
    );
  }

  if (geoBtn) geoBtn.addEventListener('click', diagnoseCurrentLocation);

  // ---- 診断モードトグル -----------------------------------------------------

  function setActive(on) {
    toggle.checked = on;
    document.body.classList.toggle('diag-mode', on);
    if (setStatus) setStatus(on ? '地図をクリックして診断する地点を指定してください' : '');
  }
  toggle.addEventListener('change', () => setActive(toggle.checked));

  return {
    diagnose,
    /**
     * 公開API: 座標を指定して診断する（share.js / compare.js から使う）。
     * @param {number} lon @param {number} lat
     * @param {{title?:string|null, fly?:boolean, skipSunlight?:boolean}} [opts]
     */
    runDiagnosisAt: (lon, lat, opts = {}) => {
      if (opts.fly) flyToPoint(lon, lat);
      return diagnose({ lon, lat, picked: null, ...opts });
    },
    close,
    /** 実行中または開始待ちの日照計算だけを中断し、診断カード自体は閉じない。 */
    cancelSunlight,
    /** 建物レイヤー切替時に旧タイルセットを参照する日照再計算文脈を無効化する。 */
    onBuildingLayerChange,
    isActive: () => toggle.checked,
    setActive,
    onClose: (fn) => closeHandlers.push(fn),
    /** 左パネルの避難所トグルが変わったときにカードのボタン表示を合わせる */
    updateShelterButton,
    /** 診断のコア項目が揃うたび（＋日照完了時）に呼ばれる */
    onResult: (fn) => resultHandlers.push(fn),
    getLastResult: () => lastResult,
    /** e2e用: 日照計算の実行・キャンセル・進捗と現在選択の期待高さを読み取る */
    getSunlightTestState: () => {
      const entry = sunCtx?.floorCtx.floors.find((f) => f.key === sunCtx.selectedKey);
      return {
        runCount: sunlightRunCount,
        cancelledRunCount: sunlightCancelledRunCount,
        lastCancelledRaysCast,
        recalculationProgress: sunlightRecalcProgress,
        selectedKey: sunCtx?.selectedKey || null,
        expectedOriginHeight: entry?.height ?? null,
      };
    },
    flyToPoint,
    diagnoseCurrentLocation,
    getHistory: readHistory,
    searchAndDiagnose: async (q) => {
      searchInput.value = q;
      await doSearch();
    },
    isOpen: () => !panel.classList.contains('hidden'),
  };
}
