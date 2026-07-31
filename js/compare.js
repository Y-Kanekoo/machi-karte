// 地点比較（最大3地点）
//
// 診断カードの「⚖ 比較に追加」で lastResult のスナップショットを sessionStorage に貯め、
// 比較バー／比較モーダルで並べて表示する。
//
// 依存方向: compare.js → diagnose.js の公開API（runDiagnosisAt / getLastResult）。
// diagnose.js からは compare.js を参照しない。

import {
  COMPARE_MAX,
  COMPARE_STORAGE_KEY,
  COMPARE_DEDUPE_METERS,
  FLOOD_COLORS,
  DEFAULT_CITY,
} from './config.js';
import { serializeState, isValidCityCode } from './share.js';
import { escapeHtml } from './util.js';
import { distanceMeters as haversineMeters } from './tilemath.js';

// ---- 純粋関数（Node単体テスト対象） -------------------------------------------

/**
 * 診断結果（diagnose.js の lastResult）から比較用スナップショットを作る。
 * 未取得の項目は null のままにして、表示側で「未計算」を出す。
 *
 * @param {object} r lastResult
 * @param {string} city 自治体コード
 * @returns {{city:string, lon:number, lat:number, title:string|null, flood:string|null,
 *   landslide:Array<{label:string, rank:string}>|null, landslideWorst:string|null,
 *   use:string|null, coverage:number|null, floorArea:number|null,
 *   fire:string|null, heightDistrict:string|null,
 *   sun:Array<{label:string, hours:number}>|null, buildingHeight:number|null, at:number}|null}
 */
export function snapshotFromResult(r, city = DEFAULT_CITY) {
  if (!r || !Number.isFinite(r.lon) || !Number.isFinite(r.lat)) return null;
  const land = Array.isArray(r.landslide)
    ? r.landslide.map((x) => ({ label: x.label, rank: x.rank }))
    : null;
  return {
    city: isValidCityCode(city) ? city : DEFAULT_CITY,
    lon: r.lon,
    lat: r.lat,
    title: r.title || null,
    flood: r.flood?.rank || null,
    landslide: land,
    landslideWorst: land ? worstLandslide(land) : null,
    use: r.zoning?.use?.name || null,
    coverage: r.zoning?.use?.coverage ?? null,
    floorArea: r.zoning?.use?.floorArea ?? null,
    fire: r.zoning?.fire?.name || null,
    heightDistrict: r.zoning?.height?.name || null,
    sun: Array.isArray(r.sunlight?.days)
      ? r.sunlight.days.map((d) => ({ label: d.label, hours: d.hours }))
      : null,
    buildingHeight: Number.isFinite(r.buildingHeight) ? r.buildingHeight : null,
    at: Date.now(),
  };
}

/** 土砂災害3種のうち最も重い区分を返す（すべて区域外なら「区域外」） */
export function worstLandslide(list) {
  const order = ['区域外', '区域内（区分不明）', '警戒区域（イエロー）', '特別警戒区域（レッド）'];
  let best = '区域外';
  for (const x of list || []) {
    if (order.indexOf(x.rank) > order.indexOf(best)) best = x.rank;
  }
  return best;
}

/**
 * 2地点間の距離（m）。実体は tilemath.js の Haversine 実装
 * （R2で避難所の直線距離と共通化した。ここは {lon,lat} を取る比較用ラッパ）。
 */
export function distanceMeters(a, b) {
  return haversineMeters(a.lon, a.lat, b.lon, b.lat);
}

/** 比較表の行定義（行=診断項目）。値の取り出しも含めて純粋に保つ */
export const COMPARE_ROWS = [
  { key: 'flood', label: '洪水浸水想定', get: (s) => s.flood, badge: 'flood' },
  { key: 'landslideWorst', label: '土砂災害', get: (s) => s.landslideWorst },
  { key: 'use', label: '用途地域', get: (s) => s.use },
  { key: 'coverage', label: '建蔽率', get: (s) => (s.coverage != null ? s.coverage + '%' : null) },
  { key: 'floorArea', label: '容積率', get: (s) => (s.floorArea != null ? s.floorArea + '%' : null) },
  { key: 'fire', label: '防火地域', get: (s) => s.fire || '指定なし' },
  { key: 'heightDistrict', label: '高度地区', get: (s) => s.heightDistrict || '指定なし' },
  { key: 'sunWinter', label: '日照（冬至）', get: (s) => sunHours(s, '冬至') },
  { key: 'sunEquinox', label: '日照（春分）', get: (s) => sunHours(s, '春分') },
  { key: 'sunSummer', label: '日照（夏至）', get: (s) => sunHours(s, '夏至') },
  {
    key: 'buildingHeight',
    label: '建物の計測高さ',
    get: (s) => (s.buildingHeight != null ? s.buildingHeight.toFixed(1) + ' m' : null),
  },
];

