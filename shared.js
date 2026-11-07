// Loaded before content.js (content script) and imported by background.js.
// Single source for logic and styles used in more than one place.

// True when two URLs are the same YouTube watch video (same ?v=).
globalThis.ytfhSameVideoUrl = function sameVideoUrl(a, b) {
  if (a === b && typeof a === 'string' && a) return true;
  try {
    const x = new URL(a), y = new URL(b), id = x.searchParams.get('v');
    return x.protocol === 'https:' && y.protocol === 'https:' &&
      x.hostname === 'www.youtube.com' && y.hostname === 'www.youtube.com' &&
      x.pathname === '/watch' && y.pathname === '/watch' && Boolean(id) && id === y.searchParams.get('v');
  } catch {return false;}
};

// Hover toolbar and native skip-button styles. content.js adds these as a
// normal <style> element so the PiP window copies them with the page's
// styles (manifest-injected CSS is not visible to document.styleSheets).
globalThis.ytfhControlsCss = `
#movie_player #ytfh-controls {
  position: absolute !important; top: 28px !important; right: 28px !important;
  max-width: calc(100% - 56px) !important; box-sizing: border-box !important;
  z-index: 2147483647 !important; display: flex !important; flex-wrap: wrap !important; justify-content: flex-end !important; gap: 6px !important;
  opacity: 0 !important; pointer-events: none !important;
  transition: opacity 180ms ease !important;
}
#movie_player #ytfh-controls.ytfh-open,
#movie_player #ytfh-controls:has(button:focus-visible) {
  opacity: 1 !important; pointer-events: auto !important;
}
#movie_player #ytfh-controls button {
  appearance: none !important; border: 1px solid #ffffff66 !important;
  border-radius: 6px !important; padding: 8px 11px !important;
  background: #111b !important; color: white !important;
  font: 13px system-ui, sans-serif !important; white-space: nowrap !important; cursor: pointer !important;
  box-shadow: 0 2px 10px #0007 !important;
}
#movie_player #ytfh-controls button:hover,
#movie_player #ytfh-controls button:focus-visible {
  background: #111e !important; outline: 2px solid #fff9 !important;
}
#movie_player #ytfh-controls button[hidden] { display: none !important; }

/* BEGIN NATIVE SKIP: mirrored in pip-main.js because extension-injected styles
   are not guaranteed to be enumerable through document.styleSheets. */
/* Preserve YouTube's DOM and event handling. Keep the real control at a stable
   location while skippable; do not make it jump when the toolbar fades. */
#movie_player #ytfh-controls.ytfh-has-native-skip {
  right: calc(34px + var(--ytfh-skip-width)) !important;
  max-width: calc(100% - 62px - var(--ytfh-skip-width)) !important;
}
#movie_player [data-ytfh-native-skip] {
  position: absolute !important; top: 28px !important; right: 28px !important;
  bottom: auto !important; left: auto !important; margin: 0 !important;
  transform: none !important; z-index: 2147483647 !important;
  box-sizing: border-box !important; max-width: calc(100% - 56px) !important;
  height: auto !important; min-height: 36px !important; padding-block: 6px !important;
}
#movie_player [data-ytfh-native-skip] .ytp-skip-ad-button__text {
  min-width: 0 !important; white-space: normal !important; overflow-wrap: anywhere !important;
}
#movie_player #ytfh-controls.ytfh-stack-skip {
  right: 28px !important; top: calc(34px + var(--ytfh-skip-height)) !important;
  max-width: calc(100% - 56px) !important;
}
@media (max-width: 360px), (max-height: 220px) {
  #movie_player #ytfh-controls.ytfh-has-native-skip { right: calc(12px + var(--ytfh-skip-width)) !important; max-width: calc(100% - 20px - var(--ytfh-skip-width)) !important; }
  #movie_player [data-ytfh-native-skip] { top: 6px !important; right: 8px !important; max-width: calc(100% - 16px) !important; }
  #movie_player #ytfh-controls.ytfh-stack-skip { right: 8px !important; top: calc(12px + var(--ytfh-skip-height)) !important; max-width: calc(100% - 16px) !important; }
}
/* END NATIVE SKIP */

#movie_player #ytfh-controls .ytfh-status {
  flex-basis: 100% !important; box-sizing: border-box !important;
  padding: 7px 10px !important; border-radius: 6px !important;
  background: #111d !important; color: white !important;
  font: 12px system-ui, sans-serif !important; text-align: right !important;
}
#movie_player #ytfh-controls .ytfh-status[hidden] { display: none !important; }

@media (max-width: 360px), (max-height: 220px) {
  #movie_player #ytfh-controls { top: 6px !important; right: 8px !important; max-width: calc(100% - 16px) !important; gap: 4px !important; }
  #movie_player #ytfh-controls button { padding: 4px 6px !important; font: 11px system-ui, sans-serif !important; }
  #movie_player #ytfh-controls .ytfh-status { padding: 4px 6px !important; font: 11px system-ui, sans-serif !important; }
}
`;
