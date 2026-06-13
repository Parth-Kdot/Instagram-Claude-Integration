/*
 * ytController.js — runs in the PAGE (MAIN world) on claude.ai.
 *
 * The content script lives in an isolated world and cannot access window.YT, so
 * it cannot drive the official YouTube IFrame Player API directly. This script
 * runs in the page's main world, loads that API, and manages a YT.Player on the
 * content script's behalf — which is the reliable way to get muted autoplay,
 * play/pause/mute control, and onStateChange/onError events. We hand-rolled the
 * postMessage protocol before, but it did not reliably start playback; the
 * official API does.
 *
 * Bridge (both directions via window.postMessage on the shared window):
 *   content -> controller  (source:'rsfc-yt-cmd'):
 *     {type:'init', mountId, videoId?, playlistId?, muted}
 *     {type:'load', videoId, muted}
 *     {type:'cmd',  func:'playVideo'|'pauseVideo'|'mute'|'unMute'|'nextVideo'|'previousVideo'}
 *     {type:'destroy'}
 *   controller -> content  (source:'rsfc-yt-evt'):
 *     {type:'ready'|'playing'|'ended'|'error', code?}
 */
(function () {
  'use strict';
  if (window.__rsfcYtController) return;
  window.__rsfcYtController = true;

  var player = null;
  var apiReady = false;
  var pendingInit = null;

  function post(type, extra) {
    var msg = { source: 'rsfc-yt-evt', type: type };
    if (extra) { for (var k in extra) { msg[k] = extra[k]; } }
    try { window.postMessage(msg, window.location.origin); } catch (e) {}
  }

  function flush() {
    if (pendingInit) { var p = pendingInit; pendingInit = null; createPlayer(p); }
  }

  function ensureApi() {
    if (window.YT && window.YT.Player) { apiReady = true; flush(); return; }
    var prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      if (typeof prev === 'function') { try { prev(); } catch (e) {} }
      apiReady = true;
      flush();
    };
    if (!document.querySelector('script[data-rsfc-yt]')) {
      var s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.setAttribute('data-rsfc-yt', '1');
      (document.head || document.documentElement).appendChild(s);
    }
  }

  function destroyPlayer() {
    if (player && player.destroy) { try { player.destroy(); } catch (e) {} }
    player = null;
  }

  function createPlayer(opts) {
    var el = document.getElementById(opts.mountId);
    if (!el) { post('error', { code: 'no-mount' }); return; }
    destroyPlayer();
    // controls:0 hides the play/pause button, the red progress/scrubber, the
    // timestamp and the fullscreen button; iv_load_policy:3 hides annotations;
    // fs:0 / disablekb:1 remove the fullscreen button and keyboard hints. The
    // title/channel hover-chrome is additionally suppressed by the tap layer the
    // sidebar puts over the player.
    var vars = {
      autoplay: 1, mute: opts.muted ? 1 : 0, playsinline: 1,
      rel: 0, modestbranding: 1, controls: 0, fs: 0,
      iv_load_policy: 3, disablekb: 1
    };
    var cfg = { width: '100%', height: '100%', playerVars: vars, events: {
      onReady: function (e) {
        try { if (opts.muted) { e.target.mute(); } e.target.playVideo(); } catch (x) {}
        post('ready');
      },
      onStateChange: function (e) {
        if (e.data === 1) post('playing');     // 1 = playing
        else if (e.data === 0) post('ended');  // 0 = ended
      },
      onError: function (e) { post('error', { code: e.data }); }
    } };
    if (opts.playlistId) { vars.listType = 'playlist'; vars.list = opts.playlistId; vars.loop = 1; }
    else if (opts.videoId) { cfg.videoId = opts.videoId; }
    try { player = new YT.Player(opts.mountId, cfg); }
    catch (e) { post('error', { code: 'init-failed' }); }
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.source !== 'rsfc-yt-cmd') return;
    switch (d.type) {
      case 'init':
        if (apiReady) createPlayer(d); else { pendingInit = d; ensureApi(); }
        break;
      case 'load':
        if (player && player.loadVideoById) {
          try { player.loadVideoById(d.videoId); if (d.muted) player.mute(); player.playVideo(); } catch (x) {}
        }
        break;
      case 'cmd':
        if (player && typeof player[d.func] === 'function') { try { player[d.func](); } catch (x) {} }
        break;
      case 'destroy':
        destroyPlayer();
        break;
    }
  });

  ensureApi();
})();
