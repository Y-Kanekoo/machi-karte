// 主要操作の体感性能をe2eから観測するための軽量計測フック。
// 数値の合否判定は行わず、LoAFとEvent Timingの生データを集計する。
const LOAF_ENTRY_TYPE = 'long-animation-frame';
const EVENT_ENTRY_TYPE = 'event';
const EVENT_DURATION_THRESHOLD_MS = 40;
const MAX_INTERACTIONS = 50;
const activeObservers = [];

/** LoAFとEvent Timingを開始し、非対応環境でも同じAPIを返す。 */
export function initPerformanceMonitoring() {
  const Observer = globalThis.PerformanceObserver;
  const supportedEntryTypes = Array.isArray(Observer?.supportedEntryTypes)
    ? Observer.supportedEntryTypes
    : [];
  let loafSupported = supportedEntryTypes.includes(LOAF_ENTRY_TYPE);
  let eventTimingSupported = supportedEntryTypes.includes(EVENT_ENTRY_TYPE);
  const interactions = [];
  let loafCount = 0;
  let loafTotalMs = 0;
  let worstLoafMs = 0;
  let pendingMarker;
  if (loafSupported) {
    try {
      const observer = new Observer((list) => {
        for (const entry of list.getEntries()) {
          loafCount += 1;
          loafTotalMs += entry.duration;
          worstLoafMs = Math.max(worstLoafMs, entry.duration);
        }
      });
      observer.observe({ type: LOAF_ENTRY_TYPE, buffered: true });
      activeObservers.push(observer);
    } catch (error) {
      loafSupported = false;
      console.warn('LoAF計測を開始できませんでした', error);
    }
  }
  if (eventTimingSupported) {
    try {
      const observer = new Observer((list) => {
        for (const entry of list.getEntries()) {
          const interactionId = Number(entry.interactionId);
          if (!Number.isFinite(interactionId) || interactionId <= 0) continue;
          const existingIndex = interactions.findIndex(
            (interaction) => interaction.interactionId === interactionId,
          );
          const existing = existingIndex >= 0 ? interactions[existingIndex] : null;
          const markedName = !existing && pendingMarker
            && entry.startTime >= pendingMarker.startTime
            ? pendingMarker.name
            : undefined;
          const name = existing?.name || markedName;
          const interaction = {
            interactionId,
            startTime: entry.startTime,
            duration: entry.duration,
            inputDelay: entry.processingStart - entry.startTime,
            processingDuration: entry.processingEnd - entry.processingStart,
            presentationDelay: entry.duration - (entry.processingEnd - entry.startTime),
            ...(name ? { name } : {}),
          };
          if (existing) {
            if (interaction.duration >= existing.duration) {
              interactions[existingIndex] = interaction;
            }
            continue;
          }
          if (markedName) pendingMarker = undefined;
          interactions.push(interaction);
          if (interactions.length > MAX_INTERACTIONS) interactions.shift();
        }
      });
      observer.observe({
        type: EVENT_ENTRY_TYPE,
        buffered: true,
        durationThreshold: EVENT_DURATION_THRESHOLD_MS,
      });
      activeObservers.push(observer);
    } catch (error) {
      eventTimingSupported = false;
      console.warn('Event Timing計測を開始できませんでした', error);
    }
  }
  function getSummary() {
    const publicInteractions = interactions.map(({ interactionId, ...interaction }) => interaction);
    return {
      supported: loafSupported,
      eventTimingSupported,
      loafCount,
      loafTotalMs,
      worstLoafMs,
      interactions: publicInteractions,
      maxInteractionMs: publicInteractions.reduce(
        (maximum, interaction) => Math.max(maximum, interaction.duration),
        0,
      ),
    };
  }
  function mark(name) {
    const normalized = String(name || '').trim();
    pendingMarker = normalized
      ? { name: normalized, startTime: globalThis.performance?.now?.() || 0 }
      : undefined;
  }
  return { getSummary, mark };
}
