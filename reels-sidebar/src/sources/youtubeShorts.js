/*
 * youtubeShorts.js — default video source. Hybrid, best-for-the-user design.
 *
 * A user's *personalized* Shorts feed (their own algorithm) is not available
 * through any official, embeddable YouTube mechanism, and youtube.com refuses to
 * be iframed at the top level. So we approximate "what they want to see" from the
 * user's chosen interest CATEGORIES (+ optional custom terms):
 *
 *   - KEY MODE (optional free Data API v3 key): search.list with
 *       videoEmbeddable=true & videoDuration=short over the active queries, with
 *       pageToken pagination, buffering a rolling, de-duplicated queue of IDs ->
 *       endless, interest-matched.
 *   - NO-KEY MODE: play a configurable public Shorts PLAYLIST ID (reliable).
 *
 * EMBEDDING: the YouTube player iframe is created DIRECTLY in the claude.ai page
 * (origin https://claude.ai). We tried hosting it inside an extension page first,
 * but YouTube rejects embeds whose parent origin is chrome-extension:// with
 * error 153 — claude.ai's own CSP happily allows youtube.com frames, so a direct
 * embed is both simpler and actually works. We drive playback with YouTube's
 * native enablejsapi postMessage protocol straight from the content script.
 *
 * Implements the VideoSource contract from sourceInterface.js.
 */
