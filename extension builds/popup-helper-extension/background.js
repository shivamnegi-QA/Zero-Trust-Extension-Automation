// Receives { type: 'OPEN_POPUP' } from Playwright via chrome.runtime.sendMessage
// and calls chrome.action.openPopup() to open THIS extension's popup —
// but we use it to trigger ZTB's popup by setting the active tab's windowId.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'OPEN_POPUP') return;
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const opts = tabs[0]?.windowId != null ? { windowId: tabs[0].windowId } : {};
    chrome.action.openPopup(opts)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
  });
  return true; // keep channel open for async sendResponse
});
