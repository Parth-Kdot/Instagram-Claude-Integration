/*
 * youtubeShorts.js — default video source. Hybrid, best-for-the-user design.
 *
 * A user's *personalized* Shorts feed (their own algorithm) is not available
 * through any official, embeddable YouTube mechanism, and youtube.com refuses to
 * be iframed. So we approximate "what they want to see" from the user's chosen
 * interest CATEGORIES (+ optional custom terms), as close to endless as the
 * official tools allow:
 *
 *   - KEY MODE (optional free Data API v3 key): search.list with
 *       videoEmbeddable=true & videoDuration=short over the active queries, with
 *       pageToken pagination, buffering a rolling, de-duplicated queue of video
 *       IDs -> endless, interest-matched. We fetch from the CONTENT SCRIPT
 *       (CORS-enabled API), then hand IDs to the extension player page to play.
 *   - NO-KEY MODE: play a configurable public Shorts PLAYLIST ID (reliable).
 *       The YouTube videoseries embed auto-advances itself; we do NOT also drive
 *       advancement on 'ended' (that double-advances and skips videos).
 *
 * All embedding/playback happens inside the extension player page via
 * PlayerFrame (see sourceInterface.js) — this sidesteps claude.ai's CSP and the
 * isolated-world limitation that made the old IFrame-API approach show a black
 * screen.
 *
 * Implements the VideoSource contract from sourceInterface.js.
 */
