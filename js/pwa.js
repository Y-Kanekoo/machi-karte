// PWAのService Worker登録と表示品質の自動判定。

export const QUALITY_STORAGE_KEY = 'quality';

const SELECTABLE_QUALITY_PROFILES = new Set(['light', 'high']);

function ensureSwUpdateToast() {
  const doc = globalThis.document;
  if (!doc) return null;
  const existing = doc.getElementById('swUpdateToast');
  if (existing) return existing;

  const toast = doc.createElement('div');
  toast.id = 'swUpdateToast';
  toast.className = 'hidden';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  doc.body.append(toast);
  return toast;
}

function showUpdateToast(registration, worker) {
  const toast = ensureSwUpdateToast();
  if (!toast) return;

  const message = document.createElement('span');
  message.textContent = '新しいバージョンがあります';
  const reloadButton = document.createElement('button');
  reloadButton.type = 'button';
  reloadButton.className = 'update-reload-button';
  reloadButton.textContent = '再読み込み';
  reloadButton.addEventListener('click', () => {
    const waitingWorker = registration.waiting || worker;
    if (!waitingWorker) {
      globalThis.location.reload();
      return;
    }

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      globalThis.location.reload();
    });
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  });

  toast.replaceChildren(message, reloadButton);
  toast.classList.remove('hidden');
}

function watchForUpdate(registration) {
  const watchedWorkers = new WeakSet();

  function watchInstallingWorker() {
    const worker = registration.installing;
    if (!worker || watchedWorkers.has(worker)) return;
    watchedWorkers.add(worker);

    function notifyWhenInstalled() {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        showUpdateToast(registration, worker);
      }
    }

    worker.addEventListener('statechange', notifyWhenInstalled);
    notifyWhenInstalled();
  }

  registration.addEventListener('updatefound', watchInstallingWorker);
  watchInstallingWorker();
  if (registration.waiting && navigator.serviceWorker.controller) {
    showUpdateToast(registration, registration.waiting);
  }
}

/** nosw=1でないブラウザ環境ではService Workerを登録する。 */
export async function registerServiceWorker() {
  const query = new URLSearchParams(globalThis.location?.search || '');
  if (
    query.get('nosw') === '1'
    || !globalThis.navigator
    || !('serviceWorker' in globalThis.navigator)
  ) return null;

  try {
    const registration = await navigator.serviceWorker.register('sw.js');
    watchForUpdate(registration);
    return registration;
  } catch (error) {
    console.warn('Service Workerを登録できませんでした', error);
    return null;
  }
}

if (typeof globalThis.window !== 'undefined') {
  ensureSwUpdateToast();
  void registerServiceWorker();
}

/** qualityのURL上書きを外し、保存済み設定が有効になるURLで再読み込みする。 */
export function reloadWithoutQualityOverride() {
  const url = new URL(globalThis.location.href);
  url.searchParams.delete('quality');
  globalThis.history.replaceState(globalThis.history.state, '', url.href);
  globalThis.location.reload();
}

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
