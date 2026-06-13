/*
 * index.js — bootstraps the whole feature in the claude.ai page.
 *
 * Responsibilities:
 *   - read settings, honor the master enable toggle;
 *   - construct lifecycle + detector + sidebar and wire show/hide;
 *   - handle SPA navigation (claude.ai is a single-page app): tear down and
 *     re-attach cleanly on conversation switch / new chat / reload;
 *   - react live to options changes via chrome.storage;
 *   - full teardown on disable / navigation / page unload.
 *
 * Every step is defensive: missing elements => graceful no-op, never throwing
 * into Claude's page or blocking normal use.
 */
(function () {
  'use strict';

  const RSFC = window.RSFC || {};
  if (!RSFC.storage) return; // dependencies failed to load -> bail quietly

  let settings = null;
  let lifecycle = null;
  let detector = null;
  let sidebar = null;
  let active = false;            // feature currently attached?
  let unsubscribeStorage = null;
  let lastUrl = location.href;

  function buildPipeline() {
    if (active) return;
    active = true;

    lifecycle = RSFC.createLifecycle({ minVisibleMs: settings.minVisibleMs });
    sidebar = RSFC.createSidebar(settings);
    detector = RSFC.createDetector(lifecycle);

    // When the user manually closes the panel, it stays closed only until the
    // next generation begins.
    sidebar.onUserClose(() => { /* flag handled inside sidebar + reset on start */ });

    lifecycle.on('show', () => {
      RSFC.log('lifecycle -> show');
      sidebar.resetClosedFlag(); // a new generation re-enables the panel
      sidebar.show();
    });
    lifecycle.on('hide', () => {
      RSFC.log('lifecycle -> hide');
      sidebar.hide();
    });

    detector.start();
  }

  function teardownPipeline() {
    if (!active) return;
    active = false;
    try { detector && detector.stop(); } catch (e) {}
    try { lifecycle && lifecycle.reset(); } catch (e) {}
    try { sidebar && sidebar.destroy(); } catch (e) {}
    detector = null;
    lifecycle = null;
    sidebar = null;
  }

  // ---- SPA navigation handling ---------------------------------------------
  // claude.ai swaps conversations without a full reload. On URL change we reset
  // the lifecycle (any in-flight panel is for the old chat) and re-point the
  // DOM observer at the new conversation container.
  function onUrlMaybeChanged() {
    const prev = lastUrl;
    const cur = location.href;
    if (cur === prev) return;
    lastUrl = cur;
    if (!active) return;
    // Sending the FIRST message in a new chat changes the URL from /new to
    // /chat/<id>. That is the SAME generation materializing its conversation
    // URL — NOT a conversation switch — so we must NOT tear down the panel here
    // (doing so killed the video ~1s into every new chat).
    const wasNew = /\/new(\b|$)/.test(prev) || prev.endsWith('/new');
    const nowChat = cur.indexOf('/chat/') >= 0;
    if (wasNew && nowChat) {
      RSFC.log('nav: /new -> chat (same generation); keeping panel');
      return;
    }
    RSFC.log('nav: conversation switch -> reset');
    try {
      lifecycle.reset();              // drop any panel from the previous chat
      detector.reattachObserver();    // re-bind MutationObserver to new container
    } catch (e) {}
  }

  function installNavWatchers() {
    // Patch history methods to catch pushState/replaceState navigations.
    ['pushState', 'replaceState'].forEach((m) => {
      const orig = history[m];
      if (typeof orig === 'function' && !history['__rsfc_' + m]) {
        history['__rsfc_' + m] = orig;
        history[m] = function () {
          const r = orig.apply(this, arguments);
          try { window.dispatchEvent(new Event('rsfc:locationchange')); } catch (e) {}
          return r;
        };
      }
    });
    window.addEventListener('popstate', onUrlMaybeChanged);
    window.addEventListener('rsfc:locationchange', onUrlMaybeChanged);
    // Backstop: poll occasionally in case of navigation we didn't intercept.
    setInterval(onUrlMaybeChanged, 1500);
  }

  // ---- settings / master toggle --------------------------------------------
  function applyEnabledState() {
    if (settings.enabled) buildPipeline();
    else teardownPipeline();
  }

  function start() {
    RSFC.storage.getSettings().then((s) => {
      settings = s;
      installNavWatchers();
      applyEnabledState();

      unsubscribeStorage = RSFC.storage.onChange((next) => {
        const wasEnabled = settings.enabled;
        settings = next;
        if (lifecycle) lifecycle.setMinVisibleMs(settings.minVisibleMs);
        if (sidebar) sidebar.updateSettings(settings);
        if (wasEnabled !== settings.enabled) {
          applyEnabledState();
        } else if (settings.enabled && active) {
          // Source/width/etc. changed mid-session: rebuild so changes take hold
          // on the next generation. Tear down now; next gen re-creates cleanly.
          teardownPipeline();
          buildPipeline();
        }
      });
    });
  }

  // ---- full teardown on page unload / uninstall-disable ---------------------
  window.addEventListener('pagehide', teardownPipeline);
  window.addEventListener('beforeunload', teardownPipeline);

  start();
})();
