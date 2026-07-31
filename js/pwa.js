// PWA表示品質の自動判定。Service Worker登録はR8a-P1で追加する。

export const QUALITY_STORAGE_KEY = 'quality';

const SELECTABLE_QUALITY_PROFILES = new Set(['light', 'high']);

/** ポインター・画面サイズまたは端末メモリからモバイル相当かを判定する。 */
export function isMobileLike() {
  const screenWidth = globalThis.screen?.width ?? Number.POSITIVE_INFINITY;
  const screenHeight = globalThis.screen?.height ?? Number.POSITIVE_INFINITY;
  const coarseSmallScreen = typeof globalThis.matchMedia === 'function'
    && globalThis.matchMedia('(pointer: coarse)').matches
    && Math.min(screenWidth, screenHeight) < 820;
  const deviceMemory = globalThis.navigator?.deviceMemory;
  const lowMemory = deviceMemory !== undefined && deviceMemory <= 4;
  return coarseSmallScreen || lowMemory;
}

/** URL、保存済み設定、自動判定の順で表示品質プロファイル名を解決する。 */
export function resolveQualityProfile() {
  const query = new URLSearchParams(globalThis.location?.search || '');
  const requested = query.get('quality');
  if (SELECTABLE_QUALITY_PROFILES.has(requested)) return requested;

  try {
    const saved = globalThis.localStorage?.getItem(QUALITY_STORAGE_KEY);
    if (SELECTABLE_QUALITY_PROFILES.has(saved)) return saved;
  } catch (error) {
    console.warn('表示品質の保存設定を読み込めませんでした', error);
  }

  return isMobileLike() ? 'light' : 'default';
}
