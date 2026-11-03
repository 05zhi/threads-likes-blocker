/* Only an explicit panel command starts a blocking job. */
importScripts("core.js", "job.js");
const Core = globalThis.ThreadsProbeCore, Jobs = globalThis.ThreadsBlockJob;
const BUILD_VERSION = "0.4.3";
const JOB_KEY = "threadsBlocker.job.v1";
let job = null, runner = null, serial = Promise.resolve(), workerOwnership = null;
const openingTabs = new Set();
const now = () => new Date().toISOString();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ready = chrome.storage.local.get(JOB_KEY).then(async saved => {
  if (saved[JOB_KEY]) { job = Jobs.recover(saved[JOB_KEY], now()); job.workerTabId = null; await save(); }
});
function safeOrigin(raw) {
  try { const u = new URL(raw); return u.protocol === "https:" && !u.username && !u.password && !u.port && ["threads.com", "www.threads.com", "threads.net", "www.threads.net"].includes(u.hostname); } catch { return false; }
}
function locked(task) { return task && (["running", "paused"].includes(task.status) || task.current != null); }
function buildIdentity() {
  return { buildVersion: BUILD_VERSION, runtimeVersion: chrome.runtime.getManifest?.()?.version || "unknown", extensionId: chrome.runtime.id || "" };
}
function assertBuildVersion() {
  const identity = buildIdentity();
  if (identity.runtimeVersion !== BUILD_VERSION) throw new Error(`背景程式版本 ${BUILD_VERSION} 與套件版本 ${identity.runtimeVersion} 不一致，請重新載入擴充功能。`);
  return identity;
}
function assertPanelVersion(message) {
  const identity = assertBuildVersion();
  if (message.panelVersion !== BUILD_VERSION) throw new Error(`面板版本 ${message.panelVersion || "未提供（舊版面板）"} 與背景程式 ${BUILD_VERSION} 不一致，請按修正版工具圖示重新開啟。`);
  if (!identity.extensionId || message.extensionId !== identity.extensionId) throw new Error("面板來源與目前擴充功能不一致，請按修正版工具圖示重新開啟。");
  return identity;
}
function sameTarget(a, b) { return !!a && !!b && a.username.toLowerCase() === b.username.toLowerCase() && a.postId === b.postId; }
function sourcePage(raw) {
  return Core.sourcePage(raw);
}
function sameSource(a, b) {
  const left = Core.canonicalTarget(a), right = Core.canonicalTarget(b);
  if (left || right) return sameTarget(left, right);
  return !!sourcePage(a) && sourcePage(a) === sourcePage(b);
}
async function assertSource(task) {
  const tab = await chrome.tabs.get(task.sourceTabId);
  if (!sameSource(tab.url, task.sourcePage || task.target.url)) throw new Error("來源分頁已關閉或離開原目標，尚未送出封鎖確認。");
}
async function save() { await chrome.storage.local.set({ [JOB_KEY]: job }); }
function mutate(fn) { const result = serial.catch(() => {}).then(fn); serial = result.catch(() => {}); return result; }
async function closeWorker(task) {
  const id = task?.workerTabId;
  if (!Number.isInteger(id)) return;
  if (job?.id === task.id) { job.workerTabId = null; await save(); }
  if (workerOwnership?.tabId !== id || workerOwnership?.jobId !== task.id) return;
  workerOwnership = null;
  try { const tab = await chrome.tabs.get(id), profile = Core.profileFromHref(tab.url); if (profile && task.items.some(a => a.username.toLowerCase() === profile.username.toLowerCase())) await chrome.tabs.remove(id); } catch { /* Already closed or user navigated elsewhere. */ }
}
async function waitForProfile(tabId, username, taskId) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (job?.id !== taskId || job.status !== "running") return false;
    const tab = await chrome.tabs.get(tabId);
    if (!safeOrigin(tab.url || "")) {
      if (tab.url && tab.url !== "about:blank") throw new Error("工作分頁離開 Threads，請檢查登入或驗證。");
    } else if (tab.status === "complete") {
      const profile = Core.profileFromHref(tab.url);
      if (!profile || profile.username.toLowerCase() !== username.toLowerCase()) throw new Error("個人檔案導向其他頁面，尚未封鎖。");
      return true;
    }
    await wait(250);
  }
  throw new Error("個人檔案載入逾時，尚未封鎖。");
}
async function adapter(tabId, args) {
  const response = await chrome.scripting.executeScript({ target: { tabId }, func: input => globalThis.ThreadsBlockAdapter.perform(input), args: [args] });
  if (response.length !== 1 || !response[0].result) throw new Error("無法讀取適配器結果。");
  return response[0].result;
}
async function readActor(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!safeOrigin(tab.url)) throw new Error("請回到已登入的 Threads 分頁。");
  await chrome.scripting.executeScript({ target: { tabId }, files: ["block-adapter.js"] });
  const response = await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.ThreadsBlockAdapter.readableActorFromNavigation() });
  const actorUsername = response.length === 1 ? response[0].result : null;
  if (typeof actorUsername !== "string" || !/^[A-Za-z0-9._]{1,30}$/.test(actorUsername)) throw new Error("尚無法確認登入帳號，請等待 Threads 載入或確認已登入。");
  const current = await chrome.tabs.get(tabId);
  if (!safeOrigin(current.url) || sourcePage(current.url) !== sourcePage(tab.url)) throw new Error("頁面已改變，請重新確認登入帳號。");
  return actorUsername;
}
async function panelIdentity(tabId) {
  const response = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const probe = globalThis.__threadsLikesProbe, host = document.getElementById("threads-likes-probe-host");
    return { hasProbe: !!probe, hasHost: !!host, hostCount: document.querySelectorAll('#threads-likes-probe-host').length, version: probe?.version || null, extensionId: probe?.extensionId || null, hostVersion: host?.dataset.panelVersion || null, hostExtensionId: host?.dataset.extensionId || null };
  } });
  if (response.length !== 1 || typeof response[0].result?.hasProbe !== "boolean" || typeof response[0].result?.hasHost !== "boolean" || !Number.isSafeInteger(response[0].result?.hostCount)) throw new Error("無法確認頁面中的工具版本，尚未開啟面板。");
  return response[0].result;
}
function compatiblePanel(identity, version, extensionId) {
  return identity.hasProbe && identity.hasHost && identity.hostCount === 1 && identity.version === version && identity.extensionId === extensionId && identity.hostVersion === version && identity.hostExtensionId === extensionId;
}
async function sourceTab(tabId, expectedSource) {
  const tab = await chrome.tabs.get(tabId);
  if (!safeOrigin(tab.url) || sourcePage(tab.url) !== expectedSource) throw new Error("來源頁面已改變，請回到原 Threads 頁面後重新開啟工具。");
  return tab;
}
async function pauseForPanelUpgrade(tabId) {
  await ready;
  await mutate(async () => {
    if (job?.sourceTabId !== tabId || !["running", "paused"].includes(job.status)) return;
    job = Jobs.pause(job, now());
    job.reason = "工具版本已更新，來源頁面重新載入；封鎖工作維持暫停，請核對後手動繼續。";
    await save();
  });
}
async function reloadForPanelUpgrade(tabId, expectedSource) {
  await pauseForPanelUpgrade(tabId);
  await sourceTab(tabId, expectedSource);
  await chrome.tabs.reload(tabId);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const tab = await sourceTab(tabId, expectedSource);
    if (tab.status === "complete") {
      // A reload can be queued while tabs.get still reports the old complete
      // document. Require a fresh document, not just its loading status.
      try {
        const identity = await panelIdentity(tabId);
        if (!identity.hasProbe && identity.hostCount === 0) return;
      } catch { /* Navigation may replace the frame between completion and this read. */ }
    }
    await wait(250);
  }
  throw new Error("頁面更新逾時或仍有另一個工具面板，請重新整理 Threads 後再開啟。");
}
function kick() {
  if (runner || job?.status !== "running") return;
  runner = run().finally(() => { runner = null; if (job?.status === "running") kick(); });
}
async function defer(username) {
  await mutate(async () => {
    if (job.status === "paused") job = Jobs.deferPrepared(job, username, "最後確認前已暫停，該帳號尚未封鎖。", now());
    else if (job.current === username) job = Jobs.recordResult(job, username, { status: "skipped", reason: "最後確認前已中止，未封鎖。" }, now());
    await save();
  });
}
async function run() {
  const taskId = job.id;
  try {
    while (job?.id === taskId && job.status === "running") {
      await mutate(async () => { job = Jobs.nextItem(job, now()); await save(); });
      if (job.status !== "running" || !job.current) break;
      const username = job.current, actorUsername = job.actorUsername;
      let submitted = false, result;
      try {
        await assertSource(job);
        let tabId = job.workerTabId;
        if (Number.isInteger(tabId)) {
          if (workerOwnership?.tabId !== tabId || workerOwnership?.jobId !== taskId) tabId = null;
          else { const tab = await chrome.tabs.get(tabId), profile = Core.profileFromHref(tab.url); if (!profile || !job.items.some(a => a.username.toLowerCase() === profile.username.toLowerCase())) throw new Error("工作分頁已變更，請人工核對。"); }
        }
        if (!Number.isInteger(tabId)) {
          const tab = await chrome.tabs.create({ url: `https://www.threads.com/@${username}`, active: false });
          tabId = tab.id; workerOwnership = { tabId, jobId: taskId }; job.workerTabId = tabId; await save();
        } else await chrome.tabs.update(tabId, { url: `https://www.threads.com/@${username}` });
        if (!await waitForProfile(tabId, username, taskId)) { await defer(username); break; }
        await chrome.scripting.executeScript({ target: { tabId }, files: ["core.js", "block-adapter.js"] });
        result = await adapter(tabId, { username, actorUsername, phase: "prepare" });
        if (result.status === "prepared") {
          await assertSource(job);
          const maySubmit = await mutate(async () => {
            if (job.id !== taskId || job.current !== username || job.status !== "running") return false;
            job.phase = "confirming"; job.updatedAt = now(); await save(); return true;
          });
          if (!maySubmit || job.status !== "running") { await defer(username); break; }
          submitted = true;
          result = await adapter(tabId, { username, actorUsername, phase: "confirm", confirmationToken: result.confirmationToken });
        }
        if (!["success", "already-blocked", "skipped", "failed", "unknown", "needs-attention"].includes(result.status)) result = { status: "needs-attention", reason: "適配器狀態無法辨識，已暫停。" };
      } catch (error) { result = { status: submitted ? "unknown" : "needs-attention", reason: `${submitted ? "確認可能已送出，請人工核對" : "尚未送出最後確認"}：${error.message}` }; }
      await mutate(async () => {
        if (job?.id === taskId && job.current === username) { job = Jobs.recordResult(job, username, result, now()); job.phase = null; await save(); }
      });
      if (job.status === "running") await wait(1500);
    }
  } catch (error) {
    await mutate(async () => { if (job?.id === taskId) { job = Jobs.recover(job, now()); job.reason = `工作中斷：${error.message}`; await save(); } });
  } finally { if (job?.id === taskId && ["completed", "stopped"].includes(job.status)) await closeWorker(job); }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message?.type !== "string" || !message.type.startsWith("BLOCK_")) return;
  (async () => {
    await ready;
    if (!Number.isInteger(sender?.tab?.id) || !safeOrigin(sender.tab.url || sender.url)) throw new Error("只接受 Threads 分頁面板指令。");
    if (message.type === "BLOCK_GET") return { ok: true, job, ...buildIdentity() };
    if (message.type === "BLOCK_ACTOR") return { ok: true, actorUsername: await readActor(sender.tab.id) };
    return mutate(async () => {
      if (openingTabs.has(sender.tab.id) && ["BLOCK_START", "BLOCK_RESUME"].includes(message.type)) throw new Error("工具面板正在更新，請等新版面板開啟後重新核對名單。");
      const identity = ["BLOCK_START", "BLOCK_RESUME"].includes(message.type) ? assertPanelVersion(message) : null;
      if (message.type === "BLOCK_START") {
        if (locked(job) || runner) throw new Error("已有工作仍在執行或收尾，請先完成或中止後稍候。");
        if (message.confirmed !== true) throw new Error("請先確認封鎖名單。");
        const target = Core.canonicalTarget(message.target?.url), source = Core.canonicalTarget(sender.tab.url);
        const cardBinding = message.target?.binding === "user-confirmed" && sameSource(message.target?.sourcePage, sender.tab.url);
        if (!target || (!sameTarget(target, source) && !cardBinding)) throw new Error("來源頁面已改變，請重新選擇貼文或留言並確認名單。");
        job = Jobs.createJob({ accounts: message.accounts, target: message.target, includeAuthor: message.includeAuthor, actorUsername: message.actorUsername, sourceTabId: sender.tab.id }, now());
        job.sourcePage = sourcePage(sender.tab.url);
        job.extensionVersion = identity.runtimeVersion;
        job.buildVersion = identity.buildVersion; job.runtimeVersion = identity.runtimeVersion;
        job.extensionId = identity.extensionId; job.clientPanelVersion = message.panelVersion;
        await save(); kick();
      } else {
        if (!job) throw new Error("目前沒有封鎖工作。");
        if (message.type === "BLOCK_PAUSE") job = Jobs.pause(job, now());
        else if (message.type === "BLOCK_STOP") job = Jobs.stop(job, now());
        else if (message.type === "BLOCK_RESUME") {
          if (typeof message.jobId !== "string" || message.jobId !== job.id) throw new Error("原封鎖工作已變更，請重新核對目前工作後再繼續。");
          if (!sameSource(sender.tab.url, job.sourcePage || job.target.url) || String(message.actorUsername || "").trim().replace(/^@/, "").toLowerCase() !== job.actorUsername.toLowerCase()) throw new Error("請回原來源頁面，並確認目前登入的仍是原帳號後繼續。");
          job = Jobs.resume(job, now()); job.sourceTabId = sender.tab.id;
          job.buildVersion = identity.buildVersion; job.runtimeVersion = identity.runtimeVersion;
          job.extensionId = identity.extensionId; job.clientPanelVersion = message.panelVersion;
        } else throw new Error("無法辨識工作指令。");
        await save(); if (job.status === "running") kick();
        if (job.status === "stopped" && !runner) await closeWorker(job);
      }
      return { ok: true, job };
    });
  })().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  ready.then(() => mutate(async () => {
    if (!locked(job)) return;
    if (tabId === job.workerTabId) { job = Jobs.recover(job, now()); job.workerTabId = null; job.reason = "工作分頁已關閉，未確認的結果不會重試。"; await save(); }
    else if (tabId === job.sourceTabId) { job = Jobs.pause(job, now()); job.reason = "來源分頁已關閉，工作已暫停。"; await save(); }
  })).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (!changes.url) return;
  ready.then(() => mutate(async () => {
    if (job?.status === "running" && tabId === job.sourceTabId) {
      if (!sameSource(changes.url, job.sourcePage || job.target.url)) { job = Jobs.pause(job, now()); job.reason = "來源頁面改變，工作已暫停。"; await save(); }
    }
  })).catch(() => {});
});
chrome.action.onClicked.addListener(async tab => {
  if (openingTabs.has(tab.id)) return;
  openingTabs.add(tab.id);
  try {
    const url = new URL(tab.url || "");
    if (!safeOrigin(url.href)) { await chrome.action.setBadgeText({ tabId: tab.id, text: "WEB" }); await chrome.action.setTitle({ tabId: tab.id, title: "請先開啟 Threads 網頁，再按此圖示。" }); return; }
    const runtimeIdentity = assertBuildVersion();
    const expectedSource = sourcePage(url.href), identity = await panelIdentity(tab.id);
    const version = runtimeIdentity.runtimeVersion, extensionId = runtimeIdentity.extensionId;
    if ((identity.hasProbe || identity.hasHost) && !compatiblePanel(identity, version, extensionId)) await reloadForPanelUpgrade(tab.id, expectedSource);
    await sourceTab(tab.id, expectedSource);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: tabId => { globalThis.__threadsProbeTabId = tabId; }, args: [tab.id] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["core.js", "content.js"] });
    await sourceTab(tab.id, expectedSource);
    if (!compatiblePanel(await panelIdentity(tab.id), version, extensionId)) throw new Error("面板與套件版本或來源不一致，請核對載入資料夾後重新載入擴充功能。");
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  } catch (error) {
    if (tab.id == null) return;
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" }); await chrome.action.setTitle({ tabId: tab.id, title: `無法開啟工具：${error.message}` });
  } finally { openingTabs.delete(tab.id); }
});
