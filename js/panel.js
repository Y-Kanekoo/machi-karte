const PANEL_STORAGE_KEY = 'controlPanelSections';

/** localStorageが利用できない環境では、保存なしの既定状態へフォールバックする。 */
function readPanelState() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(PANEL_STORAGE_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    console.warn('パネルの折りたたみ状態を読み込めませんでした', error);
    return {};
  }
}

function savePanelState(state) {
  try {
    globalThis.localStorage?.setItem(PANEL_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('パネルの折りたたみ状態を保存できませんでした', error);
  }
}

/** 左パネルの折りたたみと永続化を初期化する。 */
export function initPanelSections() {
  const sections = [...document.querySelectorAll('[data-panel-section]')];
  const savedState = readPanelState();

  function setOpen(section, open, persist = true) {
    const button = section.querySelector('.panel-section-toggle');
    const contentId = button?.getAttribute('aria-controls');
    const content = contentId ? document.getElementById(contentId) : null;
    if (!button || !content) return false;

    button.setAttribute('aria-expanded', String(open));
    content.hidden = !open;
    if (persist && section.id) {
      const nextState = readPanelState();
      nextState[section.id] = open;
      savePanelState(nextState);
    }
    return true;
  }

  for (const section of sections) {
    const button = section.querySelector('.panel-section-toggle');
    if (!section.id || !button) continue;
    const saved = savedState[section.id];
    const defaultOpen = section.dataset.defaultOpen === 'true';
    setOpen(section, typeof saved === 'boolean' ? saved : defaultOpen, false);
    button.addEventListener('click', () => {
      setOpen(section, button.getAttribute('aria-expanded') !== 'true');
    });
  }

  return {
    storageKey: PANEL_STORAGE_KEY,
    setOpen: (sectionId, open) => {
      const section = document.getElementById(sectionId);
      return !!section && setOpen(section, open);
    },
    isOpen: (sectionId) => document
      .querySelector(`#${sectionId} > .panel-section-heading .panel-section-toggle`)
      ?.getAttribute('aria-expanded') === 'true',
    getState: () => Object.fromEntries(sections
      .filter(({ id }) => id)
      .map((section) => [
        section.id,
        section.querySelector('.panel-section-toggle')?.getAttribute('aria-expanded') === 'true',
      ])),
  };
}