function sunHours(s, label) {
  const d = s.sun?.find((x) => x.label === label);
  return d ? d.hours.toFixed(1) + ' h' : null;
}

/**
 * 比較表のデータを組み立てる（DOM非依存）。
 * @param {Array<object>} snapshots
 * @returns {{headers:Array<{title:string, sub:string}>, rows:Array<{label:string, cells:string[]}>}}
 */
export function buildCompareTable(snapshots) {
  const list = (snapshots || []).slice(0, COMPARE_MAX);
  return {
    headers: list.map((s) => ({
      title: s.title || `${s.lon.toFixed(5)}, ${s.lat.toFixed(5)}`,
      sub: `${s.lon.toFixed(5)} / ${s.lat.toFixed(5)}`,
    })),
    rows: COMPARE_ROWS.map((row) => ({
      key: row.key,
      label: row.label,
      badge: row.badge || null,
      cells: list.map((s) => row.get(s) ?? '未計算'),
    })),
  };
}

// ---- sessionStorage（プライベートモード等で例外になっても機能を殺すだけ） ---------

function readStore() {
  try {
    const raw = sessionStorage.getItem(COMPARE_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr)
      ? arr
        .filter((s) => s && Number.isFinite(s.lon))
        .map((s) => ({
          ...s,
          city: isValidCityCode(s.city) ? s.city : DEFAULT_CITY,
        }))
      : [];
  } catch (e) {
    console.warn('compare: read failed', e);
    return [];
  }
}

function writeStore(list) {
  try {
    sessionStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    console.warn('compare: write failed', e);
  }
}

// ---- UI ---------------------------------------------------------------------

/**
 * @param {{diagnosis:object, viewer:object, toast:(m:string)=>void, share?:object}} ctx
 */
