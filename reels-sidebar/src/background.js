/*
 * background.js — minimal service worker.
 *
 * Currently only used as a DEV convenience: the content script can ask it to
 * reload the whole extension (chrome.runtime.reload is not available to content
 * scripts directly). This lets the extension be reloaded without manually
 * visiting chrome://extensions during development.
 *
 * NOTE: remove the dev-reload handler before shipping a production build.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'rsfc-devreload') {
    try { sendResponse({ ok: true }); } catch (e) {}
    chrome.runtime.reload();
    return true;
  }
});
