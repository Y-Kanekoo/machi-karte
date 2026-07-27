// 国土地理院 住所検索API（キー不要・CORS `*`）
//
// 実測（2026-07-27）:
//   GET https://msearch.gsi.go.jp/address-search/AddressSearch?q=中野区中野五丁目
//   → [{"geometry":{"coordinates":[139.66893,35.707859],"type":"Point"},
//       "type":"Feature","properties":{"addressCode":"","title":"東京都中野区中野五丁目"}}]
//   該当なしのときは HTTP 200 で空配列 `[]` が返る（404にはならない）。

import { GEOCODE_URL } from './config.js';

/**
 * 住所を検索する。
 * @param {string} q 検索文字列
 * @param {number} limit 返す最大件数
 * @returns {Promise<Array<{title:string, lon:number, lat:number}>>}
 * @throws {Error} 通信失敗時
 */
export async function search(q, limit = 5) {
  const query = String(q || '').trim();
  if (!query) return [];
  const res = await fetch(`${GEOCODE_URL}?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`住所検索に失敗しました (HTTP ${res.status})`);
  const json = await res.json();
  if (!Array.isArray(json)) return [];
  return json
    .filter((f) => Array.isArray(f?.geometry?.coordinates))
    .slice(0, limit)
    .map((f) => ({
      title: f.properties?.title || query,
      lon: Number(f.geometry.coordinates[0]),
      lat: Number(f.geometry.coordinates[1]),
    }))
    .filter((r) => Number.isFinite(r.lon) && Number.isFinite(r.lat));
}