(function () {
  'use strict';

  const RSFC = (window.RSFC = window.RSFC || {});

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
      this.frame = null;
      this.queue = [];          // buffered video IDs (key mode)
      this.queuePos = -1;
      this.seen = new Set();    // de-dupe across pages/query rotation
      this.queries = [];
      this.queryIdx = 0;
      this.pageToken = '';
      this.usingKey = false;
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

      // Nothing to play with -> show guidance instead of a black frame.
      if (!this.usingKey && !playlistIds.length) {
        this._message(container,
          'Add a YouTube Data API key (recommended) or a public Shorts playlist ID in the extension options to start the feed.');
        return;
      }

      RSFC.log('yt.mount usingKey=' + this.usingKey + ' playlists=' + playlistIds.length + ' queries=' + JSON.stringify(this.queries));
      this.frame = new RSFC.PlayerFrame(container);
      this._showOverlay(this.usingKey ? 'Loading videos…' : 'Loading playlist…');
      this.frame.on((d) => {
        RSFC.log('yt player msg: ' + d.type);
        // Auto-advance rules:
        //  - 'error' (dead/blocked video): skip in either mode.
        //  - 'ended': only key mode advances; in no-key mode the looping
        //    videoseries embed advances itself, so reacting here would
        //    double-advance and skip every other clip.
        if (d.type === 'error') { this.getNext(); return; }
        if (d.type === 'ended' && this.usingKey) this.getNext();
      });

      if (this.usingKey) {
        this._fillQueue().then(() => {
          RSFC.log('yt initial fill: queue=' + this.queue.length);
          if (this.queue.length) { this.queuePos = 0; this._playCurrent(); }
          else this._showOverlay('No videos returned. Check your API key, that YouTube Data API v3 is enabled, and your selected categories.');
        });
      } else {
        // No-key: play a public playlist (loops for near-endless scroll).
        this.frame.send({ type: 'load-playlist', playlistId: playlistIds[0], muted: this.muted });
      }
    }

    _message(container, text) {
      const el = document.createElement('div');
      el.className = 'rsfc-empty';
      el.textContent = text;
      container.appendChild(el);
    }

    /** Overlay shown on top of the player (e.g. transient end-of-feed states). */
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
      if (this._overlay && this._overlay.parentNode) {
        this._overlay.parentNode.removeChild(this._overlay);
      }
      this._overlay = null;
    }

    _currentQuery() { return this.queries[this.queryIdx % this.queries.length]; }

    /**
     * Fetch one more page of video IDs. Resolves to the number of NEW (unseen)
     * IDs added, so callers can tell whether the feed actually grew. Never
     * rejects — errors resolve to 0 (and surface a message if nothing has played
     * yet).
     */
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
            RSFC.log('yt fetch API error: ' + (data.error.code) + ' ' + (data.error.message || '').slice(0, 120));
            throw new Error('yt-api');
          }
          const fresh = (data.items || [])
            .map((it) => it.id && it.id.videoId)
            .filter(Boolean)
            .filter((id) => !this.seen.has(id));
          fresh.forEach((id) => this.seen.add(id));
          this.queue = this.queue.concat(fresh);
          if (data.nextPageToken) {
            this.pageToken = data.nextPageToken;
          } else {
            // Exhausted this query's pages -> rotate to the next interest query.
            this.pageToken = '';
            this.queryIdx++;
          }
          return fresh.length;
        })
        .catch((err) => {
          this.fetching = false;
          RSFC.log('yt fetch FAILED: ' + (err && err.message));
          // Only hard-fail to a message if we never managed to play anything.
          if (!this.queue.length) {
            this._showOverlay(
              'YouTube API error. Check that your key is valid, the YouTube Data API v3 is enabled, '
              + 'and (if you restricted the key) that it permits the YouTube Data API. '
              + 'A public Shorts playlist ID works as a no-key fallback.');
          }
          return 0;
        });
    }

    _playCurrent() {
      if (!this.frame) return;
      const id = this.queue[this.queuePos];
      RSFC.log('yt play idx=' + this.queuePos + ' id=' + id);
      if (id) {
        this._hideOverlay();
        this.frame.send({ type: 'load-youtube', videoId: id, muted: this.muted });
      }
    }

    /** Top up the buffer in the background as we near the end of the queue. */
    _maybePrefetch() {
      if (!this.usingKey || this.fetching) return;
      if (this.queue.length - this.queuePos <= 3) this._fillQueue();
    }

    /**
     * Reached the end of buffered content and couldn't fetch more right now
     * (quota/error/transient). Crucially we do NOT replay the just-ended video
     * (that caused an infinite loop); we hold on the last item, let the user
     * scroll up, and try ONE delayed refill to self-heal.
     */
    _endOfFeed() {
      this.queuePos = Math.max(0, this.queue.length - 1);
      this._showOverlay('Reached the end of the current feed. Scroll up for previous videos — '
        + 'new ones load automatically when available (check your API quota if this persists).');
      if (this._retryScheduled) return;
      this._retryScheduled = true;
      setTimeout(() => {
        this._retryScheduled = false;
        if (!this.frame) return;
        this._fillQueue().then((added) => {
          if (added > 0) {
            this.queuePos = this.queue.length - added; // first newly added item
            this._playCurrent();
            this._maybePrefetch();
          }
        });
      }, 5000);
    }

    getNext() {
      if (!this.frame) return;

      if (!this.usingKey) {
        // Playlist mode: user-initiated skip within the looping videoseries.
        this.frame.send({ type: 'cmd', func: 'nextVideo' });
        return;
      }

      if (this.advancing) return; // ignore stacked advance requests mid-fetch
      this.advancing = true;
      this.queuePos++;

      if (this.queuePos < this.queue.length) {
        this.advancing = false;
        this._playCurrent();
        this._maybePrefetch();
      } else {
        // Need more before we can show the next one.
        this._fillQueue().then(() => {
          this.advancing = false;
          if (this.queuePos < this.queue.length) {
            this._playCurrent();
            this._maybePrefetch();
          } else {
            this._endOfFeed();
          }
        });
      }
    }

    getPrevious() {
      if (!this.frame) return;
      if (this.usingKey) {
        if (this.queuePos > 0) { this.queuePos--; this._playCurrent(); }
      } else {
        this.frame.send({ type: 'cmd', func: 'previousVideo' });
      }
    }

    play() { this.frame && this.frame.send({ type: 'cmd', func: 'playVideo' }); }
    pause() { this.frame && this.frame.send({ type: 'cmd', func: 'pauseVideo' }); }

    setMuted(muted) {
      this.muted = !!muted;
      this.frame && this.frame.send({ type: 'cmd', func: muted ? 'mute' : 'unMute' });
    }

    destroy() {
      this._hideOverlay();
      if (this.frame) { this.frame.destroy(); this.frame = null; }
      this.queue = [];
      this.queuePos = -1;
      this.seen = new Set();
      super.destroy();
    }
  }

  RSFC.YouTubeShorts = YouTubeShorts;
})();
