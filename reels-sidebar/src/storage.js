/*
 * storage.js — chrome.storage.sync wrapper + shared defaults.
 *
 * Loaded both in the claude.ai content script (ISOLATED world) and in the
 * options page. In both contexts `chrome.storage.sync` is available. We attach
 * everything to a single global namespace (window.RSFC) because MV3 content
 * scripts run as classic scripts sharing one scope — there is no module system.
 */
(function () {
  'use strict';

  const RSFC = (window.RSFC = window.RSFC || {});

  // Lightweight, prefixed logger. Toggle off by setting window.RSFC_DEBUG=false.
  // Kept on by default while we stabilize playback; logs only timing/state, never
  // prompt or response text.
  RSFC.log = function () {
    try {
      if (window.RSFC_DEBUG === false) return;
      const args = Array.prototype.slice.call(arguments);
      console.log.apply(console, ['[RSFC]'].concat(args));
    } catch (e) { /* no-op */ }
  };

  /**
   * Curated pool of ready-made interest categories. Each maps to a YouTube
   * search query tuned to surface Shorts. The options page renders these as
   * toggleable chips so the user never has to invent search terms; the YouTube
   * source rotates through the *active* categories' queries (plus any custom
   * terms) for both no-key search mode and Data-API-key mode.
   */
  const PRESET_CATEGORIES = [
    { id: 'comedy',     label: 'Comedy',          query: 'funny shorts' },
    { id: 'sports',     label: 'Sports',          query: 'sports highlights shorts' },
    { id: 'gaming',     label: 'Gaming',          query: 'gaming shorts' },
    { id: 'music',      label: 'Music',           query: 'music shorts' },
    { id: 'food',       label: 'Food & Cooking',  query: 'cooking recipe shorts' },
    { id: 'science',    label: 'Science & Tech',  query: 'science tech shorts' },
    { id: 'animals',    label: 'Animals',         query: 'cute animals shorts' },
    { id: 'travel',     label: 'Travel',          query: 'travel shorts' },
    { id: 'fitness',    label: 'Fitness',         query: 'workout fitness shorts' },
    { id: 'cars',       label: 'Cars',            query: 'cars shorts' },
    { id: 'fashion',    label: 'Fashion & Beauty',query: 'fashion beauty shorts' },
    { id: 'dance',      label: 'Dance',           query: 'dance shorts' },
    { id: 'art',        label: 'Art',             query: 'art drawing shorts' },
    { id: 'diy',        label: 'DIY',             query: 'diy life hacks shorts' },
    { id: 'education',  label: 'Education',       query: 'educational shorts' },
    { id: 'nature',     label: 'Nature',          query: 'nature shorts' },
    { id: 'motivation', label: 'Motivation',      query: 'motivation shorts' },
    { id: 'asmr',       label: 'ASMR',            query: 'asmr shorts' },
    { id: 'movies',     label: 'Movies & TV',     query: 'movie clips shorts' },
    { id: 'memes',      label: 'Memes',           query: 'meme shorts' }
  ];

  // chrome.storage.local keys for feed memory (see getFeedMemory below).
  const PLAYED_KEY = 'rsfc_played_ids';
  const TOKENS_KEY = 'rsfc_feed_tokens';
  const PLAYED_CAP = 5000; // most-recent N played IDs kept (bounds storage size)

  /** Default settings. Everything the options page edits has a default here. */
  const DEFAULTS = {
    enabled: true,
    activeSource: 'youtube',          // 'youtube' | 'instagram'
    width: 380,                       // px
    side: 'right',                    // 'right' | 'left'
    defaultMute: true,
    minVisibleMs: 1500,               // min time the panel stays up (anti-flicker)
    animations: true,
    youtube: {
      categories: ['comedy', 'science', 'animals', 'music'], // active preset ids
      terms: [],                      // optional custom search terms
      playlistIds: [],                // optional public Shorts playlist IDs (no-key reliable path)
      apiKey: ''                      // optional YouTube Data API v3 key -> endless paginated feed
    },
    instagram: {
      reelUrls: []                    // ordered list of reel URLs (official embed only)
    }
  };

  /** Deep-merge stored values over DEFAULTS so new keys always have a value. */
  function withDefaults(stored) {
    const s = stored || {};
    return {
      ...DEFAULTS,
      ...s,
      youtube: { ...DEFAULTS.youtube, ...(s.youtube || {}) },
      instagram: { ...DEFAULTS.instagram, ...(s.instagram || {}) }
    };
  }

  const storage = {
    DEFAULTS,
    PRESET_CATEGORIES,

    /** Resolve current settings merged over defaults. */
    getSettings() {
      return new Promise((resolve) => {
        try {
          chrome.storage.sync.get(null, (stored) => resolve(withDefaults(stored)));
        } catch (e) {
          resolve(withDefaults(null));
        }
      });
    },

    /** Persist a shallow patch (top-level keys). Returns a promise. */
    setSettings(patch) {
      return new Promise((resolve) => {
        try {
          chrome.storage.sync.set(patch, () => resolve());
        } catch (e) {
          resolve();
        }
      });
    },

    /**
     * Subscribe to changes. Callback receives the full merged settings object.
     * Returns an unsubscribe function.
     */
    onChange(cb) {
      const handler = (changes, area) => {
        if (area !== 'sync') return;
        this.getSettings().then(cb);
      };
      try {
        chrome.storage.onChanged.addListener(handler);
      } catch (e) { /* no-op */ }
      return () => {
        try { chrome.storage.onChanged.removeListener(handler); } catch (e) { /* no-op */ }
      };
    },

    // --- feed memory (chrome.storage.local) ----------------------------------
    // Persists which videos have already been played and how far we've paginated
    // each search, so a fresh, never-before-seen reel plays every time the panel
    // opens — across reloads and sessions. Stored in LOCAL (not sync) because the
    // played list grows and is device-local by nature.

    /** Load { played: string[], tokens: {query: pageToken} }. */
    getFeedMemory() {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get([PLAYED_KEY, TOKENS_KEY], (res) => {
            resolve({
              played: (res && res[PLAYED_KEY]) || [],
              tokens: (res && res[TOKENS_KEY]) || {}
            });
          });
        } catch (e) { resolve({ played: [], tokens: {} }); }
      });
    },

    /** Append played video IDs (de-duped, capped to the most recent PLAYED_CAP). */
    addPlayedIds(ids) {
      return new Promise((resolve) => {
        if (!ids || !ids.length) { resolve(); return; }
        try {
          chrome.storage.local.get([PLAYED_KEY], (res) => {
            let arr = (res && res[PLAYED_KEY]) || [];
            const set = new Set(arr);
            ids.forEach((id) => { if (id && !set.has(id)) { set.add(id); arr.push(id); } });
            if (arr.length > PLAYED_CAP) arr = arr.slice(arr.length - PLAYED_CAP);
            const o = {}; o[PLAYED_KEY] = arr;
            chrome.storage.local.set(o, () => resolve());
          });
        } catch (e) { resolve(); }
      });
    },

    /** Persist per-query pagination tokens so we resume where we left off. */
    saveFeedTokens(tokens) {
      return new Promise((resolve) => {
        try {
          const o = {}; o[TOKENS_KEY] = tokens || {};
          chrome.storage.local.set(o, () => resolve());
        } catch (e) { resolve(); }
      });
    },

    /** Clear all feed memory (used by the options "reset history" control). */
    clearFeedMemory() {
      return new Promise((resolve) => {
        try { chrome.storage.local.remove([PLAYED_KEY, TOKENS_KEY], () => resolve()); }
        catch (e) { resolve(); }
      });
    }
  };

  RSFC.storage = storage;
})();