export function initCompare(ctx) {
  const {
    diagnosis,
    viewer,
    toast,
    share = null,
    areaConfig = null,
  } = ctx;

  const addBtn = document.getElementById('compareAddBtn');
  const bar = document.getElementById('compareBar');
  const barText = document.getElementById('compareBarText');
  const showBtn = document.getElementById('compareShowBtn');
  const clearBtn = document.getElementById('compareClearBtn');
  const modal = document.getElementById('compareModal');
  const modalBody = document.getElementById('compareModalBody');
  const closeBtn = document.getElementById('compareCloseBtn');
  const shareBtn = document.getElementById('compareShareBtn');

  let items = readStore();
  let lastFocused = null;

  function persist() {
    writeStore(items);
    renderBar();
    if (modal && !modal.classList.contains('hidden')) renderModal();
  }

  function renderBar() {
    if (!bar) return;
    if (items.length < 1) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    barText.textContent = `比較中: ${items.length}地点`;
    if (showBtn) showBtn.disabled = items.length < 2;
  }

  function add() {
    const snap = snapshotFromResult(
      diagnosis.getLastResult(),
      areaConfig?.code || DEFAULT_CITY,
    );
    if (!snap) {
      toast('先に地点を診断してください');
      return null;
    }
    const dup = items.find(
      (s) => s.city === snap.city && distanceMeters(s, snap) < COMPARE_DEDUPE_METERS,
    );
    if (dup) {
      toast('同じ地点はすでに追加されています');
      return null;
    }
    items.push(snap);
    let pushedOut = null;
    while (items.length > COMPARE_MAX) pushedOut = items.shift();
    persist();
    if (pushedOut) {
      toast(`最大${COMPARE_MAX}地点です。最も古い地点を外しました`);
    } else {
      toast(`比較に追加しました（${items.length}地点）`);
    }
    return snap;
  }

  function removeAt(i) {
    items.splice(i, 1);
    persist();
    if (items.length === 0) closeModal();
  }

  function clearAll() {
    items = [];
    persist();
    closeModal();
  }

  function cellHtml(row, value) {
    if (value === '未計算') return `<td class="cmp-na">未計算</td>`;
    if (row.badge === 'flood') {
      const color = FLOOD_COLORS[value] || '#cccccc';
      return `<td><span class="diag-badge" style="background:${color}">${escapeHtml(value)}</span></td>`;
    }
    const warn = /警戒区域/.test(String(value)) ? ' class="warn"' : '';
    return `<td${warn}>${escapeHtml(String(value))}</td>`;
  }

  function renderModal() {
    if (!modalBody) return;
    const table = buildCompareTable(items);
    const heads = table.headers
      .map(
        (h, i) => `<th scope="col">
          <div class="cmp-title">${escapeHtml(h.title)}</div>
          <div class="cmp-sub">${escapeHtml(h.sub)}</div>
          <div class="cmp-actions">
            <button type="button" class="cmp-goto" data-i="${i}" aria-label="${escapeHtml(h.title)}を地図で表示">📍 地図で表示</button>
            <button type="button" class="cmp-del" data-i="${i}" aria-label="${escapeHtml(h.title)}を比較から削除">× 削除</button>
          </div>
        </th>`
      )
      .join('');
    const rows = table.rows
      .map(
        (row) =>
          `<tr><th scope="row">${escapeHtml(row.label)}</th>${row.cells
            .map((c) => cellHtml(row, c))
            .join('')}</tr>`
      )
      .join('');
    const anyUncalced = table.rows.some((r) => r.key.startsWith('sun') && r.cells.includes('未計算'));
    const note = anyUncalced
      ? '<p class="cmp-note">日照が「未計算」の地点は、「📍 地図で表示」から診断カードを開くと自動で計算されます。</p>'
      : '';
    modalBody.innerHTML = `<div class="cmp-scroll"><table class="cmp-table">
        <thead><tr><th scope="col">診断項目</th>${heads}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>${note}`;

    modalBody.querySelectorAll('.cmp-del').forEach((b) => {
      b.addEventListener('click', () => removeAt(Number(b.dataset.i)));
    });
    modalBody.querySelectorAll('.cmp-goto').forEach((b) => {
      b.addEventListener('click', () => gotoIndex(Number(b.dataset.i)));
    });
  }

  async function gotoIndex(i) {
    const s = items[i];
    if (!s) return;
    closeModal();
    const city = isValidCityCode(s.city) ? s.city : DEFAULT_CITY;
    if (city !== (areaConfig?.code || DEFAULT_CITY)) {
      location.hash = serializeState({
        city,
        spot: { lon: s.lon, lat: s.lat },
        addr: s.title,
      });
      location.reload();
      return;
    }
    await diagnosis.runDiagnosisAt(s.lon, s.lat, { title: s.title, fly: true });
  }

  function openModal() {
    if (!modal) return;
    lastFocused = document.activeElement;
    renderModal();
    modal.classList.remove('hidden');
    (closeBtn || modal).focus();
  }

  function closeModal() {
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    try { lastFocused?.focus?.(); } catch (_) { /* noop */ }
  }

  // フォーカストラップ（モーダル内でTabを循環させる）
  if (modal) {
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
      if (e.key !== 'Tab') return;
      const f = [...modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  }

  if (addBtn) addBtn.addEventListener('click', add);
  if (showBtn) showBtn.addEventListener('click', openModal);
  if (clearBtn) clearBtn.addEventListener('click', clearAll);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (shareBtn && share) {
    shareBtn.addEventListener('click', async () => {
      const url = share.shareCompare(items.map((s) => ({ lon: s.lon, lat: s.lat })));
      try {
        await navigator.clipboard.writeText(url);
        toast('比較のリンクをコピーしました');
      } catch (_) {
        try { window.prompt('このURLをコピーしてください', url); } catch (__) { /* noop */ }
        toast('URLを表示しました');
      }
    });
  }

  /**
   * 共有URL（#compare=...）からの復元。
   * 日照はスキップして各地点を順に診断し、スナップショットを積んでモーダルを開く。
   */
  async function restoreFromPoints(points) {
    items = [];
    persist();
    for (const p of (points || []).slice(0, COMPARE_MAX)) {
      await diagnosis.runDiagnosisAt(p.lon, p.lat, { fly: false, skipSunlight: true });
      const snap = snapshotFromResult(
        diagnosis.getLastResult(),
        areaConfig?.code || DEFAULT_CITY,
      );
      if (snap) items.push(snap);
    }
    persist();
    if (items.length >= 2) openModal();
    return items;
  }

  renderBar();

  return {
    add,
    openModal,
    closeModal,
    clearAll,
    restoreFromPoints,
    getItems: () => items.slice(),
    isOpen: () => !!modal && !modal.classList.contains('hidden'),
  };
}
