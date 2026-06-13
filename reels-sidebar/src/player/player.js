/*
 * player.js — runs INSIDE the extension-origin player page (player.html),
 * which the content script frames into the claude.ai sidebar.
 *
 * WHY THIS EXISTS: a content script lives in an isolated world and cannot load
 * the YouTube IFrame API (the API's globals land in the page world, not ours),
 * and claude.ai's CSP would block embedding YouTube directly anyway. By framing
 * an extension page (a web_accessible_resource), we get a chrome-extension://
 * origin whose own permissive CSP lets us embed YouTube and Instagram freely —
 * the host page's CSP does not apply to extension-resource iframes.
 *
 * We talk to the YouTube embed with its native postMessage command protocol
 * (enablejsapi=1), so we DON'T need to load any remote script (which MV3
 * extension pages forbid). We talk to the content-script controller via
 * window.parent.postMessage.
 *
 * Protocol — controller -> player  (messages tagged source:'rsfc-ctrl'):
 *   { type:'load-youtube',  videoId, muted }
 *   { type:'load-playlist', playlistId, muted }
 *   { type:'load-instagram', shortcode }
 *   { type:'cmd', func:'playVideo'|'pauseVideo'|'mute'|'unMute'|'nextVideo'|'previousVideo' }
 *
 * Protocol — player -> controller  (messages tagged source:'rsfc-player'):
 *   { type:'page-ready' }   the player page itself is up and listening
 *   { type:'ready' }        a YouTube video is ready / playing
 *   { type:'ended' }        the current YouTube video finished (auto-advance)
 *   { type:'error' }        the current YouTube video errored (skip it)
 */
