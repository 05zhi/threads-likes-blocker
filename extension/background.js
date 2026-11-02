/* Toolbar activation is the only entry point. No persistent host access. */
chrome.action.onClicked.addListener(async (tab) => {
  try {
    const url = new URL(tab.url || "");
    if (url.protocol !== "https:" || !["threads.com", "www.threads.com", "threads.net", "www.threads.net"].includes(url.hostname)) {
      await chrome.action.setBadgeText({ tabId: tab.id, text: "WEB" });
      await chrome.action.setTitle({ tabId: tab.id, title: "請先開啟 Threads 網頁，再按此圖示。" });
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (tabId) => { globalThis.__threadsProbeTabId = tabId; },
      args: [tab.id]
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["core.js", "content.js"]
    });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  } catch (error) {
    if (tab.id == null) return;
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    await chrome.action.setTitle({ tabId: tab.id, title: `無法開啟工具：${error.message}` });
  }
});
