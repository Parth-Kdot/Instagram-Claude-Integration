/*
 * instagramReels.js — secondary source. Curated, FINITE, official-embed-only.
 *
 * Plays a user-supplied ORDERED list of specific reel URLs via Instagram's
 * official embed endpoint (https://www.instagram.com/reel/{shortcode}/embed/),
 * rendered inside the extension player page (PlayerFrame) so it isn't subject to
 * claude.ai's CSP. We do NOT scrape Instagram and use NO unofficial endpoints.
 *
 * The list is finite: getNext/getPrevious walk it and clamp at the ends.
 *
 * Implements the VideoSource contract from sourceInterface.js.
 */
(function () {
  'use strict';

  const RSFC = (window.RSFC = window.RSFC || {});

  /** Extract the shortcode from a reel/post URL the user pasted. */
  function parseShortcode(url) {
    try {
      const m = String(url).match(/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
      if (m) return m[1];
      const bare = String(url).trim();
      if (/^[A-Za-z0-9_-]+$/.test(bare)) return bare; // bare shortcode entered
    } catch (e) {}
    return null;
  }

  class InstagramReels extends RSFC.BaseSource {
    constructor() {
      super();
      this.shortcodes = [];
      this.index = 0;
      this.frame = null;
    }

    mount(container, opts) {
      super.mount(container, opts);
      this.shortcodes = (this.config.reelUrls || [])
        .map(parseShortcode)
        .filter(Boolean);
      this.index = 0;

      if (!this.shortcodes.length) {
        const msg = document.createElement('div');
        msg.className = 'rsfc-empty';
        msg.textContent = 'No Instagram reels configured. Add reel URLs in the extension options.';
        container.appendChild(msg);
        return;
      }

      this.frame = new RSFC.PlayerFrame(container);
      this._render();
    }

    _render() {
      const code = this.shortcodes[this.index];
      if (code && this.frame) this.frame.send({ type: 'load-instagram', shortcode: code });
    }

    getNext() {
      if (this.index < this.shortcodes.length - 1) { this.index++; this._render(); }
    }

    getPrevious() {
      if (this.index > 0) { this.index--; this._render(); }
    }

    // Instagram's embed manages its own playback; these are best-effort no-ops.
    play() {}
    pause() {}
    setMuted(muted) { this.muted = !!muted; }

    destroy() {
      if (this.frame) { this.frame.destroy(); this.frame = null; }
      this.shortcodes = [];
      this.index = 0;
      super.destroy();
    }
  }

  RSFC.InstagramReels = InstagramReels;
})();
