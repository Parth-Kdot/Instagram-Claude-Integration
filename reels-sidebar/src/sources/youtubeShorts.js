/*
 * youtubeShorts.js — default video source. Hybrid, best-for-the-user design.
 *
 *   - KEY MODE (optional free Data API v3 key): search.list with
 *       videoEmbeddable=true & videoDuration=short over the active queries
 *       (built from the user's chosen interest categories + custom terms), with
 *       pageToken pagination and a rolling, de-duplicated queue of IDs.
 *   - NO-KEY MODE: play a configurable public Shorts PLAYLIST ID.
 *
 * PLAYBACK: handled by the official YouTube IFrame Player API, driven from the
 * MAIN world by src/page/ytController.js (the content script lives in an
 * isolated world and cannot touch window.YT). The player is mounted DIRECTLY in
 * the claude.ai page — embedding from a chrome-extension:// origin made YouTube
 * reject every video with error 153, while claude.ai's CSP happily allows
 * youtube.com frames AND the IFrame API script. We bridge to the controller
 * with window.postMessage. This is what reliably starts muted autoplay.
 *
 * Implements the VideoSource contract from sourceInterface.js.
 */
(function () {
  'use strict';

  const RSFC = (window.RSFC = window.RSFC || {});

  function buildQueries(config) {
    const presets = (RSFC.storage && RSFC.storage.PRESET_CATEGORIES) || [];
    const byId = {};
    presets.forEach((c) => { byId[c.id] = c.query; });
    const fromCats = (config.categories || []).map((id) => byId[id]).filter(Boolean);
    const fromTerms = (config.terms || []).filter(Boolean);
    const all = fromCats.concat(fromTerms);
    return all.length ? all : ['shorts'];
  }

  class YouTubeShorts extends RSFC.BaseSource {
    constructor() {
      super();
      this.mountId = 'rsfc-yt-mount-' + (RSFC._ytSeq = (RSFC._ytSeq || 0) + 1);
      this.mountEl = null;
      this.onEvt = null;
      this.queue = [];
      this.queuePos = -1;
      this.seen = new Set();
      this.queries = [];
      this.queryIdx = 0;
      this.pageToken = '';
      this.usingKey = false;
      this.playlistMode = false;
      this.fetching = false;
      this.advancing = false;
      this._overlay = null;
      this._retryScheduled = false;
    }

    mount(container, opts) {
      super.mount(container, opts);
      this.queries = buildQueries(this.config);
      this.usingKey = !!(this.config.apiKey && this.config.apiKey.trim());
      const playlistIds = (this.config.playlistIds || []).filter(Boolean);

      if (!this.usingKey && !playlistIds.length) {
        this._showOverlay('Add a YouTube Data API key (recommended) or a public Shorts '
          + 'playlist ID in the extension options to start the feed.');
        return;
      }

      // The element the IFrame API will replace with the player iframe.
      this.mountEl = document.createElement('div');
      this.mountEl.id = this.mountId;
      this.mountEl.className = 'rsfc-video-frame';
      container.appendChild(this.mountEl);

      this.onEvt = (e) => this._handleEvt(e);
      window.addEventListener('message', this.onEvt);

      this._showOverlay(this.usingKey ? 'Loading videos…' : 'Loading playlist…');
      RSFC.log('yt.mount usingKey=' + this.usingKey + ' playlists=' + playlistIds.length
        + ' queries=' + JSON.stringify(this.queries));

      if (this.usingKey) {
        this._fillQueue().then(() => {
          RSFC.log('yt initial fill: queue=' + this.queue.length);
          if (this.queue.length) {
            this.queuePos = 0;
            this._send({ type: 'init', mountId: this.mountId, videoId: this.queue[0], muted: this.muted });
          } else {
            this._showOverlay('No videos returned. Check that your API key is valid, the YouTube '
              + 'Data API v3 is enabled, and your selected categories aren\'t empty.');
          }
        });
      } else {
        this.playlistMode = true;
        this._send({ type: 'init', mountId: this.mountId, playlistId: playlistIds[0], muted: this.muted });
      }
    }

    // ---- bridge to the MAIN-world YouTube controller --------------------------
    _send(msg) {
      msg.source = 'rsfc-yt-cmd';
      try { window.postMessage(msg, location.origin); } catch (e) {}
    }

    _handleEvt(e) {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.source !== 'rsfc-yt-evt') return;
      if (d.type === 'ready' || d.type === 'playing') {
        this._hideOverlay();
      } else if (d.type === 'error') {
        RSFC.log('yt error code=' + d.code); // 101/150 = embedding disabled; skip it
        this.getNext();
      } else if (d.type === 'ended') {
        if (this.usingKey) this.getNext();
      }
    }

    // ---- Data API (key mode) --------------------------------------------------
    _currentQuery() { return this.queries[this.queryIdx % this.queries.length]; }

    _fillQueue() {
      if (this.fetching) return Promise.resolve(0);
      this.fetching = true;
      const key = this.config.apiKey.trim();
      const q = this._currentQuery();
      const url = 'https://www.googleapis.com/youtube/v3/search'
        + '?part=snippet&type=video&videoEmbeddable=true&videoDuration=short'
        + '&maxResults=25&safeSearch=moderate&q=' + encodeURIComponent(q)
        + (this.pageToken ? '&pageToken=' + encodeURIComponent(this.pageToken) : '')
        + '&key=' + encodeURIComponent(key);

      RSFC.log('yt fetch: q="' + q + '" page=' + (this.pageToken || 'first'));
      return fetch(url)
        .then((r) => r.json())
        .then((data) => {
          this.fetching = false;
          if (data && data.error) {
            RSFC.log('yt API error: ' + data.error.code + ' ' + (data.error.message || '').slice(0, 120));
            throw new Error('yt-api');
          }
          const fresh = (data.items || [])
            .map((it) => it.id && it.id.videoId)
            .filter(Boolean)
            .filter((id) => !this.seen.has(id));
          fresh.forEach((id) => this.seen.add(id));
          this.queue = this.queue.concat(fresh);
          if (data.nextPageToken) this.pageToken = data.nextPageToken;
          else { this.pageToken = ''; this.queryIdx++; }
          return fresh.length;
        })
        .catch((err) => {
          this.fetching = false;
          RSFC.log('yt fetch FAILED: ' + (err && err.message));
          if (!this.queue.length) {
            this._showOverlay('YouTube API error. Check that your key is valid, the YouTube '
              + 'Data API v3 is enabled, and (if you restricted the key) that it permits that API.');
          }
          return 0;
        });
    }

    _playCurrent() {
      const id = this.queue[this.queuePos];
      RSFC.log('yt play idx=' + this.queuePos + ' id=' + id);
      if (id) this._send({ type: 'load', videoId: id, muted: this.muted });
    }

    _maybePrefetch() {
      if (!this.usingKey || this.fetching) return;
      if (this.queue.length - this.queuePos <= 3) this._fillQueue();
    }

    _endOfFeed() {
      this.queuePos = Math.max(0, this.queue.length - 1);
      this._showOverlay('Reached the end of the current feed. Scroll up for previous videos — '
        + 'new ones load automatically when available (check your API quota if this persists).');
      if (this._retryScheduled) return;
      this._retryScheduled = true;
      setTimeout(() => {
        this._retryScheduled = false;
        if (!this.mountEl) return;
        this._fillQueue().then((added) => {
          if (added > 0) { this.queuePos = this.queue.length - added; this._playCurrent(); this._maybePrefetch(); }
        });
      }, 5000);
    }

    // ---- VideoSource contract -------------------------------------------------
    getNext() {
      if (!this.mountEl) return;
      if (this.playlistMode) { this._send({ type: 'cmd', func: 'nextVideo' }); return; }
      if (this.advancing) return;
      this.advancing = true;
      this.queuePos++;
      if (this.queuePos < this.queue.length) {
        this.advancing = false;
        this._playCurrent();
        this._maybePrefetch();
      } else {
        this._fillQueue().then(() => {
          this.advancing = false;
          if (this.queuePos < this.queue.length) { this._playCurrent(); this._maybePrefetch(); }
          else this._endOfFeed();
        });
      }
    }

    getPrevious() {
      if (!this.mountEl) return;
      if (this.playlistMode) { this._send({ type: 'cmd', func: 'previousVideo' }); return; }
      if (this.queuePos > 0) { this.queuePos--; this._playCurrent(); }
    }

    play() { this._send({ type: 'cmd', func: 'playVideo' }); }
    pause() { this._send({ type: 'cmd', func: 'pauseVideo' }); }

    setMuted(muted) {
      this.muted = !!muted;
      this._send({ type: 'cmd', func: muted ? 'mute' : 'unMute' });
    }

    // ---- status overlay -------------------------------------------------------
    _showOverlay(text) {
      if (!this.container) return;
      if (!this._overlay) {
        const o = document.createElement('div');
        o.className = 'rsfc-empty';
        o.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;'
          + 'justify-content:center;background:rgba(0,0,0,0.82);z-index:2';
        this._overlay = o;
        this.container.appendChild(o);
      }
      this._overlay.textContent = text;
    }

    _hideOverlay() {
      if (this._overlay && this._overlay.parentNode) this._overlay.parentNode.removeChild(this._overlay);
      this._overlay = null;
    }

    destroy() {
      this._send({ type: 'destroy' });
      if (this.onEvt) { window.removeEventListener('message', this.onEvt); this.onEvt = null; }
      this._hideOverlay();
      // The player iframe replaced mountEl; remove whatever is left.
      const left = document.getElementById(this.mountId);
      if (left && left.parentNode) left.parentNode.removeChild(left);
      this.mountEl = null;
      this.queue = [];
      this.queuePos = -1;
      this.seen = new Set();
      super.destroy();
    }
  }

  RSFC.YouTubeShorts = YouTubeShorts;
})();
