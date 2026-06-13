/*
 * lifecycle.js — the single state machine that owns whether the sidebar is up.
 *
 * States: 'idle' -> 'generating' -> 'complete' -> 'idle'
 *
 *   idle        no generation in flight; sidebar hidden.
 *   generating  a response is streaming; sidebar shown.
 *   complete    transient: generation ended; we emit 'hide' then settle to idle.
 *
 * The detector feeds raw start/end signals in here. This module is the ONLY
 * place that decides show/hide, so the edge-case rules live in one spot:
 *
 *   - A second start() while already generating is a no-op (follow-up prompts
 *     and regenerate-mid-stream keep the feed running without resetting it).
 *   - end() while idle is ignored (duplicate/late signals are harmless).
 *   - A minimum-visible timer prevents flicker on very fast responses: if the
 *     response finishes before `minVisibleMs` has elapsed since show, the hide
 *     is deferred until the timer expires.
 *
 * It is intentionally framework-free and emits two events: 'show' and 'hide'.
 */
(function () {
  'use strict';

  const RSFC = (window.RSFC = window.RSFC || {});

  function createLifecycle(options) {
    const opts = options || {};
    let minVisibleMs = typeof opts.minVisibleMs === 'number' ? opts.minVisibleMs : 1500;

    let state = 'idle';
    let shownAt = 0;            // timestamp when 'show' was last emitted
    let pendingHideTimer = null;
    const listeners = { show: [], hide: [] };

    function emit(evt) {
      (listeners[evt] || []).forEach((fn) => {
        try { fn(); } catch (e) { /* never let a listener break the machine */ }
      });
    }

    function clearPendingHide() {
      if (pendingHideTimer) {
        clearTimeout(pendingHideTimer);
        pendingHideTimer = null;
      }
    }

    function doHide() {
      clearPendingHide();
      state = 'idle';
      emit('hide');
    }

    const api = {
      /** Signal: a generation has started. */
      start() {
        if (state === 'generating') return; // already running -> no reset
        // If a deferred hide from a previous generation is still pending, cancel
        // it; the new generation supersedes it and we keep the panel up.
        clearPendingHide();
        state = 'generating';
        shownAt = Date.now();
        emit('show');
      },

      /** Signal: the in-flight generation has ended (finished, stopped, or errored). */
      end() {
        if (state !== 'generating') return; // nothing to end
        state = 'complete';
        const elapsed = Date.now() - shownAt;
        const remaining = minVisibleMs - elapsed;
        if (remaining > 0) {
          // Anti-flicker: keep it visible until the minimum has elapsed.
          clearPendingHide();
          pendingHideTimer = setTimeout(doHide, remaining);
        } else {
          doHide();
        }
      },

      /** Force everything down (used on teardown / disable / navigation). */
      reset() {
        clearPendingHide();
        const wasUp = state !== 'idle';
        state = 'idle';
        if (wasUp) emit('hide');
      },

      getState() { return state; },

      setMinVisibleMs(ms) {
        if (typeof ms === 'number' && ms >= 0) minVisibleMs = ms;
      },

      on(evt, fn) {
        if (listeners[evt]) listeners[evt].push(fn);
        return api;
      }
    };

    return api;
  }

  RSFC.createLifecycle = createLifecycle;
})();
