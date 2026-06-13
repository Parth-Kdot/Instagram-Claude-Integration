/*
 * sidebar.js — the right-edge video panel: injection, push-content layout,
 * slide transitions, and controls.
 *
 * Layout strategy = PUSH CONTENT: when shown, we add a margin to the document
 * equal to the panel width so the panel never overlaps Claude's content or
 * composer. The margin is fully reverted on hide/teardown. If we can't safely
 * find/shift the layout we degrade to a plain overlay rather than break the page.
 *
 * One video is visible at a time, filling the panel vertically. Vertical
 * scroll/swipe and the prev/next buttons advance through the active source.
 * Autoplay the current video; pause when the panel is hidden.
 *
 * The "close" button hides the panel for the CURRENT generation only — index.js
 * resets that flag when the next generation starts.
 */
(function () {
  'use strict';

  const RSFC = (window.RSFC = window.RSFC || {});

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function createSidebar(initialSettings) {
    let settings = initialSettings;
    let root = null;
    let videoHost = null;
    let source = null;
    let visible = false;
    let closedForThisGen = false;
    const callbacks = { onUserClose: null };

    // ---- layout push --------------------------------------------------------
    function applyPush(on) {
      const side = settings.side === 'left' ? 'left' : 'right';
      const px = on ? settings.width + 'px' : '';
      try {
        // Shift the whole document body; works with claude.ai's centered layout
        // and is trivially reversible.
        document.documentElement.style.setProperty(
          'margin-' + side, px, 'important'
        );
        document.documentElement.style.setProperty(
          'transition', settings.animations ? 'margin 0.32s ease' : '', 'important'
        );
      } catch (e) { /* overlay fallback: do nothing, panel just floats */ }
    }

    // ---- build DOM ----------------------------------------------------------
    function build() {
      root = el('div', 'rsfc-sidebar');
      root.id = 'rsfc-sidebar';
      root.setAttribute('data-side', settings.side === 'left' ? 'left' : 'right');
      root.style.width = settings.width + 'px';
      if (!settings.animations) root.classList.add('rsfc-no-anim');

      const header = el('div', 'rsfc-header');
      const title = el('div', 'rsfc-title', 'Reels');
      const btnMute = el('button', 'rsfc-btn rsfc-mute', settings.defaultMute ? '🔇' : '🔊');
      btnMute.title = 'Mute / unmute';
      const btnClose = el('button', 'rsfc-btn rsfc-close', '✕');
      btnClose.title = 'Hide for this response';
      header.appendChild(title);
      header.appendChild(btnMute);
      header.appendChild(btnClose);

      videoHost = el('div', 'rsfc-video-host');

      const nav = el('div', 'rsfc-nav');
      const btnPrev = el('button', 'rsfc-btn rsfc-prev', '▲');
      btnPrev.title = 'Previous';
      const btnNext = el('button', 'rsfc-btn rsfc-next', '▼');
      btnNext.title = 'Next';
      nav.appendChild(btnPrev);
      nav.appendChild(btnNext);

      root.appendChild(header);
      root.appendChild(videoHost);
      root.appendChild(nav);
      document.body.appendChild(root);

      // controls
      let muted = settings.defaultMute;
      btnMute.addEventListener('click', () => {
        muted = !muted;
        btnMute.textContent = muted ? '🔇' : '🔊';
        if (source && source.setMuted) source.setMuted(muted);
      });
      btnClose.addEventListener('click', () => {
        closedForThisGen = true;
        hide();
        if (callbacks.onUserClose) callbacks.onUserClose();
      });
      btnNext.addEventListener('click', () => source && source.getNext());
      btnPrev.addEventListener('click', () => source && source.getPrevious());

      // vertical scroll / swipe to advance
      let wheelLock = false;
      videoHost.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        if (wheelLock) return;
        wheelLock = true;
        setTimeout(() => { wheelLock = false; }, 450);
        if (ev.deltaY > 0) source && source.getNext();
        else source && source.getPrevious();
      }, { passive: false });

      let touchStartY = null;
      videoHost.addEventListener('touchstart', (ev) => {
        touchStartY = ev.touches[0].clientY;
      }, { passive: true });
      videoHost.addEventListener('touchend', (ev) => {
        if (touchStartY == null) return;
        const dy = (ev.changedTouches[0].clientY) - touchStartY;
        if (Math.abs(dy) > 40) {
          if (dy < 0) source && source.getNext();
          else source && source.getPrevious();
        }
        touchStartY = null;
      }, { passive: true });

      // keyboard arrows while hovering the panel
      root.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowDown') { source && source.getNext(); }
        else if (ev.key === 'ArrowUp') { source && source.getPrevious(); }
      });
      root.tabIndex = -1;
    }

    // ---- source instantiation ----------------------------------------------
    function makeSource() {
      const which = settings.activeSource;
      if (which === 'instagram' && RSFC.InstagramReels) {
        return { inst: new RSFC.InstagramReels(), config: settings.instagram };
      }
      // default youtube
      return { inst: new RSFC.YouTubeShorts(), config: settings.youtube };
    }

    function mountSource() {
      if (!videoHost) { RSFC.log('mountSource: no videoHost'); return; }
      // Defensive: never mount on top of an existing source.
      if (source) { try { source.destroy(); } catch (e) {} source = null; }
      videoHost.innerHTML = '';
      try {
        const made = makeSource();
        source = made.inst;
        RSFC.log('mountSource: source=' + (settings.activeSource) + ' usingKeyConfig=' + !!(settings.youtube && settings.youtube.apiKey));
        source.mount(videoHost, { muted: settings.defaultMute, config: made.config });
        addTapLayer();
        RSFC.log('mountSource: mounted, hostChildren=' + videoHost.children.length);
      } catch (e) {
        RSFC.log('mountSource ERROR: ' + (e && e.message));
        showStatus('Reels error: ' + (e && e.message ? e.message : 'failed to start video source'));
      }
    }

    /**
     * Transparent layer over the player. It (a) sits above the YouTube iframe so
     * the player's title/channel/controls don't appear on hover, giving a clean
     * full-bleed video, and (b) captures tap (play/pause) while letting wheel /
     * swipe bubble to the video host's scroll handlers (next/previous).
     */
    function addTapLayer() {
      if (!videoHost) return;
      const layer = el('div', 'rsfc-tap-layer');
      layer.addEventListener('click', () => {
        if (source && source.togglePlay) source.togglePlay();
      });
      videoHost.appendChild(layer); // appended last → on top of the player
    }

    /** Visible fallback text in the video area (so failures are never silent). */
    function showStatus(text) {
      if (!videoHost) return;
      let s = videoHost.querySelector('.rsfc-empty');
      if (!s) {
        s = el('div', 'rsfc-empty');
        videoHost.appendChild(s);
      }
      s.textContent = text;
    }

    // ---- public API ---------------------------------------------------------
    function show() {
      if (closedForThisGen) { RSFC.log('show: skipped (closedForThisGen)'); return; }
      // Defensive: if a stale panel from a prior pipeline lingers in the DOM,
      // remove it so we never end up with two sidebars (one empty/black).
      document.querySelectorAll('#rsfc-sidebar').forEach((n) => {
        if (n !== root && n.parentNode) n.parentNode.removeChild(n);
      });
      RSFC.log('show: enter (root=' + !!root + ' source=' + !!source + ')');
      if (!root) build();
      if (!source) mountSource();
      visible = true;
      applyPush(true);
      requestAnimationFrame(() => root && root.classList.add('rsfc-open'));
      if (source && source.play) source.play();
    }

    function hide() {
      visible = false;
      if (root) root.classList.remove('rsfc-open');
      applyPush(false);
      // Destroy the source SYNCHRONOUSLY. Deferring it caused a race: a new
      // generation starting during the slide-out would mount a fresh source into
      // the (reused) video host, and the old source's delayed teardown then
      // wiped that new iframe — leaving a permanently black panel.
      RSFC.log('hide: tearing down source');
      try { source && source.destroy(); } catch (e) {}
      source = null;
    }

    function destroy() {
      try { source && source.destroy(); } catch (e) {}
      source = null;
      applyPush(false);
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null;
      videoHost = null;
      visible = false;
    }

    return {
      show,
      hide,
      destroy,
      isVisible: () => visible,
      /** Called by index.js when a new generation begins. */
      resetClosedFlag() { closedForThisGen = false; },
      onUserClose(fn) { callbacks.onUserClose = fn; },
      updateSettings(next) { settings = next; }
    };
  }

  RSFC.createSidebar = createSidebar;
})();
