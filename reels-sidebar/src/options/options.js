/*
 * options.js — binds the options form to chrome.storage.sync via storage.js.
 * Loaded after storage.js, so window.RSFC.storage is available here.
 */
(function () {
  'use strict';

  const storage = window.RSFC.storage;
  const PRESETS = storage.PRESET_CATEGORIES;

  let reelUrls = [];        // working copy of the ordered Instagram list
  let activeCats = [];      // working copy of selected category ids

  const $ = (id) => document.getElementById(id);

  // ---- Instagram reel list rendering --------------------------------------
  function renderReels() {
    const ul = $('reelList');
    ul.innerHTML = '';
    reelUrls.forEach((url, i) => {
      const li = document.createElement('li');

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = (i + 1);

      const span = document.createElement('span');
      span.className = 'url';
      span.textContent = url;

      const up = document.createElement('button');
      up.className = 'mini btn-ghost'; up.textContent = '▲'; up.title = 'Move up';
      up.disabled = i === 0;
      up.onclick = () => { swap(i, i - 1); };

      const down = document.createElement('button');
      down.className = 'mini btn-ghost'; down.textContent = '▼'; down.title = 'Move down';
      down.disabled = i === reelUrls.length - 1;
      down.onclick = () => { swap(i, i + 1); };

      const del = document.createElement('button');
      del.className = 'mini btn-ghost'; del.textContent = '✕'; del.title = 'Remove';
      del.onclick = () => { reelUrls.splice(i, 1); renderReels(); };

      li.appendChild(num);
      li.appendChild(span);
      li.appendChild(up);
      li.appendChild(down);
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  function swap(a, b) {
    if (b < 0 || b >= reelUrls.length) return;
    const t = reelUrls[a]; reelUrls[a] = reelUrls[b]; reelUrls[b] = t;
    renderReels();
  }

  // ---- category chips ------------------------------------------------------
  function renderChips() {
    const wrap = $('categoryChips');
    wrap.innerHTML = '';
    PRESETS.forEach((cat) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (activeCats.includes(cat.id) ? ' active' : '');
      chip.textContent = cat.label;
      chip.onclick = () => {
        if (activeCats.includes(cat.id)) {
          activeCats = activeCats.filter((c) => c !== cat.id);
        } else {
          activeCats.push(cat.id);
        }
        renderChips();
      };
      wrap.appendChild(chip);
    });
  }

  // ---- load ----------------------------------------------------------------
  function load() {
    storage.getSettings().then((s) => {
      $('enabled').checked = s.enabled;
      $('activeSource').value = s.activeSource;
      $('width').value = s.width;
      $('side').value = s.side;
      $('defaultMute').checked = s.defaultMute;
      $('minVisibleMs').value = s.minVisibleMs;
      $('animations').checked = s.animations;

      activeCats = (s.youtube.categories || []).slice();
      $('terms').value = (s.youtube.terms || []).join(', ');
      $('playlistIds').value = (s.youtube.playlistIds || []).join(', ');
      $('apiKey').value = s.youtube.apiKey || '';

      reelUrls = (s.instagram.reelUrls || []).slice();

      renderChips();
      renderReels();
    });
  }

  // ---- save ----------------------------------------------------------------
  function csv(v) {
    return v.split(',').map((x) => x.trim()).filter(Boolean);
  }

  function save() {
    const patch = {
      enabled: $('enabled').checked,
      activeSource: $('activeSource').value,
      width: clampInt($('width').value, 240, 640, 380),
      side: $('side').value,
      defaultMute: $('defaultMute').checked,
      minVisibleMs: clampInt($('minVisibleMs').value, 0, 10000, 1500),
      animations: $('animations').checked,
      youtube: {
        categories: activeCats.slice(),
        terms: csv($('terms').value),
        playlistIds: csv($('playlistIds').value),
        apiKey: $('apiKey').value.trim()
      },
      instagram: {
        reelUrls: reelUrls.slice()
      }
    };
    storage.setSettings(patch).then(() => {
      const msg = $('savedMsg');
      msg.classList.add('show');
      setTimeout(() => msg.classList.remove('show'), 1500);
    });
  }

  function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  // ---- wire ----------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    load();
    $('addReel').onclick = () => {
      const val = $('reelInput').value.trim();
      if (val) { reelUrls.push(val); $('reelInput').value = ''; renderReels(); }
    };
    $('save').onclick = save;
  });
})();
