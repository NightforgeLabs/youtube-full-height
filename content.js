(() => {
  let view = 'tab';
  let busy = false;
  let changing = false;
  let lastFit = '';
  let suppressedUrl = '';
  let automatic = true;
  let controls = null;
  let positionedSkipButton = null;
  let controlsTimer = null;
  let statusTimer = null;
  let controlRecoveryTimer = null;
  let pendingPlayback = null;
  let lastPlaybackIntent = 0;
  let releaseRecoveryGuard = null;
  let restoring = false;
  let pipWindow = null;
  let pipSize = null;
  let pipSizeTrackingFallback = false;
  let pipFromFull = false;
  let holdingPark = false;
  let sourceToken = null;
  let closingByControl = false;
  // Automatic pop-out that failed for this page (e.g. YouTube in an app
  // window). Don't retry every second; retry after navigation or a setting change.
  let failedAutoUrl = '';
  // Aspect ratio of the main video, so ads don't resize the Full Height window.
  let contentRatio = 0;
  const wiredPlayers = new WeakSet();
  const incarnation = String(Date.now()) + ':' + Math.random();

  chrome.storage.local.get('automatic').then(s => {automatic = s.automatic ?? true;});
  chrome.storage.local.get('pipSize').then(s => {pipSize = s.pipSize || null;});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.pipSize) pipSize = changes.pipSize.newValue || null;
    if (area === 'local' && changes.automatic) {
      automatic = changes.automatic.newValue ?? true;
      failedAutoUrl = '';
      check();
    }
  });
  const sameVideoUrl = globalThis.ytfhSameVideoUrl;
  if (!document.getElementById('ytfh-controls-style')) {
    const style = document.createElement('style');
    style.id = 'ytfh-controls-style';
    style.textContent = globalThis.ytfhControlsCss;
    (document.head || document.documentElement).append(style);
  }
  const activePlayer = () => (pipWindow?.document || document).querySelector('#movie_player');
  const video = () => activePlayer()?.querySelector('video');
  function skippableAdButton() {
    const player = activePlayer();
    if (!player) return null;
    const selectors = '.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button, .ytp-ad-skip-button-slot [role="button"]';
    for (const button of player.querySelectorAll(selectors)) {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
      const ownerWindow = button.ownerDocument.defaultView;
      if (!ownerWindow) continue;
      const style = ownerWindow.getComputedStyle(button);
      const box = button.getBoundingClientRect();
      let visible = true;
      for (let node = button; node && node !== player; node = node.parentElement) {
        const ancestor = ownerWindow.getComputedStyle(node);
        // visibility is inherited but a child may explicitly restore it;
        // display:none and opacity:0 on an ancestor cannot be overridden.
        if (ancestor.display === 'none' || Number(ancestor.opacity) === 0) {
          visible = false;
          break;
        }
      }
      if (box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
          style.display !== 'none' && style.pointerEvents !== 'none' &&
          visible) return button;
    }
    return null;
  }
  const adShowing = () => Boolean(activePlayer()?.classList.contains('ad-showing'));
  // During an ad, keep the main video's shape (or 16:9 before it is known).
  function videoRatio() {
    const v = video();
    const live = v?.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 0;
    if (live && !adShowing()) contentRatio = live;
    return contentRatio || (adShowing() ? 16 / 9 : live || 16 / 9);
  }
  const dimensions = () => {
    return {ratio: videoRatio(),
      width: screen.availWidth, height: screen.availHeight,
      left: screen.availLeft ?? 0, top: screen.availTop ?? 0,
      viewportWidth: innerWidth, viewportHeight: innerHeight};
  };
  function scheduleFade() {
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => controls?.classList.remove('ytfh-open'), 1200);
  }
  function showControls() {
    if (!controls) return;
    updateControls();
    controls.classList.add('ytfh-open');
    scheduleFade();
  }
  function updateControls() {
    if (!controls) return;
    controls.querySelector('[data-view="full"]').hidden = view === 'full';
    controls.querySelector('[data-view="small"]').hidden = view === 'small';
    controls.querySelector('[data-view="tab"]').hidden = view === 'tab';
    // Keep YouTube's real button in its original DOM ancestry. A proxy's
    // HTMLElement.click() is synthetic and did not skip the observed live ad.
    // Keep its top position stable while skippable, even as our toolbar fades.
    const player = activePlayer();
    const nativeSkip = skippableAdButton();
    if (positionedSkipButton !== nativeSkip) {
      positionedSkipButton?.removeAttribute('data-ytfh-native-skip');
      positionedSkipButton = nativeSkip;
      nativeSkip?.setAttribute('data-ytfh-native-skip', '');
    }
    const skipBox = nativeSkip?.getBoundingClientRect();
    const skipWidth = `${skipBox?.width || 0}px`;
    const skipHeight = `${skipBox?.height || 0}px`;
    if (controls.style.getPropertyValue('--ytfh-skip-width') !== skipWidth)
      controls.style.setProperty('--ytfh-skip-width', skipWidth);
    if (controls.style.getPropertyValue('--ytfh-skip-height') !== skipHeight)
      controls.style.setProperty('--ytfh-skip-height', skipHeight);
    controls.classList.toggle('ytfh-has-native-skip', Boolean(nativeSkip));
    // Long translated labels or narrow PiP windows need a second toolbar row.
    controls.classList.toggle('ytfh-stack-skip', Boolean(nativeSkip) &&
      player.getBoundingClientRect().width - skipBox.width < 240);
  }
  const fullTitleMarker = /^(?:\[YTFH Chrome Full [0-9.]+\] (?:\[YTFH Link [0-9a-f]{32}\] )?|\[YTFH Chrome Park [0-9a-f]{32}\] )/;
  function syncWindowTitle() {
    const base = document.title.replace(fullTitleMarker, '');
    const ratio = videoRatio();
    const full = view === 'full';
    const parked = sourceToken && (holdingPark || (view === 'small' && pipFromFull));
    const link = sourceToken ? `[YTFH Link ${sourceToken}] ` : '';
    const desired = full ? `[YTFH Chrome Full ${ratio.toFixed(5)}] ${link}${base}` :
      parked ? `[YTFH Chrome Park ${sourceToken}] ${base}` : base;
    if (document.title !== desired) document.title = desired;
  }
  if (document.head) new MutationObserver(syncWindowTitle).observe(document.head,
    {subtree:true, childList:true, characterData:true});
  function mode(next) {
    if (pipWindow && next === 'tab') next = 'small';
    if (next !== 'full' && next !== 'small') next = 'tab';
    if (view === next) {syncWindowTitle(); updateControls(); if (next === 'full') recoverControls(); return;}
    if (view !== 'tab' && next === 'tab') suppressedUrl = location.href;
    if (next !== 'tab') suppressedUrl = '';
    view = next;
    syncWindowTitle();
    lastFit = '';
    // In PiP, only the floating document fills its viewport. Keep the source
    // YouTube tab usable after the same tab returns from the full-height popup.
    document.documentElement.classList.toggle('yt-full-height', next === 'full');
    document.documentElement.dataset.ytfhView = next;
    updateControls();
    if (next === 'full') recoverControls();
    else {clearTimeout(controlRecoveryTimer); controlRecoveryTimer = null;}
  }
  document.documentElement.addEventListener('ytfh:pip-result', () => {
    let result;
    try {result = JSON.parse(document.documentElement.dataset.ytfhPipResult || '{}');}
    catch {return;}
    if (result.type === 'resized' && pipSizeTrackingFallback &&
        Number.isFinite(result.width) && Number.isFinite(result.height) &&
        result.width >= 240 && result.height >= 180) {
      pipSize = {width:Math.round(result.width), height:Math.round(result.height)};
      chrome.storage.local.set({pipSize}).catch(() => {});
    }
    if (result.type === 'closed') {
      pipSizeTrackingFallback = false;
      const openingFromFull = changing && view === 'full' && !pipFromFull;
      const nativeReturn = pipFromFull && !closingByControl;
      if (nativeReturn) holdingPark = true;
      pipWindow = null;
      mode(openingFromFull ? 'full' : 'tab');
      if (nativeReturn) {
        pipFromFull = false;
        returnOrRestore().then(result => {
          if (!result.returned && controls) controls.title=result.error;
        }).catch(error => {
          if (controls) controls.title=error.message;
        }).finally(() => {
          holdingPark=false; syncWindowTitle();
        });
      }
    }
  });
  async function returnOrRestore() {
    let reason = 'Could not return to the browser.';
    try {
      const reply = await chrome.runtime.sendMessage({type:'return'});
      if (reply?.ok) {sourceToken=null; return {returned:true};}
      reason = reply?.error || reason;
    } catch (error) {reason = error?.message || reason;}
    // The Return may have completed even if its reply was lost. Inspect the
    // actual state before attempting to restore the floating video.
    const current = await chrome.runtime.sendMessage({type:'status', incarnation});
    if (!current?.ok) throw Error(reason);
    if (current.view === 'tab') {sourceToken=null; mode('tab'); return {returned:true};}
    if (location.pathname !== '/watch' || !new URL(location.href).searchParams.get('v')) {
      const recovered = await chrome.runtime.sendMessage({type:'recoverBrowser'});
      if (!recovered?.ok) throw Error(reason);
      sourceToken=null; mode('tab'); return {returned:true};
    }
    const restored = await chrome.runtime.sendMessage({type:'setView', view:'full', ...dimensions(), incarnation});
    if (!restored?.ok) throw Error(reason);
    if (restored.sourceToken) sourceToken=restored.sourceToken;
    mode('full');
    return {returned:false, error:reason};
  }
  function closePip() {
    if (!pipWindow) return;
    closingByControl = true;
    document.dispatchEvent(new Event('ytfh:pip-close'));
    closingByControl = false;
    pipWindow = null;
  }
  async function openPip() {
    if (!('documentPictureInPicture' in window))
      throw Error('Document Picture-in-Picture is unavailable in this browser.');
    const v = document.querySelector('#movie_player video');
    if (!v) throw Error('The YouTube player is not ready.');
    const ratio = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
    const requested = pipSize || {width: 520, height: Math.round(520 / ratio) + 38};
    const result = new Promise((resolve, reject) => {
      const listener = () => {
        let value;
        try {value = JSON.parse(document.documentElement.dataset.ytfhPipResult || '{}');}
        catch {return;}
        if (value.type !== 'opened' && value.type !== 'error') return;
        clearTimeout(timer);
        document.documentElement.removeEventListener('ytfh:pip-result', listener);
        value.type === 'opened' ? resolve(value) : reject(Error(value.error || 'PiP failed.'));
      };
      const timer = setTimeout(() => {
        document.documentElement.removeEventListener('ytfh:pip-result', listener);
        reject(Error('PiP did not open.'));
      }, 10000);
      document.documentElement.addEventListener('ytfh:pip-result', listener);
    });
    document.documentElement.dataset.ytfhPipRequest = JSON.stringify(requested);
    // Dispatch synchronously within the button click to preserve user activation.
    document.dispatchEvent(new Event('ytfh:pip-open'));
    const opened = await result;
    pipWindow = documentPictureInPicture.window;
    if (!pipWindow) throw Error('PiP opened but was unavailable to the extension.');
    const openedWindow = pipWindow;
    let size;
    try {
      size = await chrome.runtime.sendMessage({type:'sizePip', ...requested, initialWidth:opened.width, initialHeight:opened.height, initialLeft:opened.left, initialTop:opened.top});
    } catch (error) {console.debug('YouTube Full Height: PiP sizing unavailable', error);}
    if (size?.ok) {
      pipSizeTrackingFallback = false;
      pipSize = {width:size.width,height:size.height};
    } else {
      // The PiP window is already open and usable even when Chromium cannot
      // identify or resize it. Keep it open and remember future user resizes.
      pipSizeTrackingFallback = true;
      console.debug('YouTube Full Height: PiP sizing unavailable', size?.error);
    }
    if (pipWindow !== openedWindow || openedWindow.closed) {
      pipSizeTrackingFallback = false;
      throw Error('PiP was closed.');
    }
  }
  async function choose(next) {
    if (changing) return;
    changing = true;
    clearTimeout(statusTimer);
    if (controls) {
      controls.title = '';
      const status = controls.querySelector('[role="status"]');
      if (status) status.hidden = true;
    }
    try {
      if (next === 'small') {
        const fromFull = view === 'full';
        await openPip();
        if (fromFull) {
          const reply = await chrome.runtime.sendMessage({type:'parkFullForPip'});
          if (!reply?.ok) {closePip();throw Error(reply?.error || 'Could not open PiP.');}
          // The user can close PiP while the background parks Full Height.
          // Restore Full Height if that happened during the asynchronous call.
          if (!pipWindow || pipWindow.closed) {
            const restored = await chrome.runtime.sendMessage({type:'setView', view:'full', ...dimensions(), incarnation});
            if (restored?.ok) {if (restored.sourceToken) sourceToken=restored.sourceToken; mode('full');}
            throw Error(restored?.ok ? 'PiP was closed.' : (restored?.error || 'Could not restore Full Height.'));
          }
          pipFromFull = true;
          await chrome.runtime.sendMessage({type:'focusPip'});
        }
        mode('small');
        showControls();
        return;
      }
      if (view === 'small') {
        // A same-document navigation can leave the playing video in PiP while
        // the source tab no longer shows a watch page. Keep PiP playing if
        // Full Height cannot be opened for the current page.
        if (next === 'full' && (location.pathname !== '/watch' || !new URL(location.href).searchParams.get('v')))
          throw Error('Open a YouTube video before switching to Full Height.');
        if (pipFromFull) holdingPark = true;
        closePip();
        mode('tab');
        if (next === 'tab') {
          const fromFull = pipFromFull;
          pipFromFull = false;
          if (fromFull) {
            const result = await returnOrRestore();
            holdingPark = false; syncWindowTitle();
            if (!result.returned) throw Error(result.error);
          } else {
            const reply = await chrome.runtime.sendMessage({type:'focusTab'});
            holdingPark = false;
            if (!reply?.ok) {syncWindowTitle(); throw Error(reply?.error || 'Could not return to the browser.');}
            sourceToken = null; syncWindowTitle();
          }
          return;
        }
        pipFromFull = false;
      }
      const message = next === 'tab' ? {type: 'return'} :
        {type: 'setView', view: next, ...dimensions()};
      const reply = await chrome.runtime.sendMessage(message);
      if (!reply?.ok) throw Error(reply?.error || 'Could not change video mode.');
      if (reply.sourceToken) sourceToken = reply.sourceToken;
      mode(next);
      holdingPark = false; syncWindowTitle();
      showControls();
    } catch (error) {
      console.warn('YouTube Full Height:', error);
      if (controls) {
        controls.title = error.message;
        const status = controls.querySelector('[role="status"]');
        if (status) {
          status.textContent = error.message;
          status.hidden = false;
          clearTimeout(statusTimer);
          statusTimer = setTimeout(() => {status.hidden = true;}, 1500);
          showControls();
        }
      }
    } finally {changing = false; if (holdingPark && view !== 'small') {holdingPark=false; syncWindowTitle();}}
  }
  function ensureControls() {
    // PiP owns the active player while it is open, even if YouTube creates a
    // replacement player element in the source document.
    const player = activePlayer();
    if (!player || !player.querySelector('video') || (!pipWindow && location.pathname !== '/watch')) return;
    if (controls?.parentElement !== player) {
      controls?.remove();
      controls = player.ownerDocument.createElement('div');
      controls.id = 'ytfh-controls';
      controls.setAttribute('role', 'group');
      controls.setAttribute('aria-label', 'Video window size');
      for (const [target, label] of [
        ['full', 'Full height'], ['small', 'PiP'],
        ['tab', 'Return to tab']
      ]) {
        const button = player.ownerDocument.createElement('button');
        button.type = 'button';
        button.dataset.view = target;
        button.textContent = label;
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopImmediatePropagation();
          choose(target);
        });
        controls.append(button);
      }
      const status = player.ownerDocument.createElement('span');
      status.className = 'ytfh-status';
      status.setAttribute('role', 'status');
      status.hidden = true;
      controls.append(status);
      controls.addEventListener('mouseleave', scheduleFade);
      controls.addEventListener('focusin', showControls);
      controls.addEventListener('focusout', scheduleFade);
      player.append(controls);
      updateControls();
    }
    if (!wiredPlayers.has(player)) {
      wiredPlayers.add(player);
      // A hover reveals the controls without changing YouTube playback.
      // Pointer movement also covers a player that appeared under the cursor.
      player.addEventListener('pointerenter', event => {
        if (event.pointerType === 'mouse' || event.pointerType === 'pen') showControls();
      }, true);
      player.addEventListener('pointermove', event => {
        if (event.pointerType === 'mouse' || event.pointerType === 'pen') showControls();
      }, true);
    }
  }
  function recoverControls() {
    // YouTube may replace its player as the tab moves between windows. Recheck
    // briefly so the hover controls return promptly when the new player appears.
    clearTimeout(controlRecoveryTimer);
    const end = performance.now() + 1500;
    const retry = () => {
      if (view !== 'full' || location.pathname !== '/watch') return;
      ensureControls();
      if (performance.now() < end) controlRecoveryTimer = setTimeout(retry, 100);
      else controlRecoveryTimer = null;
    };
    retry();
  }
  function capture() {
    const v = video();
    if (!v || !Number.isFinite(v.currentTime)) return null;
    return {incarnation, time: v.currentTime, paused: v.paused, volume: v.volume,
      muted: v.muted, rate: v.playbackRate};
  }
  function rememberPlaybackIntent(event) {
    if (!event.isTrusted) return;
    if (event.type === 'pointerdown' && !event.target?.closest?.('#movie_player')) return;
    if (event.type === 'keydown') {
      if (event.ctrlKey || event.metaKey || event.altKey ||
          event.target?.closest?.('input, textarea, select, [contenteditable="true"]') ||
          ![' ', 'k', 'j', 'l', 'm', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    }
    lastPlaybackIntent = Date.now();
    releaseRecoveryGuard?.();
    const p = pendingPlayback;
    if (p && p.capturedAt <= lastPlaybackIntent) {
      pendingPlayback = null;
      chrome.runtime.sendMessage({type: 'playbackApplied', token: p.token}).catch(() => {});
    }
  }
  document.addEventListener('pointerdown', rememberPlaybackIntent, true);
  document.addEventListener('keydown', rememberPlaybackIntent, true);
  function protectRestoredState(v, p) {
    releaseRecoveryGuard?.();
    // YouTube can overwrite transferred playback settings while initializing.
    // Protect them briefly, unless the user interacts.
    let timer;
    const stop = () => {
      clearTimeout(timer);
      v.removeEventListener('volumechange', onChange);
      v.removeEventListener('play', onPlay);
      if (releaseRecoveryGuard === stop) releaseRecoveryGuard = null;
    };
    const onChange = () => {
      if (!v.isConnected || video() !== v || !sameVideoUrl(p.url, location.href)) {stop(); return;}
      try {
        if (Number.isFinite(p.volume) && Math.abs(v.volume - p.volume) > 0.001) v.volume = p.volume;
        if (typeof p.muted === 'boolean' && v.muted !== p.muted) v.muted = p.muted;
      } catch {stop();}
    };
    const onPlay = () => {
      if (!v.isConnected || video() !== v || !sameVideoUrl(p.url, location.href)) {stop(); return;}
      if (p.paused && !v.paused) v.pause();
    };
    releaseRecoveryGuard = stop;
    v.addEventListener('volumechange', onChange);
    if (p.paused) v.addEventListener('play', onPlay);
    timer = setTimeout(stop, 2000);
  }
  async function restorePlayback() {
    const p = pendingPlayback;
    const v = video();
    if (!p || !v || v.readyState < 1 || restoring) return;
    if (!sameVideoUrl(p.url, location.href)) {
      pendingPlayback = null;
      chrome.runtime.sendMessage({type: 'playbackApplied', token: p.token}).catch(() => {});
      return;
    }
    if (Date.now() - p.capturedAt >= 15000) {pendingPlayback = null; return;}
    restoring = true;
    try {
      if (Number.isFinite(p.volume)) v.volume = p.volume;
      if (typeof p.muted === 'boolean') v.muted = p.muted;
      if (Number.isFinite(p.rate) && p.rate > 0) v.playbackRate = p.rate;
      // The transfer normally keeps the document. Seek only after a reload reset.
      if (Number.isFinite(p.time) &&
          (p.paused ? Math.abs(v.currentTime - p.time) > 0.25 : p.time > 2 && v.currentTime + 2 < p.time)) {
        // Metadata can arrive before the player accepts seeks. Keep the
        // snapshot pending so the next player check can retry.
        try {v.currentTime = p.time;} catch {return;}
      }
      if (p.paused && !v.paused) v.pause();
      if (p.paused === false && v.paused) {
        // Preserve the snapshot if the browser temporarily rejects playback.
        try {await v.play();} catch {return;}
      }
      if (pendingPlayback?.token !== p.token) return;
      protectRestoredState(v, p);
      pendingPlayback = null;
      await chrome.runtime.sendMessage({type: 'playbackApplied', token: p.token}).catch(() => {});
    } finally {restoring = false;}
  }
  async function status() {
    try {
      const reply = await chrome.runtime.sendMessage({type: 'status', incarnation});
      if (reply?.sourceToken) sourceToken = reply.sourceToken;
      mode(reply?.view);
      if (reply?.suppressed) suppressedUrl = location.href;
      if (reply?.playback) {
        if (reply.playback.capturedAt <= lastPlaybackIntent)
          chrome.runtime.sendMessage({type: 'playbackApplied', token: reply.playback.token}).catch(() => {});
        else pendingPlayback = reply.playback;
      }
      restorePlayback();
    } catch {}
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'mode') {if (message.sourceToken) sourceToken=message.sourceToken; mode(message.view); respond({ok: true});}
    if (message.type === 'dimensions') respond(dimensions());
    if (message.type === 'capture') respond(capture());
  });
  async function check() {
    // A hidden source tab with no PiP has nothing to show or pop out.
    if (document.hidden && !pipWindow && view === 'tab') return;
    // Ad readiness changes independently of video dimensions and pointer input.
    // Refresh even if the early returns below skip window fitting.
    ensureControls();
    updateControls();
    const v = video();
    if (!v || !v.videoWidth || !v.videoHeight) return;
    restorePlayback();
    if (busy || changing) return;
    const size = dimensions();
    if (view === 'tab' && (!automatic || sameVideoUrl(suppressedUrl, location.href) ||
        failedAutoUrl === location.href ||
        document.hidden || location.pathname !== '/watch' ||
        !new URL(location.href).searchParams.has('v') || v.paused || v.ended)) return;
    if (view === 'small') return; // Never undo a user-adjusted small window.
    const signature = JSON.stringify(size);
    if (view === 'full' && signature === lastFit) return;
    busy = true;
    try {
      const reply = await chrome.runtime.sendMessage({
        type: view === 'full' ? 'fit' : 'playing', ...size, incarnation
      });
      if (reply?.ok && !changing) {
        if (view === 'full') lastFit = signature;
        if (reply.sourceToken) sourceToken=reply.sourceToken;
        mode(reply.view);
      } else if (reply?.suppressed) suppressedUrl = location.href;
      else if (reply?.error) {
        if (view === 'tab') failedAutoUrl = location.href;
        console.debug('YouTube Full Height:', reply.error);
      }
    } catch (error) {console.debug('YouTube Full Height:', error);}
    finally {busy = false;}
  }
  status();
  setInterval(check, 1000);
  document.addEventListener('play', check, true);
  document.addEventListener('loadedmetadata', check, true);
  document.addEventListener('yt-navigate-finish', check);
  window.addEventListener('resize', check);
  window.addEventListener('focus', () => {status().then(check);});
  document.addEventListener('visibilitychange', () => {if (!document.hidden) check();});
})();
