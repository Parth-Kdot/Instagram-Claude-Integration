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
    }
  };

  RSFC.storage = storage;
})();
