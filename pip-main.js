// Runs in YouTube's MAIN world so the existing player's setSize method works.
// It has no extension APIs. The isolated content script owns background messages.
(() => {
  if (window.__ytfhPipPrototype) return;
  window.__ytfhPipPrototype = true;
  let pip = null, player = null, parent = null, next = null;
  const root = document.documentElement;
  const signal = (type, extra = {}) => {
    root.dataset.ytfhPipResult = JSON.stringify({type, ...extra});
    root.dispatchEvent(new Event('ytfh:pip-result'));
  };
  const fit = () => {
    if (!player || !pip || pip.closed || typeof player.setSize !== 'function') return;
    player.setSize(pip.innerWidth, pip.innerHeight);
  };
  const restore = () => {
    if (!player) return;
    const original = player;
    if (next?.parentNode === parent) parent.insertBefore(original, next);
    else parent.append(original);
    player = parent = next = null;
    pip = null;
    // The source tab can change viewport while the player is in PiP. Measure
    // after reinsertion, then once after the return layout settles.
    const fitSource = () => {
      if (!original.isConnected || typeof original.setSize !== 'function') return;
      const box = original.getBoundingClientRect();
      if (box.width > 100 && box.height > 100)
        original.setSize(Math.round(box.width), Math.round(box.height));
    };
    fitSource();
    setTimeout(fitSource, 120);
    signal('closed');
  };
  async function open() {
    if (pip) return signal('opened', {width:pip.outerWidth,height:pip.outerHeight});
    if (location.pathname !== '/watch' || !('documentPictureInPicture' in window))
      return signal('error', {error:'Document PiP is unavailable here.'});
    const p = document.querySelector('#movie_player');
    if (!p?.querySelector('video')) return signal('error', {error:'The YouTube player is not ready.'});
    let requested;
    try {requested = JSON.parse(root.dataset.ytfhPipRequest || '{}');} catch {requested = {};}
    const width = Number.isFinite(requested.width) ? Math.max(240, Math.min(1920, requested.width)) : 520;
    const height = Number.isFinite(requested.height) ? Math.max(180, Math.min(1080, requested.height)) : 330;
    try {
      // This call starts synchronously inside the user's button click.
      const w = await documentPictureInPicture.requestWindow({width, height});
      pip = w; player = p; parent = p.parentNode; next = p.nextSibling;
      for (const sheet of document.styleSheets) {
        try {
          const style = w.document.createElement('style');
          style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n');
          w.document.head.append(style);
        } catch {
          if (!sheet.href) continue;
          const link = w.document.createElement('link');
          link.rel = 'stylesheet'; link.href = sheet.href;
          w.document.head.append(link);
        }
      }
      const style = w.document.createElement('style');
      style.textContent = `
        html,body{margin:0!important;width:100%;height:100%;overflow:hidden;background:#000}
        #movie_player{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important}
        #movie_player .html5-video-container{position:absolute!important;inset:0!important;width:100%!important;height:100%!important}
        #movie_player video{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;object-fit:contain!important}
        #movie_player .ytp-chrome-bottom{width:calc(100% - 24px)!important;left:12px!important}
`;
      w.document.head.append(style);
      w.document.body.append(p);
      fit();
      w.addEventListener('resize', () => {
        if (pip !== w) return;
        fit();
        signal('resized', {width:w.outerWidth,height:w.outerHeight});
      });
      w.addEventListener('pagehide', () => {if (pip === w) restore();});
      signal('opened', {width:w.outerWidth,height:w.outerHeight,left:w.screenX,top:w.screenY});
    } catch (error) {
      if (pip) {const w = pip; restore(); w.close();}
      signal('error', {error:error?.message || String(error)});
    }
  }
  document.addEventListener('ytfh:pip-open', open);
  document.addEventListener('ytfh:pip-close', () => {
    if (!pip) return;
    const w = pip;
    signal('resized', {width:w.outerWidth,height:w.outerHeight});
    restore();
    w.close();
  });
})();