(function () {
  'use strict';

  const PARENT = window.parent;
  const YT_ORIGIN = 'https://www.youtube.com';
  const PLAYER_ID = 1; // any stable id the embed echoes back in the handshake
  const host = document.getElementById('host');

  let ytFrame = null;
  let igFrame = null;
  let ytReadyPosted = false;
  let currentMuted = true;
  let watchdog = null;

  function toParent(type, info) {
    try { PARENT.postMessage({ source: 'rsfc-player', type: type, info: info }, '*'); } catch (e) {}
  }

  function log() {
    try { console.log.apply(console, ['[RSFC-player]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  function clearWatchdog() { if (watchdog) { clearTimeout(watchdog); watchdog = null; } }

  function clearHost() {
    host.innerHTML = '';
    ytFrame = null;
    igFrame = null;
    ytReadyPosted = false;
  }

  function ensureYTFrame() {
    if (ytFrame) return;
    clearHost();
    ytFrame = document.createElement('iframe');
    ytFrame.id = 'rsfc-yt';
    ytFrame.setAttribute(
      'allow',
      'autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; clipboard-write; gyroscope'
    );
    ytFrame.setAttribute('allowfullscreen', 'true');
    host.appendChild(ytFrame);
  }

  function ytParams() {
    // NOTE: we intentionally do NOT send an `origin` param. The page origin here
    // is chrome-extension://<id>, which is not an http(s) origin; YouTube's embed
    // origin check rejects it and throws error 153/150, blanking every video.
    // Omitting origin lets the embed play; postMessage control still works.
    return 'enablejsapi=1&autoplay=1&playsinline=1&rel=0&modestbranding=1&controls=1&fs=1'
      + '&mute=' + (currentMuted ? 1 : 0);
  }

  function attachHandshake() {
    // After the embed loads, register as a listener so it streams us state
    // events (onReady / playerState). This is the same handshake the official
    // IFrame API performs under the hood.
    ytFrame.onload = function () {
      try {
        ytFrame.contentWindow.postMessage(
          JSON.stringify({ event: 'listening', id: PLAYER_ID, channel: 'widget' }),
          YT_ORIGIN
        );
      } catch (e) {}
    };
  }

  function loadYouTube(videoId, muted) {
    currentMuted = !!muted;
    log('loadYouTube', videoId);
    toParent('video-requested', videoId);
    ensureYTFrame();
    ytReadyPosted = false; // re-arm the one-shot 'ready' for this new video
    attachHandshake();
    ytFrame.src = YT_ORIGIN + '/embed/' + encodeURIComponent(videoId) + '?' + ytParams();
    // Watchdog: if the embed never reports ready, tell the controller so it can
    // skip to the next video instead of showing a permanent black frame.
    clearWatchdog();
    watchdog = setTimeout(() => {
      if (!ytReadyPosted) { log('watchdog: no ready for', videoId); toParent('error', 'timeout'); }
    }, 6000);
  }

  function loadPlaylist(listId, muted) {
    currentMuted = !!muted;
    ensureYTFrame();
    ytReadyPosted = false; // re-arm the one-shot 'ready' for this new playlist
    attachHandshake();
    ytFrame.src = YT_ORIGIN + '/embed/videoseries?list=' + encodeURIComponent(listId)
      + '&loop=1&' + ytParams();
  }

  function loadInstagram(shortcode) {
    clearHost();
    igFrame = document.createElement('iframe');
    igFrame.setAttribute('allowtransparency', 'true');
    igFrame.setAttribute('allowfullscreen', 'true');
    igFrame.setAttribute('scrolling', 'no');
    igFrame.src = 'https://www.instagram.com/reel/' + encodeURIComponent(shortcode) + '/embed/';
    host.appendChild(igFrame);
    toParent('ready'); // Instagram embeds don't report state; treat as ready
  }

  function ytCommand(func) {
    if (!ytFrame || !ytFrame.contentWindow) return;
    try {
      ytFrame.contentWindow.postMessage(
        JSON.stringify({ event: 'command', func: func, args: [], id: PLAYER_ID, channel: 'widget' }),
        YT_ORIGIN
      );
    } catch (e) {}
  }

  // --- messages from the YouTube embed ---------------------------------------
  function onYouTubeMessage(e) {
    if (e.origin !== YT_ORIGIN) return;
    let data = e.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) { return; }
    }
    if (!data || typeof data !== 'object') return;

    if (data.event === 'onReady' || data.event === 'initialDelivery' || data.event === 'apiInfoDelivery') {
      if (!ytReadyPosted) { ytReadyPosted = true; clearWatchdog(); log('yt ready'); toParent('ready'); }
      ytCommand('playVideo'); // nudge playback (helps when autoplay is gated)
    }
    if (data.event === 'infoDelivery' && data.info && typeof data.info.playerState !== 'undefined') {
      if (!ytReadyPosted) { ytReadyPosted = true; toParent('ready'); }
      if (data.info.playerState === 0) toParent('ended'); // 0 = ended
    }
    if (data.event === 'onError') {
      log('yt onError', JSON.stringify(data));
      toParent('error', (data && (data.info !== undefined ? data.info : data.data)));
    }
  }

  // --- messages from the content-script controller ---------------------------
  function onControllerMessage(e) {
    const d = e.data;
    if (!d || d.source !== 'rsfc-ctrl') return;
    // Only obey our embedding parent (the content-script controller). Without
    // this, any frame on claude.ai that grabbed a handle to this web-accessible
    // page could drive what we embed. The legitimate controller posts from the
    // top window that hosts this iframe, i.e. window.parent.
    if (e.source !== PARENT) { toParent('debug', 'ctrl-rejected-source'); return; }
    log('ctrl', d.type);
    switch (d.type) {
      case 'load-youtube':   loadYouTube(d.videoId, d.muted); break;
      case 'load-playlist':  loadPlaylist(d.playlistId, d.muted); break;
      case 'load-instagram': loadInstagram(d.shortcode); break;
      case 'cmd':            ytCommand(d.func); break;
    }
  }

  window.addEventListener('message', function (e) {
    if (e.origin === YT_ORIGIN) onYouTubeMessage(e);
    else onControllerMessage(e);
  });

  // If autoplay is gated by the host page's permissions policy, a click inside
  // the panel is a user gesture that lets playback start.
  host.addEventListener('click', function () { ytCommand('playVideo'); });

  // Tell the controller we're up so it can flush its queued load command.
  toParent('page-ready');
})();
