import {geometry} from './geometry.js';
import './shared.js';

// One serialized queue and session-backed transitions survive worker suspension.
let queue = Promise.resolve();
const serial = job => {
  const result = queue.then(job);
  queue = result.catch(error => console.warn('YouTube Full Height:', error));
  return result;
};
const key = id => 'video:' + id;
const read = async id => (await chrome.storage.session.get(key(id)))[key(id)];
const write = (id, info) => chrome.storage.session.set({[key(id)]: info});
const sameVideoUrl = globalThis.ytfhSameVideoUrl;
const valid = tab => /^https:\/\/www\.youtube\.com\//.test(tab?.url || '');
const watchUrl = url => {
  try {const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'www.youtube.com' &&
    u.pathname === '/watch' && Boolean(u.searchParams.get('v'));} catch {return false;}
};
const notify = async (id, view) => {
  const info = await read(id);
  return chrome.tabs.sendMessage(id, {type:'mode', enabled:view !== 'tab', view, sourceToken:info?.sourceToken}, {frameId:0}).catch(() => {});
};

async function capturePlayback(id, url) {
  try {
    const value = await chrome.tabs.sendMessage(id, {type: 'capture'}, {frameId: 0});
    if (!Number.isFinite(value?.time)) return null;
    return {...value, url, token: String(Date.now()) + ':' + Math.random(), capturedAt: Date.now()};
  } catch { return null; }
}
function pendingPlayback(info, tab, incarnation) {
  const p = info?.playback;
  return p && watchUrl(tab.url) && sameVideoUrl(p.url, tab.url) && p.incarnation !== incarnation &&
    Date.now() - p.capturedAt < 15000 ? p : null;
}
async function restoreOrigin(info) {
  if (!info?.sourceHidden && info?.sourceHideStage !== 'attempting') return;
  try {
    const win = await chrome.windows.get(info.origin);
    if (win.state === 'minimized') {
      await chrome.windows.update(win.id, {state: info.originState === 'maximized' ? 'maximized' : 'normal'});
    }
  } catch {}
}
async function hideOrigin(id, info) {
  let attempted = false;
  const cleared = {...info};
  delete cleared.sourceHideStage;
  try {
    const win = await chrome.windows.get(info.origin);
    if (win.state === 'minimized') {
      // Only claim a minimized source if this extension had already recorded
      // an in-flight minimize. A source that was previously minimized stays so.
      const done = info.sourceHideStage === 'attempting' ? {...cleared, sourceHidden:true} : cleared;
      await write(id, done);
      return;
    }
    await write(id, {...info, sourceHideStage:'attempting'});
    attempted = true;
    await chrome.windows.update(win.id, {state: 'minimized'});
    const done = {...cleared, sourceHidden:true};
    await write(id, done);
  } catch (error) {
    // If tracking failed after minimization, do not leave an untracked
    // source browser hidden. A rejected update may also have taken effect.
    if (attempted) {
      try {await chrome.windows.update(info.origin, {state: info.originState === 'maximized' ? 'maximized' : 'normal'});} catch {}
    }
    try {await write(id, cleared);} catch {}
    console.warn('YouTube Full Height: source window could not be minimized', error);
  }
}
async function reconcile(id) {
  let info = await read(id);
  if (!info) return;
  let tab;
  try {tab = await chrome.tabs.get(id);}
  catch {
    await restoreOrigin(info);
    await chrome.storage.session.remove(key(id));
    return;
  }
  if (info.phase === 'opening') {
    const win = await chrome.windows.get(tab.windowId);
    if (tab.windowId !== info.origin && win.type === 'popup') {
      info = {...info, phase: 'popped', popup: tab.windowId, sourceHideStage:'needed'};
      await write(id, info);
    } else {
      await chrome.storage.session.remove(key(id));
      return;
    }
  }
  if (info.phase === 'popped' && tab.windowId === info.popup && info.sourceHideStage) {
    // Finish an interrupted source hide before presenting Full Height.
    await hideOrigin(id, info);
    info = await read(id) || info;
  }
  if (info.phase === 'returning') {
    await completeReturn(id, info, tab);
    return read(id);
  }
  if (info.phase === 'popped' && tab.windowId !== info.popup) {
    await restoreOrigin(info);
    info = {phase: 'suppressed', url: tab.url, view: 'tab'};
    await write(id, info);
    await notify(id, 'tab');
  }
  return info;
}
async function frameInsets(id, win, size) {
  const zoom = await chrome.tabs.getZoom(id);
  return {
    width: Number.isFinite(size.viewportWidth) ? Math.max(0, win.width - size.viewportWidth * zoom) : 0,
    height: Number.isFinite(size.viewportHeight) ? Math.max(0, win.height - size.viewportHeight * zoom) : 32
  };
}
async function resizeView(id, info, size, view) {
  if (view !== 'full') return {ok: false};
  const win = await chrome.windows.get(info.popup);
  const frame = await frameInsets(id, win, size);
  const bounds = geometry(size, frame.width, frame.height);
  const next = {...info, view};
  await write(id, next);
  try {
    if (win.state !== 'normal') await chrome.windows.update(win.id, {state: 'normal'});
    await chrome.windows.update(win.id, bounds);
  } catch (error) {
    await write(id, info);
    throw error;
  }
  await notify(id, view);
  return {ok: true, enabled: true, view, sourceToken: (await read(id))?.sourceToken};
}
async function fit(id, info, size) {
  if (info.view !== 'full') return;
  const win = await chrome.windows.get(info.popup);
  const frame = await frameInsets(id, win, size);
  const bounds = geometry(size, frame.width, frame.height);
  if (win.state !== 'normal' || Object.keys(bounds).some(k => Math.abs(win[k] - bounds[k]) > 1)) {
    if (win.state !== 'normal') await chrome.windows.update(win.id, {state: 'normal'});
    await chrome.windows.update(win.id, bounds);
  }
}
async function openVideo(id, size, force = false, view = 'full') {
  const tab = await chrome.tabs.get(id);
  if (!watchUrl(tab.url)) return {ok: false, error: 'Open a YouTube video first.'};
  const info = await reconcile(id);
  if (info?.phase === 'popped') {
    if (force && (info.view !== view || (await chrome.windows.get(info.popup)).state === 'minimized'))
      return resizeView(id, info, size, view);
    await notify(id, info.view || 'full');
    return {ok: true, enabled: true, view: info.view || 'full'};
  }
  const {automatic = true} = await chrome.storage.local.get('automatic');
  if (!force && !automatic) return {ok: false};
  if (!force && info?.phase === 'suppressed' && sameVideoUrl(info.url, tab.url))
    return {ok: false, suppressed: true};
  const originWindow = await chrome.windows.get(tab.windowId);
  if (originWindow.type !== 'normal')
    return {ok: false, error: 'Start from a normal Chrome window.'};
  const playback = await capturePlayback(id, tab.url);
  const intent = {phase: 'opening', view, origin: tab.windowId, originState: originWindow.state,
    originBounds: {left:originWindow.left, top:originWindow.top,
      width:originWindow.width, height:originWindow.height},
    index: tab.index, pinned: tab.pinned, url: tab.url, sourceToken:crypto.randomUUID().replaceAll('-',''),
    documentIncarnation: size.incarnation || playback?.incarnation, playback};
  await write(id, intent);
  try {
    const bounds = geometry(size, 0, 32);
    const win = await chrome.windows.create({tabId: id, type: 'popup', focused: true, ...bounds});
    const popped = {...intent, phase: 'popped', popup: win.id, sourceHideStage:'needed'};
    await write(id, popped);
    await hideOrigin(id, popped);
    await notify(id, view);
    return {ok: true, enabled: true, view, sourceToken: (await read(id))?.sourceToken};
  } catch (error) {
    const recovered = await reconcile(id);
    if (recovered?.phase === 'popped') {
      await notify(id, recovered.view || view);
      return {ok: true, enabled: true, view: recovered.view || view};
    }
    throw error;
  }
}
async function finishReturn(id, info, tab = null) {
  tab ||= await chrome.tabs.get(id);
  let target;
  try {target = await chrome.windows.get(info.origin);} catch {}
  if (target?.type !== 'normal') target = null;
  // Chrome 155 can move directly out of a popup, avoiding a second transfer.
  // Keep the normal-window transit for Chrome builds that reject that move.
  const current = await chrome.windows.get(tab.windowId);
  if (current.type !== 'normal' && target) {
    try {
      const tabs = await chrome.tabs.query({windowId: target.id});
      await chrome.tabs.move(id, {windowId: target.id, index: Math.min(info.index, tabs.length)});
    } catch {}
    tab = await chrome.tabs.get(id); // A rejected move may still have completed.
  }
  if ((await chrome.windows.get(tab.windowId)).type !== 'normal') {
    const placement = !target && info.originState === 'normal' ? info.originBounds || {} : {};
    const normal = await chrome.windows.create({tabId: id, type: 'normal', focused: true, ...placement});
    tab = await chrome.tabs.get(id);
    info = {...info, transit: normal.id};
    await write(id, info);
  }
  if (target && tab.windowId !== target.id) {
    const tabs = await chrome.tabs.query({windowId: target.id});
    await chrome.tabs.move(id, {windowId: target.id, index: Math.min(info.index, tabs.length)});
  }
  const returned = await chrome.tabs.get(id);
  const restoredTab = await chrome.tabs.update(id, {active: true, pinned: Boolean(info.pinned)});
  // Pinning can move the tab to the end of Chrome's pinned group. Restore
  // its saved index after applying the pin state when the original window exists.
  if (target && restoredTab.windowId === target.id && Number.isInteger(info.index) && restoredTab.index !== info.index) {
    const tabs = await chrome.tabs.query({windowId:target.id});
    await chrome.tabs.move(id, {windowId:target.id, index:Math.min(info.index, Math.max(0, tabs.length - 1))});
  }
  // Prepare the page before showing the source, but keep the returning state
  // until its window has actually been restored.
  await notify(id, 'tab');
  const finalWindow = await chrome.windows.get(returned.windowId);
  if (info.sourceHidden && returned.windowId === info.origin && finalWindow.state === 'minimized') {
    // Revealing and focusing in one update avoids a second desktop window change.
    await chrome.windows.update(returned.windowId, {
      state: info.originState === 'maximized' ? 'maximized' : 'normal', focused: true
    });
  } else {
    await restoreOrigin(info);
    // A single-tab source (or a source closed while floating) may need a new
    // normal window. Restore maximization only on the window we created.
    const recreated = !target && info.transit === returned.windowId;
    const recreateMaximized = recreated && info.originState === 'maximized';
    const bounds = info.originBounds;
    const correctBounds = recreated && info.originState === 'normal' &&
      bounds && ['left','top','width','height'].every(k => Number.isFinite(bounds[k])) &&
      bounds.width > 0 && bounds.height > 0 &&
      ['left','top','width','height'].some(k => Math.abs(finalWindow[k] - bounds[k]) > 1);
    const update = recreateMaximized ? {state:'maximized', focused:true} :
      correctBounds ? {...bounds, focused:true} : {focused:true};
    await chrome.windows.update(returned.windowId, update);
  }
  await write(id, {phase: 'suppressed', view: 'tab', url: info.returnUrl || returned.url,
    playback: info.playback});
}
async function returnVideo(id) {
  const info = await reconcile(id);
  if (info?.phase !== 'popped') return {ok: true, view: 'tab'};
  const tab = await chrome.tabs.get(id);
  const returning = {...info, phase: 'returning', returnUrl: tab.url,
    playback: await capturePlayback(id, tab.url)};
  await write(id, returning);
  return completeReturn(id, returning, tab);
}
async function completeReturn(id, info, tab = null) {
  try {
    await finishReturn(id, info, tab);
    return {ok:true, view:'tab'};
  } catch (error) {
    // A failed API call may still have moved the tab. Inspect the actual
    // window before deciding which recovery path is safe.
    let current, win;
    try {current = await chrome.tabs.get(id); win = await chrome.windows.get(current.windowId);}
    catch {throw error;}
    if (win.type === 'popup' && win.id === info.popup) {
      await write(id, {...info, phase:'popped', view:'full'});
      try {await chrome.windows.update(win.id, {state:'normal', focused:true});} catch {}
      await notify(id, 'full');
      return {ok:false, error:'Could not return to the browser; the video remains in Full Height.'};
    }
    if (win.type === 'normal') {
      try {await chrome.tabs.update(id, {active:true, pinned:Boolean(info.pinned)});} catch {}
      await notify(id, 'tab');
      await restoreOrigin(info);
      try {await chrome.windows.update(win.id, {focused:true});} catch {}
      await write(id, {phase:'suppressed', view:'tab', url:current.url, playback:info.playback});
      return {ok:true, view:'tab'};
    }
    throw error;
  }
}
async function recoverBrowser(id) {
  let info = await reconcile(id);
  if (info?.phase !== 'popped') return {ok:true, view:'tab'};
  // Retry the ordinary Return first so the original source and tab order are
  // preserved when the failure was transient.
  try {
    const reply = await returnVideo(id);
    if (reply?.ok) return reply;
  } catch {}
  info = await read(id);
  let tab = await chrome.tabs.get(id);
  let win = await chrome.windows.get(tab.windowId);
  if (win.type !== 'normal') {
    try {
      const replacement = await chrome.windows.create({tabId:id, type:'normal', focused:true});
      tab = await chrome.tabs.get(id);
      win = replacement;
    } catch (error) {
      // If even the replacement fails, at least try to expose the current
      // popup rather than leave the only page minimized.
      try {await chrome.windows.update(win.id, {state:'normal', focused:true});} catch {}
      return {ok:false, error:error?.message || 'Could not restore the browser.'};
    }
  }
  try {await chrome.tabs.update(id, {active:true, pinned:Boolean(info?.pinned)});} catch {}
  await write(id, {phase:'suppressed', view:'tab', url:tab.url});
  await restoreOrigin(info);
  await notify(id, 'tab');
  await chrome.windows.update(tab.windowId, {focused:true});
  return {ok:true, view:'tab'};
}
async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object')
    return {ok: false};
  if (message.type === 'openCurrent' && !sender.tab) {
    const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
    if (!tab || !watchUrl(tab.url)) return {ok: false, error: 'Open a YouTube video first.'};
    let size;
    // Tabs opened before install/update have no content script yet.
    try {size = await chrome.tabs.sendMessage(tab.id, {type: 'dimensions'}, {frameId: 0});} catch {}
    if (!size) return {ok: false, error: 'Reload this YouTube page once, then try again.'};
    return openVideo(tab.id, size, true, 'full');
  }
  if (!valid(sender.tab) || sender.frameId !== 0) return {ok: false};
  const id = sender.tab.id;
  if (message.type === 'playing') return openVideo(id, message);
  if (message.type === 'setView') {
    if (message.view !== 'full') return {ok: false};
    return openVideo(id, message, true, message.view);
  }
  if (message.type === 'return') return returnVideo(id);
  if (message.type === 'recoverBrowser') return recoverBrowser(id);
  if (message.type === 'parkFullForPip') {
    const info = await reconcile(id);
    if (info?.phase !== 'popped') return {ok:false,error:'Full Height window unavailable.'};
    try {
      await chrome.windows.update(info.popup,{state:'minimized'});
      await write(id,{...info,view:'small'});
    } catch (error) {
      // An error after minimization must not leave the only video hidden.
      try {await chrome.windows.update(info.popup,{state:'normal',focused:true});} catch {}
      try {await write(id,info);} catch {}
      throw error;
    }
    return {ok:true};
  }
  if (message.type === 'sizePip') {
    const width = Math.round(message.width), height = Math.round(message.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 240 || height < 180)
      return {ok:false,error:'Invalid PiP window size.'};
    // Chrome gives no direct handle to a Document PiP window. Candidates are
    // always-on-top single-tab windows whose URL is hidden from this extension.
    let candidates = (await chrome.windows.getAll({populate:true})).filter(win =>
      win.alwaysOnTop && win.tabs?.length === 1 && !win.tabs[0].url);
    if (candidates.length > 1 && Number.isFinite(message.initialWidth) && Number.isFinite(message.initialHeight)) {
      // Prefer the window matching the size the PiP page just reported.
      const sized = candidates.filter(win => Math.abs(win.width - message.initialWidth) <= 2 &&
        Math.abs(win.height - message.initialHeight) <= 2);
      if (sized.length) candidates = sized;
    }
    // Window IDs increase, so the highest remaining ID is the newest window.
    candidates.sort((a, b) => b.id - a.id);
    const candidate = candidates[0];
    if (!candidate) return {ok:false,error:'Could not identify the PiP window.'};
    const changed = Number.isFinite(message.initialWidth) && Number.isFinite(message.initialHeight) &&
      (Math.abs(candidate.width-message.initialWidth)>2 || Math.abs(candidate.height-message.initialHeight)>2 ||
       (Number.isFinite(message.initialLeft) && Math.abs(candidate.left-message.initialLeft)>2) ||
       (Number.isFinite(message.initialTop) && Math.abs(candidate.top-message.initialTop)>2));
    const {pipPosition} = await chrome.storage.local.get('pipPosition');
    const position = Number.isFinite(pipPosition?.left) && Number.isFinite(pipPosition?.top) ? pipPosition : {};
    let win = candidate;
    if (!changed) {
      try {win = await chrome.windows.update(candidate.id, {width,height,...position});}
      catch (error) {
        // A saved position may no longer be valid (for example after a
        // monitor is disconnected). Still try to restore the saved size.
        if (!Object.keys(position).length) throw error;
        win = await chrome.windows.update(candidate.id, {width,height});
      }
    }
    await chrome.storage.session.set({['pip:' + id]:win.id, ['pipMeta:' + win.id]:{left:win.left,top:win.top,width:win.width,height:win.height}});
    if (changed) {
      const remembered = {pipSize:{width:win.width,height:win.height}};
      if ([win.left,win.top,message.initialLeft,message.initialTop].every(Number.isFinite) &&
          (Math.abs(win.left-message.initialLeft)>2 || Math.abs(win.top-message.initialTop)>2))
        remembered.pipPosition = {left:win.left,top:win.top};
      await chrome.storage.local.set(remembered);
    }
    return {ok:true,width:win.width,height:win.height};
  }
  if (message.type === 'focusPip') {
    const pipId = (await chrome.storage.session.get('pip:' + id))['pip:' + id];
    if (!Number.isInteger(pipId)) return {ok:false};
    await chrome.windows.update(pipId, {focused:true});
    return {ok:true};
  }
  if (message.type === 'focusTab') {
    const tab = await chrome.tabs.get(id);
    await chrome.tabs.update(id, {active: true});
    await chrome.windows.update(tab.windowId, {focused: true});
    return {ok: true};
  }
  if (message.type === 'playbackApplied') {
    const info = await read(id);
    if (info?.playback?.token === message.token) {
      delete info.playback;
      await write(id, info);
    }
    return {ok: true};
  }
  if (message.type === 'status' || message.type === 'fit') {
    let info = await reconcile(id);
    // A full-page navigation destroys Document PiP. If its source was a
    // minimized Full Height popup, reveal watch pages in Full Height and
    // return other pages to a normal browser window.
    if (message.type === 'status' && info?.phase === 'popped' && info.view === 'small' &&
        info.documentIncarnation && message.incarnation && info.documentIncarnation !== message.incarnation) {
      if (!watchUrl(sender.tab.url)) {
        await returnVideo(id);
        info = await read(id);
      } else {
        await chrome.windows.update(info.popup, {state:'normal', focused:true});
        info = {...info, view:'full', documentIncarnation:message.incarnation};
        await write(id, info);
        await notify(id, 'full');
      }
    }
    const enabled = info?.phase === 'popped';
    if (enabled && message.type === 'fit') await fit(id, info, message);
    return {ok: true, enabled, sourceToken:info?.sourceToken, view: enabled ? info.view || 'full' : 'tab',
      suppressed: info?.phase === 'suppressed' && sameVideoUrl(info.url, sender.tab.url),
      playback: pendingPlayback(info, sender.tab, message.incarnation)};
  }
  return {ok: false};
}
// Full height automatic is on by default (an unset value means on). Users can
// turn it off from the toolbar popup.
chrome.runtime.onInstalled.addListener(({reason}) => {
  // The small popup-window mode was removed; drop its saved bounds.
  if (reason === 'update') chrome.storage.local.remove('smallBounds').catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  serial(() => handle(message, sender))
    .then(respond, error => respond({ok: false, error: error.message}));
  return true;
});
chrome.tabs.onRemoved.addListener(id => {serial(async () => {
  const info = await read(id);
  await restoreOrigin(info);
  await chrome.storage.session.remove(key(id));
});});
chrome.tabs.onAttached.addListener(id => {serial(() => reconcile(id));});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (!change.url && change.status !== 'complete' && change.status !== 'loading') return;
  serial(async () => {
    // Updates can queue behind a window transition. Ignore an intermediate
    // URL if the tab has already navigated somewhere else.
    let tab;
    try {tab = await chrome.tabs.get(id);} catch {return;}
    if (change.url && tab.url && tab.url !== change.url) return;
    const info = await read(id);
    if (!change.url) {
      // Without broad tabs permission Chrome withholds URLs outside the
      // YouTube host. A completed, unreadable tracked tab has left it.
      if (!tab.url && !tab.pendingUrl && info?.phase === 'popped') {
        if (change.status === 'complete' && tab.status === 'complete') await returnVideo(id);
        else if (change.status === 'loading' && tab.status === 'loading') {
          // The destination may never finish loading. Recheck after a short
          // delay so a transient or superseded navigation is not acted on.
          setTimeout(() => {serial(async () => {
            let current;
            try {current = await chrome.tabs.get(id);} catch {return;}
            const latest = await read(id);
            if (latest?.phase === 'popped' && current.status === 'loading' && !current.url && !current.pendingUrl)
              await returnVideo(id);
          }).catch(() => {});}, 750);
        }
      }
      return;
    }
    if (info?.phase === 'suppressed' && !sameVideoUrl(info.url, change.url))
      await chrome.storage.session.remove(key(id));
    if (info?.phase === 'popped' &&
        (!valid({url: change.url}) || (info.view === 'full' && !watchUrl(change.url))))
      await returnVideo(id);
  });
});
chrome.windows.onBoundsChanged.addListener(async win => {
  // Fires continuously while any Chrome window is dragged. Only PiP windows we
  // sized are interesting; check that with one key before entering the queue.
  if (win.state !== 'normal' || ![win.left, win.top, win.width, win.height].every(Number.isFinite)) return;
  const metaKey = 'pipMeta:' + win.id;
  let meta;
  try {meta = (await chrome.storage.session.get(metaKey))[metaKey];} catch {return;}
  if (!meta) return;
  serial(async () => {
    const latest = (await chrome.storage.session.get(metaKey))[metaKey];
    if (!latest) return;
    let current;
    try {current = await chrome.windows.get(win.id);} catch {return;}
    // Skip intermediate drag events; only record the settled bounds.
    if (['left','top','width','height'].some(k => current[k] !== win[k])) return;
    if (['left','top','width','height'].every(k => latest[k] === win[k])) return;
    const update = {pipSize:{width:win.width,height:win.height}};
    if (win.left !== latest.left || win.top !== latest.top) update.pipPosition = {left:win.left,top:win.top};
    await chrome.storage.local.set(update);
    await chrome.storage.session.set({[metaKey]:{left:win.left,top:win.top,width:win.width,height:win.height}});
  }).catch(() => {});
});

chrome.windows.onRemoved.addListener(winId => {serial(async () => {
  const values = await chrome.storage.session.get(null);
  const keys = Object.entries(values).filter(([key,value]) =>
    (key.startsWith('pip:') && value === winId) || key === 'pipMeta:' + winId).map(([key])=>key);
  if (keys.length) await chrome.storage.session.remove(keys);
});});

// Resume window transitions left in progress if the service worker restarts.
serial(async () => {
  const values = await chrome.storage.session.get(null);
  for (const [name, info] of Object.entries(values)) {
    if (!name.startsWith('video:')) continue;
    if (info?.phase !== 'opening' && info?.phase !== 'returning' &&
        !(info?.phase === 'popped' && info.sourceHideStage)) continue;
    const id = Number(name.slice('video:'.length));
    if (!Number.isInteger(id) || id < 0) continue;
    try {await reconcile(id);} catch (error) {
      console.warn('YouTube Full Height: transition recovery failed', error);
    }
  }
}).catch(() => {});
