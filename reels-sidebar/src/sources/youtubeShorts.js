/*
 * youtubeShorts.js — default video source. Hybrid, best-for-the-user design.
 *
 *   - KEY MODE (free Data API v3 key): a DIVERSE, interest-matched feed. We keep
 *       one queue ("bucket") per selected category and round-robin across them,
 *       so consecutive videos rotate through your interests instead of dumping a
 *       whole category at once. Within each batch we SHUFFLE results and CAP how
 *       many videos any single channel may contribute, so one creator can't
 *       dominate the feed. Pagination per bucket keeps it effectively endless.
 *   - NO-KEY MODE: play a configurable public Shorts PLAYLIST ID.
 *
 * PLAYBACK: official YouTube IFrame Player API, run from the MAIN world by
 * src/page/ytController.js (the content script can't touch window.YT) and
 * embedded directly in the claude.ai page (a chrome-extension:// origin makes
 * YouTube throw error 153). We bridge with window.postMessage.
 *
 * Implements the VideoSource contract from sourceInterface.js.
 */
(function () {
  'use strict';

  const RSFC = (window.RSFC = window.RSFC || {});
  const CHANNEL_CAP = 2;     // max videos per channel held in the feed at once
  const HISTORY_MAX = 200;

  function buildQueries(config) {
    const presets = (RSFC.storage && RSFC.storage.PRESET_CATEGORIES) || [];
    const byId = {};
    presets.forEach((c) => { byId[c.id] = c.query; });
    const fromCats = (config.categories || []).map((id) => byId[id]).filter(Boolean);
    const fromTerms = (config.terms || []).filter(Boolean);
    const all = fromCats.concat(fromTerms);
    return all.length ? all : ['shorts'];
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  class YouTubeShorts extends RSFC.BaseSource {
    constructor() {
      super();
      this.mountId = 'rsfc-yt-mount-' + (RSFC._ytSeq = (RSFC._ytSeq || 0) + 1);
      this.mountEl = null;
      this.onEvt = null;
      this.usingKey = false;
      this.playlistMode = false;
      this.playing = false;

      // Per-category feed state (key mode).
      this.queries = [];
      this.buckets = [];        // buckets[i] = array of videoIds for query i
      this.tokens = [];         // tokens[i] = next pageToken ('' = fetch first page)
      this.exhausted = [];      // exhausted[i] = no more pages
      this.fetching = [];       // fetching[i] = a fetch is in flight
      this.channelCount = {};   // channelId -> count currently in the feed
      this.seen = new Set();    // videoIds to skip (this session + persisted history)
      this.persistedTokens = {};// query -> pageToken loaded from feed memory
      this._pendingPlayed = []; // played IDs waiting to be persisted
      this._persistTimer = null;
      this.ptr = 0;             // round-robin pointer across buckets

      this.history = [];        // played videoIds (for getPrevious)
      this.hpos = -1;
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

      this.mountEl = document.createElement('div');
      this.mountEl.id = this.mountId;
      this.mountEl.className = 'rsfc-video-frame';
      container.appendChild(this.mountEl);

      this.onEvt = (e) => this._handleEvt(e);
      window.addEventListener('message', this.onEvt);
      this._showOverlay(this.usingKey ? 'Loading videos…' : 'Loading playlist…');

      if (this.usingKey) {
        const n = this.queries.length;
        this.buckets = this.queries.map(() => []);
        this.exhausted = this.queries.map(() => false);
        this.fetching = this.queries.map(() => false);
        // Randomize which category leads so it isn't always the same one first.
        this.ptr = Math.floor(Math.random() * n) - 1;
        // Load played history + saved pagination so every visit serves a
        // never-before-seen reel and we resume searches where we left off.
        RSFC.storage.getFeedMemory().then((mem) => {
          this.seen = new Set(mem.played || []);
          this.persistedTokens = mem.tokens || {};
          this.tokens = this.queries.map((q) => this.persistedTokens[q] || '');
          RSFC.log('yt.mount key mode, played=' + this.seen.size + ', queries=' + JSON.stringify(this.queries));
          this._nextVideo().then((id) => {
            if (id) {
              this._pushHistory(id);
              this._send({ type: 'init', mountId: this.mountId, videoId: id, muted: this.muted });
              this._prefetchUpcoming();
            } else {
              this._showOverlay('No fresh videos right now — you may have seen the latest results '
                + 'for these categories. Add more categories or check your API quota.');
            }
          });
        });
      } else {
        this.playlistMode = true;
        RSFC.log('yt.mount playlist mode');
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
      if (d.type === 'ready') { this._hideOverlay(); }
      else if (d.type === 'playing') { this._hideOverlay(); this.playing = true; }
      else if (d.type === 'error') { RSFC.log('yt error code=' + d.code); this.getNext(); }
      else if (d.type === 'ended') { if (this.usingKey) this.getNext(); }
    }

    // ---- diverse feed (key mode) ---------------------------------------------
    /** Fetch one page for bucket i; resolves to the number of NEW IDs added. */
    _fetchBucket(i) {
      if (this.exhausted[i] || this.fetching[i]) return Promise.resolve(0);
      this.fetching[i] = true;
      const key = this.config.apiKey.trim();
      const q = this.queries[i];
      const url = 'https://www.googleapis.com/youtube/v3/search'
        + '?part=snippet&type=video&videoEmbeddable=true&videoDuration=short'
        + '&maxResults=25&safeSearch=moderate&q=' + encodeURIComponent(q)
        + (this.tokens[i] ? '&pageToken=' + encodeURIComponent(this.tokens[i]) : '')
        + '&key=' + encodeURIComponent(key);

      RSFC.log('yt fetch bucket ' + i + ' q="' + q + '" page=' + (this.tokens[i] || 'first'));
      return fetch(url)
        .then((r) => r.json())
        .then((data) => {
          this.fetching[i] = false;
          if (data && data.error) {
            RSFC.log('yt API error: ' + data.error.code + ' ' + (data.error.message || '').slice(0, 120));
            throw new Error('yt-api');
          }
          const items = shuffle((data.items || []).slice());
          let added = 0;
          for (const it of items) {
            const id = it.id && it.id.videoId;
            const ch = it.snippet && it.snippet.channelId;
            if (!id || this.seen.has(id)) continue;
            if (ch && (this.channelCount[ch] || 0) >= CHANNEL_CAP) continue; // cap per channel
            this.seen.add(id);
            if (ch) this.channelCount[ch] = (this.channelCount[ch] || 0) + 1;
            this.buckets[i].push(id);
            added++;
          }
          if (data.nextPageToken) this.tokens[i] = data.nextPageToken;
          else this.exhausted[i] = true;
          return added;
        })
        .catch((err) => {
          this.fetching[i] = false;
          RSFC.log('yt fetch bucket ' + i + ' FAILED: ' + (err && err.message));
          // A persisted pageToken can go stale across sessions; fall back to page 1.
          if (this.tokens[i]) this.tokens[i] = '';
          if (!this.history.length) {
            this._showOverlay('YouTube API error. Check that your key is valid, the YouTube '
              + 'Data API v3 is enabled, and (if you restricted the key) that it permits that API.');
          }
          return 0;
        });
    }

    /** Round-robin across category buckets; returns the next videoId or null. */
    _nextVideo() {
      const n = this.queries.length;
      let attempts = 0;
      const step = () => {
        if (attempts++ >= n + 1) return Promise.resolve(null); // full cycle, nothing left
        this.ptr = (this.ptr + 1) % n;
        const i = this.ptr;
        if (this.buckets[i].length > 0) {
          this._prefetchUpcoming();
          return Promise.resolve(this.buckets[i].shift());
        }
        if (this.exhausted[i]) return step();
        return this._fetchBucket(i).then(() => {
          if (this.buckets[i].length > 0) {
            this._prefetchUpcoming();
            return this.buckets[i].shift();
          }
          return step();
        });
      };
      return step();
    }

    /** Warm the next couple of buckets in the background to avoid scroll lag. */
    _prefetchUpcoming() {
      const n = this.queries.length;
      for (let k = 1; k <= 2; k++) {
        const i = (this.ptr + k) % n;
        if (this.buckets[i].length === 0 && !this.exhausted[i] && !this.fetching[i]) {
          this._fetchBucket(i);
        }
      }
    }

    _pushHistory(id) {
      this.history = this.history.slice(0, this.hpos + 1);
      this.history.push(id);
      if (this.history.length > HISTORY_MAX) this.history.shift();
      this.hpos = this.history.length - 1;
      this._markPlayed(id);
    }

    /** Record a video as played and (debounced) persist history + pagination. */
    _markPlayed(id) {
      if (!id) return;
      this.seen.add(id);
      this._pendingPlayed.push(id);
      if (this._persistTimer) return;
      this._persistTimer = setTimeout(() => {
        this._persistTimer = null;
        const ids = this._pendingPlayed; this._pendingPlayed = [];
        try { RSFC.storage.addPlayedIds(ids); } catch (e) {}
        const map = Object.assign({}, this.persistedTokens);
        this.queries.forEach((q, i) => { if (this.tokens[i]) map[q] = this.tokens[i]; });
        this.persistedTokens = map;
        try { RSFC.storage.saveFeedTokens(map); } catch (e) {}
      }, 1200);
    }

    _load(id) { RSFC.log('yt load id=' + id); this._send({ type: 'load', videoId: id, muted: this.muted }); }

    _endOfFeed() {
      this._showOverlay('Reached the end of the current feed for now. Scroll up for previous '
        + 'videos — more load automatically when available (check your API quota if this persists).');
      if (this._retryScheduled) return;
      this._retryScheduled = true;
      setTimeout(() => {
        this._retryScheduled = false;
        if (!this.mountEl) return;
        this._nextVideo().then((id) => { if (id) { this._pushHistory(id); this._hideOverlay(); this._load(id); } });
      }, 5000);
    }

    // ---- VideoSource contract -------------------------------------------------
    getNext() {
      if (!this.mountEl) return;
      if (this.playlistMode) { this._send({ type: 'cmd', func: 'nextVideo' }); return; }
      // Forward through already-seen history first (after a getPrevious).
      if (this.hpos < this.history.length - 1) { this.hpos++; this._load(this.history[this.hpos]); return; }
      if (this.advancing) return;
      this.advancing = true;
      this._nextVideo().then((id) => {
        this.advancing = false;
        if (id) { this._pushHistory(id); this._load(id); }
        else this._endOfFeed();
      });
    }

    getPrevious() {
      if (!this.mountEl) return;
      if (this.playlistMode) { this._send({ type: 'cmd', func: 'previousVideo' }); return; }
      if (this.hpos > 0) { this.hpos--; this._load(this.history[this.hpos]); }
    }

    play() { this.playing = true; this._send({ type: 'cmd', func: 'playVideo' }); }
    pause() { this.playing = false; this._send({ type: 'cmd', func: 'pauseVideo' }); }
    togglePlay() { if (this.playing) this.pause(); else this.play(); }

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
          + 'justify-content:center;background:rgba(0,0,0,0.82);z-index:3';
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
      // Flush any unsaved played history + pagination immediately on teardown.
      if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
      if (this._pendingPlayed && this._pendingPlayed.length) {
        try { RSFC.storage.addPlayedIds(this._pendingPlayed); } catch (e) {}
        this._pendingPlayed = [];
      }
      const map = Object.assign({}, this.persistedTokens);
      (this.queries || []).forEach((q, i) => { if (this.tokens && this.tokens[i]) map[q] = this.tokens[i]; });
      try { RSFC.storage.saveFeedTokens(map); } catch (e) {}

      this._send({ type: 'destroy' });
      if (this.onEvt) { window.removeEventListener('message', this.onEvt); this.onEvt = null; }
      this._hideOverlay();
      const left = document.getElementById(this.mountId);
      if (left && left.parentNode) left.parentNode.removeChild(left);
      this.mountEl = null;
      this.buckets = [];
      this.history = [];
      this.seen = new Set();
      this.channelCount = {};
      super.destroy();
    }
  }

  RSFC.YouTubeShorts = YouTubeShorts;
})();
