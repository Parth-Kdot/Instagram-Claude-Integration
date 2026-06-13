/*
 * sourceInterface.js — the common contract every video source implements.
 *
 * The sidebar talks to a source through exactly this surface, so sources are
 * pluggable: drop in a new one and the sidebar doesn't change.
 *
 * @typedef {Object} VideoSource
 * @property {(container: HTMLElement, opts: SourceOpts) => void} mount
 *           Build DOM inside `container` and show the first video.
 * @property {() => (void|Promise<void>)} getNext
 *           Advance to the next video (load + display it). Endless or clamped.
 * @property {() => (void|Promise<void>)} getPrevious
 *           Go back to the previous video. Clamp at the start if finite.
 * @property {() => void} play     Play the current video.
 * @property {() => void} pause    Pause the current video.
 * @property {(muted: boolean) => void} [setMuted]  Apply mute state.
 * @property {() => void} destroy  Tear down players, listeners, and DOM.
 *
 * @typedef {Object} SourceOpts
 * @property {boolean} muted   Initial mute state.
 * @property {Object}  config  Source-specific settings (from storage).
 *
 * A small base is provided with shared helpers; sources may use or ignore it.
 */
(function () {
  'use strict';

  const RSFC = (window.RSFC = window.RSFC || {});

  class BaseSource {
    constructor() {
      this.container = null;
      this.muted = true;
      this.config = {};
    }
    mount(container, opts) {
      this.container = container;
      this.muted = !!(opts && opts.muted);
      this.config = (opts && opts.config) || {};
    }
    getNext() {}
    getPrevious() {}
    play() {}
    pause() {}
    setMuted(muted) { this.muted = !!muted; }
    destroy() {
      if (this.container) this.container.innerHTML = '';
      this.container = null;
    }
  }

  RSFC.BaseSource = BaseSource;

  /**
   * PlayerFrame — wraps the extension-origin player iframe and the postMessage
   * channel to it. Sources use this instead of touching YouTube/Instagram
   * directly, which keeps all CSP-sensitive embedding inside the extension page.
   *
   * Messages are queued until the player page reports 'page-ready', then
   * flushed in order, so a source can call send() immediately after construction.
   */
  class PlayerFrame {
    constructor(container) {
      this.ready = false;
      this.queue = [];
      this.cbs = [];

      this.iframe = document.createElement('iframe');
      this.iframe.className = 'rsfc-video-frame';
      this.iframe.setAttribute(
        'allow',
        'autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; clipboard-write; gyroscope'
      );
      this.iframe.setAttribute('allowfullscreen', 'true');
      this.iframe.src = chrome.runtime.getURL('src/player/player.html');
      container.appendChild(this.iframe);

      this._onMsg = (e) => {
        if (!this.iframe || e.source !== this.iframe.contentWindow) return;
        const d = e.data;
        if (!d || d.source !== 'rsfc-player') return;
        if (d.type === 'page-ready') { this.ready = true; this._flush(); }
        this.cbs.forEach((cb) => { try { cb(d); } catch (_) {} });
      };
      window.addEventListener('message', this._onMsg);
    }

    send(msg) {
      msg.source = 'rsfc-ctrl';
      if (this.ready) this._post(msg);
      else this.queue.push(msg);
    }

    _flush() {
      const q = this.queue.slice();
      this.queue.length = 0;
      q.forEach((m) => this._post(m));
    }

    _post(msg) {
      try { this.iframe.contentWindow.postMessage(msg, '*'); } catch (e) {}
    }

    on(cb) { this.cbs.push(cb); return this; }

    destroy() {
      try { window.removeEventListener('message', this._onMsg); } catch (e) {}
      if (this.iframe && this.iframe.parentNode) this.iframe.parentNode.removeChild(this.iframe);
      this.iframe = null;
      this.cbs = [];
      this.queue = [];
    }
  }

  RSFC.PlayerFrame = PlayerFrame;
})();