(function () {
  'use strict';

  const RSFC = (window.RSFC = window.RSFC || {});
  const YT_ORIGIN = 'https://www.youtube.com';

  /** Resolve active categories (preset ids) + custom terms into query strings. */
  function buildQueries(config) {
    const presets = (RSFC.storage && RSFC.storage.PRESET_CATEGORIES) || [];
    const byId = {};
    presets.forEach((c) => { byId[c.id] = c.query; });
    const fromCats = (config.categories || []).map((id) => byId[id]).filter(Boolean);
    const fromTerms = (config.terms || []).filter(Boolean);
    const all = fromCats.concat(fromTerms);
    return all.length ? all : ['shorts']; // never empty
  }

  class YouTubeShorts extends RSFC.BaseSource {
    constructor() {
      super();
      this.iframe = null;
      this.onMsg = null;
      this.playerId = 1;
      this.queue = [];          // buffered video IDs (key mode)
      this.queuePos = -1;
      this.seen = new Set();    // de-dupe across pages / query rotation
      this.queries = [];
      this.queryIdx = 0;
      this.pageToken = '';
      this.usingKey = false;
      this.playlistMode = false;
      this.fetching = false;
      this.advancing = false;   // re-entrancy guard so 'ended'/'error' don't stack
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

      // Create the player iframe directly in the page (origin https://claude.ai).
      this.iframe = document.createElement('iframe');
      this.iframe.className = 'rsfc-video-frame';
      this.iframe.setAttribute('allow',
        'autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; clipboard-write; gyroscope');
      this.iframe.setAttribute('allowfullscreen', 'true');
      container.appendChild(this.iframe);

      this.onMsg = (e) => this._handleYouTube(e);
      window.addEventListener('message', this.onMsg);

      this._showOverlay(this.usingKey ? 'Loading videos…' : 'Loading playlist…');
      RSFC.log('yt.mount usingKey=' + this.usingKey + ' playlists=' + playlistIds.length
        + ' queries=' + JSON.stringify(this.queries));

      if (this.usingKey) {
        this._fillQueue().then(() => {
          RSFC.log('yt initial fill: queue=' + this.queue.length);
          if (this.queue.length) { this.queuePos = 0; this._playCurrent(); }
          else this._showOverlay('No videos returned. Check that your API key is valid, '
            + 'the YouTube Data API v3 is enabled, and your selected categories aren\'t empty.');
        });
      } else {
        this.playlistMode = true;
        this._loadPlaylist(playlistIds[0]);
      }
    }

    // ---- YouTube embed control (native enablejsapi postMessage protocol) ------
    _params() {
      return 'enablejsapi=1&autoplay=1&playsinline=1&rel=0&modestbranding=1&controls=1&fs=1'
        + '&mute=' + (this.muted ? 1 : 0)
        + '&origin=' + encodeURIComponent(location.origin);
    }

    _attachHandshake() {
      if (!this.iframe) return;
      this.iframe.onload = () => {
        try {
          this.iframe.contentWindow.postMessage(
            JSON.stringify({ event: 'listening', id: this.playerId, channel: 'widget' }), YT_ORIGIN);
        } catch (e) {}
      };
    }

    _loadVideo(id) {
      if (!this.iframe) return;
      this._attachHandshake();
      this.iframe.src = YT_ORIGIN + '/embed/' + encodeURIComponent(id) + '?' + this._params();
    }

    _loadPlaylist(listId) {
      if (!this.iframe) return;
      this._attachHandshake();
      this.iframe.src = YT_ORIGIN + '/embed/videoseries?list=' + encodeURIComponent(listId)
        + '&loop=1&' + this._params();
    }

    _command(func) {
      if (!this.iframe || !this.iframe.contentWindow) return;
      try {
        this.iframe.contentWindow.postMessage(
          JSON.stringify({ event: 'command', func: func, args: [], id: this.playerId, channel: 'widget' }),
          YT_ORIGIN);
      } catch (e) {}
    }

    _handleYouTube(e) {
      if (e.origin !== YT_ORIGIN) return;
      if (!this.iframe || e.source !== this.iframe.contentWindow) return;
      let d = e.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { return; } }
      if (!d || !d.event) return;

      if (d.event === 'onReady' || d.event === 'apiInfoDelivery' || d.event === 'initialDelivery') {
        this._hideOverlay();
        this._command('playVideo'); // nudge playback (helps when autoplay is gated)
      } else if (d.event === 'onError') {
        RSFC.log('yt onError info=' + d.info); // 101/150 = embedding disabled; skip it
        this.getNext();
      } else if (d.event === 'infoDelivery' && d.info && typeof d.info.playerState !== 'undefined') {
        this._hideOverlay();
        // 0 = ended. In key mode we advance; in playlist mode the videoseries
        // embed auto-advances itself, so we must not double-advance.
        if (d.info.playerState === 0 && this.usingKey) this.getNext();
      }
    }

    // ---- Data API (key mode) --------------------------------------------------
    _currentQuery() { return this.queries[this.queryIdx % this.queries.length]; }

    /** Fetch a page; resolves to the number of NEW (unseen) IDs added. */
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
          else { this.pageToken = ''; this.queryIdx++; } // rotate to next interest query
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
      if (!this.iframe) return;
      const id = this.queue[this.queuePos];
      RSFC.log('yt play idx=' + this.queuePos + ' id=' + id);
      if (id) this._loadVideo(id);
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
        if (!this.iframe) return;
        this._fillQueue().then((added) => {
          if (added > 0) {
            this.queuePos = this.queue.length - added;
            this._playCurrent();
            this._maybePrefetch();
          }
        });
      }, 5000);
    }

    // ---- VideoSource contract -------------------------------------------------
    getNext() {
      if (!this.iframe) return;
      if (this.playlistMode) { this._command('nextVideo'); return; }
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
      if (!this.iframe) return;
      if (this.playlistMode) { this._command('previousVideo'); return; }
      if (this.queuePos > 0) { this.queuePos--; this._playCurrent(); }
    }

    play() { this._command('playVideo'); }
    pause() { this._command('pauseVideo'); }

    setMuted(muted) {
      this.muted = !!muted;
      this._command(muted ? 'mute' : 'unMute');
    }

    // ---- status overlay -------------------------------------------------------
    _showOverlay(text) {
      if (!this.container) return;
      if (!this._overlay) {
        const o = document.createElement('div');
        o.className = 'rsfc-empty';
        o.style.position = 'absolute';
        o.style.inset = '0';
        o.style.display = 'flex';
        o.style.alignItems = 'center';
        o.style.justifyContent = 'center';
        o.style.background = 'rgba(0,0,0,0.82)';
        o.style.zIndex = '2';
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
      if (this.onMsg) { window.removeEventListener('message', this.onMsg); this.onMsg = null; }
      this._hideOverlay();
      if (this.iframe && this.iframe.parentNode) this.iframe.parentNode.removeChild(this.iframe);
      this.iframe = null;
      this.queue = [];
      this.queuePos = -1;
      this.seen = new Set();
      super.destroy();
    }
  }

  RSFC.YouTubeShorts = YouTubeShorts;
})();
