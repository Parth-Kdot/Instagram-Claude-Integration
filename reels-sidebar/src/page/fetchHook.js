/*
 * fetchHook.js — injected into the PAGE (MAIN world) at document_start.
 *
 * This is the AUTHORITATIVE generation signal. claude.ai streams the assistant
 * response over a long-lived HTTP request (a POST to a completion endpoint).
 * By patching window.fetch and XMLHttpRequest we can observe exactly when that
 * request opens (generation start) and when its response body stream closes
 * (generation end), regardless of any DOM changes.
 *
 * PRIVACY: we observe REQUEST TIMING ONLY. We match on the URL, and for the
 * stream we look solely at the reader's `done` flag — we never read, inspect,
 * decode, buffer, or transmit any request body, response chunk, prompt, or
 * response text. The only thing that ever leaves this file is a postMessage of
 * the shape { source: 'rsfc-net', type: 'gen-start' | 'gen-end' }.
 *
 * SAFETY: every patch is wrapped so that if anything goes wrong we fall back to
 * the original, unmodified behavior. This must never block or alter Claude's
 * own network activity.
 *
 * Runs in MAIN world so it can see the page's real fetch/XHR. It talks to the
 * ISOLATED-world detector (detector.js) exclusively via window.postMessage.
 */
(function () {
  'use strict';

  // Guard against double-injection (e.g. SPA soft reloads re-running scripts).
  if (window.__rsfcFetchHookInstalled) return;
  window.__rsfcFetchHookInstalled = true;

  const SOURCE = 'rsfc-net';

  /*
   * URL matcher for the assistant-streaming request. Kept deliberately broad so
   * a minor endpoint rename still matches. claude.ai's completion endpoints look
   * like:
   *   /api/organizations/<org>/chat_conversations/<uuid>/completion
   *   /api/organizations/<org>/chat_conversations/<uuid>/retry_completion
   * We match any of those "completion" / "retry" style POST paths.
   *
   * NOTE: detector.js holds the *canonical* copy of this knowledge for the DOM
   * side. This MAIN-world file can't import it, so it keeps its own minimal copy.
   * If claude.ai changes endpoints, update both — but the DOM fallback in
   * detector.js will keep the feature working in the meantime.
   */
  function isCompletionUrl(url) {
    try {
      const u = String(url);
      return /\/(completion|retry_completion|retry)(\?|$)/.test(u) ||
             (/chat_conversations\//.test(u) && /completion/.test(u));
    } catch (e) {
      return false;
    }
  }

  function post(type) {
    try {
      window.postMessage({ source: SOURCE, type: type }, window.location.origin);
    } catch (e) { /* no-op */ }
  }

  // --- Patch fetch -------------------------------------------------------------
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        let url = '';
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
        } catch (e) { /* ignore */ }

        const isTarget = isCompletionUrl(url);
        if (isTarget) post('gen-start');

        const p = origFetch.apply(this, arguments);

        if (!isTarget) return p;

        return p.then((response) => {
          try {
            // Wrap the body stream so we learn when it closes — WITHOUT reading
            // any chunk content. We clone so we never consume Claude's stream.
            if (response && response.body && typeof response.clone === 'function') {
              const probe = response.clone();
              const reader = probe.body.getReader();
              const pump = () => {
                reader.read().then(
                  (res) => {
                    // We only ever look at res.done — never res.value.
                    if (res && res.done) { post('gen-end'); return; }
                    pump();
                  },
                  () => { post('gen-end'); } // aborted/errored => generation ended
                );
              };
              pump();
            } else {
              // Non-streaming response: it's already done.
              post('gen-end');
            }
          } catch (e) {
            post('gen-end');
          }
          return response; // hand Claude its untouched original response
        }, (err) => {
          post('gen-end'); // request rejected => ended
          throw err;
        });
      };
    }
  } catch (e) { /* leave fetch untouched on any failure */ }

  // --- Patch XMLHttpRequest ----------------------------------------------------
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__rsfcTarget = isCompletionUrl(url); } catch (e) { this.__rsfcTarget = false; }
      return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      try {
        if (this.__rsfcTarget) {
          post('gen-start');
          const done = () => post('gen-end');
          // loadend fires for success, error, and abort — covers stop-generating.
          this.addEventListener('loadend', done, { once: true });
        }
      } catch (e) { /* no-op */ }
      return origSend.apply(this, arguments);
    };
  } catch (e) { /* leave XHR untouched on any failure */ }
})();
