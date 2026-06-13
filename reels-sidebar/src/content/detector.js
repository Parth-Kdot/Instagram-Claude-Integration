/*
 * detector.js — reconciles TWO generation signals into clean start/end events.
 *
 * ============================ THE TWO STRATEGIES ============================
 *
 * 1) NETWORK (authoritative) — see src/page/fetchHook.js.
 *    A MAIN-world script patches fetch + XHR and posts a message when the
 *    assistant-streaming request opens ('gen-start') and when its body stream
 *    closes ('gen-end'). This is authoritative because it tracks the actual
 *    request that produces the response — it cannot be fooled by unrelated DOM
 *    churn, and it catches the "stop generating" case (the stream is aborted).
 *    We listen for those window.postMessage events here.
 *
 * 2) DOM (safety net) — a MutationObserver on the conversation container.
 *    If claude.ai changes its endpoints and the network hook stops matching,
 *    this keeps the feature alive. It infers:
 *      - GENERATING: the "stop generating" control is present in the DOM.
 *      - COMPLETE:   that control has disappeared AND the latest assistant
 *                    message subtree has stopped mutating for 800ms (quiescence
 *                    debounce — streaming text mutates rapidly, so a pause means
 *                    the response is done).
 *
 * ============================== RECONCILIATION ==============================
 *
 *   - Network is authoritative; DOM is the safety net.
 *   - The lifecycle de-dupes (start while generating is a no-op, end while idle
 *     is ignored), so both sources can fire freely and idempotently.
 *   - DOM only *promotes* to generating if the network hasn't already.
 *   - DOM 'complete' fires end() normally; if the network opened a stream but
 *     never reported an end, a watchdog lets the DOM's complete still close it.
 *   - If the network reports start but, due to a future change, never reports a
 *     matching end, the DOM quiescence path becomes the effective end signal.
 *
 * ===================== claude.ai COUPLING LIVES HERE =======================
 * All selectors / URL knowledge for the DOM side are constants at the top. A
 * future claude.ai DOM change should be fixable by editing ONLY this file (and,
 * for the network URL, the matching copy in fetchHook.js).
 *
 * PRIVACY: we read element presence and mutation *timing* only — never the text
 * content of any message.
 */
(function () {
  'use strict';

  const RSFC = (window.RSFC = window.RSFC || {});

  // --- claude.ai DOM selectors (the single place to update on DOM changes) ----
  // Multiple fallbacks per concept; first match wins.
  const SELECTORS = {
    // The "stop generating" / "stop response" button shown while streaming.
    stopButton: [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="stop response" i]',
      'button[data-testid*="stop" i]',
      '[data-state="streaming"]'
    ],
    // The scrolling container that holds the conversation messages.
    conversation: [
      'main',
      '[data-testid="conversation"]',
      'div[class*="conversation"]'
    ],
    // The latest assistant message subtree (for quiescence detection).
    assistantMessage: [
      '[data-testid="assistant-message"]',
      'div[data-is-streaming]',
      'div[class*="font-claude-message"]'
    ]
  };

  const NET_SOURCE = 'rsfc-net';
  const QUIESCENCE_MS = 800;   // assistant text idle this long => complete
  const NET_WATCHDOG_MS = 600; // grace before DOM-complete may override a net start

  function firstMatch(selectorList, root) {
    const scope = root || document;
    for (const sel of selectorList) {
      try {
        const el = scope.querySelector(sel);
        if (el) return el;
      } catch (e) { /* bad selector, skip */ }
    }
    return null;
  }

  function stopButtonPresent() {
    return !!firstMatch(SELECTORS.stopButton);
  }

  /**
   * createDetector wires both signals to a lifecycle's start()/end().
   * Returns { start, stop } to attach/detach all listeners (used on teardown
   * and SPA navigation).
   */
  function createDetector(lifecycle) {
    let observer = null;
    let quiescenceTimer = null;
    let netActive = false;       // network currently believes we're generating
    let lastNetStartAt = 0;
    let messageListener = null;
    let attached = false;

    // ---- Network signal -----------------------------------------------------
    function onNetMessage(event) {
      // Only trust same-window messages from our MAIN-world hook.
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== NET_SOURCE) return;

      if (data.type === 'gen-start') {
        netActive = true;
        lastNetStartAt = Date.now();
        lifecycle.start();
      } else if (data.type === 'gen-end') {
        netActive = false;
        lifecycle.end();
      }
    }

    // ---- DOM signal ---------------------------------------------------------
    function scheduleQuiescenceCheck() {
      if (quiescenceTimer) clearTimeout(quiescenceTimer);
      quiescenceTimer = setTimeout(() => {
        // Considered complete only if the stop button is gone. If the network
        // is still streaming, lifecycle.end() is effectively a no-op until the
        // network also ends — but if the network never ends (endpoint change),
        // this becomes the real end signal after the watchdog grace period.
        if (!stopButtonPresent()) {
          const sinceNetStart = Date.now() - lastNetStartAt;
          if (!netActive || sinceNetStart > NET_WATCHDOG_MS) {
            lifecycle.end();
          }
        }
      }, QUIESCENCE_MS);
    }

    function onMutation() {
      // Presence of the stop button is a strong "generating" cue.
      if (stopButtonPresent()) {
        // Promote to generating only if the network hasn't already.
        if (!netActive) lifecycle.start();
        // Keep pushing the quiescence check out while text streams.
        scheduleQuiescenceCheck();
      } else {
        // Stop button gone -> verify the assistant message has settled.
        scheduleQuiescenceCheck();
      }
    }

    function attachObserver() {
      const target = firstMatch(SELECTORS.conversation) || document.body;
      if (!target) return;
      observer = new MutationObserver(onMutation);
      try {
        observer.observe(target, { childList: true, subtree: true, characterData: true });
      } catch (e) { observer = null; }
    }

    return {
      start() {
        if (attached) return;
        attached = true;
        messageListener = onNetMessage;
        window.addEventListener('message', messageListener);
        attachObserver();
      },
      stop() {
        attached = false;
        if (messageListener) {
          window.removeEventListener('message', messageListener);
          messageListener = null;
        }
        if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
        if (quiescenceTimer) { clearTimeout(quiescenceTimer); quiescenceTimer = null; }
        netActive = false;
      },
      /** Re-point the observer after an SPA navigation swaps the container. */
      reattachObserver() {
        if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
        attachObserver();
      }
    };
  }

  RSFC.createDetector = createDetector;
})();
