const VERSION = 'v6';

const CACHE_NAMES = {
  shell: `shell-${VERSION}`,
  cdn: `cdn-${VERSION}`,
  basemap: 'basemap',
  hazard: 'hazard',
  zoning: 'zoning',
  appdata: 'appdata',
};

const PRECACHE_URLS = [
  './index.html',
  './style.css',
  './js/area.js',
  './js/bottomsheet.js',
  './js/compare.js',
  './js/config.js',
  './js/diagnose.js',
  './js/floodviz.js',
  './js/geocode.js',
  './js/hazard.js',
  './js/main.js',
  './js/panel.js',
  './js/perf.js',
  './js/pwa.js',
  './js/shademap-ui.js',
  './js/shademap.js',
  './js/share.js',
  './js/shelter.js',
  './js/solar.js',
  './js/sunlight.js',
  './js/tilemath.js',
  './js/util.js',
  './js/zoning-overlay.js',
  './js/zoning.js',
  './manifest.json',
  './offline.html',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-192.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/icon-maskable.svg',
  './assets/icons/icon.svg',
];

const AREA_INDEX_PATH = new URL('./data/area-index.json', self.location.href).pathname;
const APP_DATA_PATHS = new Set([
  './data/spots.json',
  './data/shelters.geojson',
].map((relativePath) => new URL(relativePath, self.location.href).pathname));

const PLATEAU_HOSTNAME = 'assets.cms.plateau.reearth.io';
const STORAGE_GUARD_CACHE_NAMES = [
  CACHE_NAMES.basemap,
  CACHE_NAMES.hazard,
  CACHE_NAMES.zoning,
  CACHE_NAMES.appdata,
];

function isCacheable(response) {
  return response.ok || response.type === 'opaque';
}

/** Cache APIのキー順を挿入順として扱い、古い項目から削除する。 */
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  if (excess <= 0) return;
  await Promise.all(keys.slice(0, excess).map((request) => cache.delete(request)));
}

async function putInCache(cacheName, request, response, maxEntries) {
  if (!isCacheable(response)) return;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
    if (maxEntries !== undefined) await trimCache(cache, maxEntries);
  } catch (error) {
    console.warn(`[Service Worker] ${cacheName}への保存に失敗しました`, error);
  }
}

async function fetchAndCache(request, cacheName, maxEntries) {
  const response = await fetch(request);
  await putInCache(cacheName, request, response, maxEntries);
  return response;
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  return cached || fetchAndCache(request, cacheName);
}

function staleWhileRevalidate(event, cacheName, maxEntries) {
  const update = fetchAndCache(event.request, cacheName, maxEntries);
  event.waitUntil(update.catch((error) => {
    console.warn(`[Service Worker] ${cacheName}の再検証に失敗しました`, error);
  }));
  return caches.open(cacheName)
    .then((cache) => cache.match(event.request))
    .then((cached) => cached || update);
}

async function withTimeout(promise, timeoutMs) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('通信がタイムアウトしました')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function networkFirst(event, cacheName, maxEntries) {
  const network = fetchAndCache(event.request, cacheName, maxEntries);
  event.waitUntil(network.catch(() => undefined));
  try {
    return await withTimeout(network, 5000);
  } catch (error) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    return network;
  }
}

async function navigateNetworkFirst(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const shell = await caches.open(CACHE_NAMES.shell);
    const offline = await shell.match('./offline.html');
    if (offline) return offline;
    throw error;
  }
}

function isCdnAsset(url) {
  const isCesium = url.hostname === 'cesium.com'
    && url.pathname.startsWith('/downloads/cesiumjs/releases/1.130/');
  return isCesium || url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'unpkg.com';
}

function isBasemapTile(url) {
  return url.hostname === 'cyberjapandata.gsi.go.jp'
    && url.pathname.startsWith('/xyz/');
}

function isHazardTile(url) {
  return url.hostname === 'disaportaldata.gsi.go.jp'
    && url.pathname.startsWith('/raster/');
}

function isZoningMvt(url) {
  return url.hostname === PLATEAU_HOSTNAME && url.pathname.endsWith('.mvt');
}

function isPlateau3DTile(url) {
  return url.hostname === PLATEAU_HOSTNAME && !isZoningMvt(url);
}

function isAppData(url) {
  return url.origin === self.location.origin && APP_DATA_PATHS.has(url.pathname);
}

function isAreaIndex(url) {
  return url.origin === self.location.origin && url.pathname === AREA_INDEX_PATH;
}

async function clearOldVersionedCaches() {
  const currentCaches = new Set(Object.values(CACHE_NAMES));
  const cacheNames = await caches.keys();
  const oldCaches = cacheNames.filter((cacheName) => {
    const isVersioned = cacheName.startsWith('shell-') || cacheName.startsWith('cdn-');
    return isVersioned && !currentCaches.has(cacheName);
  });
  await Promise.all(oldCaches.map((cacheName) => caches.delete(cacheName)));
}

async function guardStorageUsage() {
  if (!self.navigator.storage?.estimate) return;
  try {
    const { usage = 0, quota = 0 } = await self.navigator.storage.estimate();
    console.info(`[Service Worker] ストレージ使用量: ${usage} / ${quota} バイト`);
    if (quota > 0 && usage > quota * 0.8) {
      await Promise.all(STORAGE_GUARD_CACHE_NAMES.map((cacheName) => caches.delete(cacheName)));
      console.warn('[Service Worker] 使用量が80%を超えたためタイル・アプリデータキャッシュを削除しました');
    }
  } catch (error) {
    console.warn('[Service Worker] ストレージ使用量を確認できませんでした', error);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAMES.shell).then((cache) => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await clearOldVersionedCaches();
    await guardStorageUsage();
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(navigateNetworkFirst(event.request));
    return;
  }

  const url = new URL(event.request.url);

  if (isCdnAsset(url)) {
    event.respondWith(cacheFirst(event.request, CACHE_NAMES.cdn));
    return;
  }

  if (isBasemapTile(url)) {
    event.respondWith(staleWhileRevalidate(event, CACHE_NAMES.basemap, 300));
    return;
  }

  if (isHazardTile(url)) {
    event.respondWith(networkFirst(event, CACHE_NAMES.hazard, 200));
    return;
  }

  if (isZoningMvt(url)) {
    event.respondWith(staleWhileRevalidate(event, CACHE_NAMES.zoning, 100));
    return;
  }

  if (isPlateau3DTile(url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (isAreaIndex(url)) {
    event.respondWith(networkFirst(event, CACHE_NAMES.appdata));
    return;
  }

  if (isAppData(url)) {
    event.respondWith(staleWhileRevalidate(event, CACHE_NAMES.appdata));
  }
});
