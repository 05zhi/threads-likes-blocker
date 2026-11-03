/* Only an explicit panel command starts a blocking job. */
importScripts("core.js", "job.js", "request-probe-core.js", "parallel-runner.js");
const Core = globalThis.ThreadsProbeCore, Jobs = globalThis.ThreadsBlockJob;
const BUILD_VERSION = "0.6.2";
const JOB_KEY = "threadsBlocker.job.v1";
let job = null, runner = null, serial = Promise.resolve(), workerOwnership = null;
const openingTabs = new Set();
const now = () => new Date().toISOString();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ready = chrome.storage.local.get(JOB_KEY).then(async saved => {
  if (saved[JOB_KEY]) { job = Jobs.recover(saved[JOB_KEY], now()); job.workerTabId = null; job.parallelReady = false; if (job.directBatch) job.directBatchValidated = false; await save(); }
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
async function waitForProfile(tabId, username, taskId, oldDocumentToken = null) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (job?.id !== taskId || job.status !== "running") return false;
    const tab = await chrome.tabs.get(tabId);
    if (!safeOrigin(tab.url || "")) {
      if (tab.url && tab.url !== "about:blank") throw new Error("工作分頁離開 Threads，請檢查登入或驗證。");
    } else if (tab.status === "complete") {
      const profile = Core.profileFromHref(tab.url);
      if (!profile || profile.username.toLowerCase() !== username.toLowerCase()) throw new Error("個人檔案導向其他頁面，尚未封鎖。");
      if (oldDocumentToken) {
        const fresh = await chrome.scripting.executeScript({ target: { tabId }, func: token => document.readyState === 'complete' && globalThis.__threadsDirectDocumentToken !== token, args: [oldDocumentToken] });
        if (fresh.length !== 1 || fresh[0].result !== true) { await wait(250); continue; }
      }
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
async function beginRequestProbe(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['request-probe-core.js', 'request-probe.js'] });
  const response = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => globalThis.ThreadsRequestProbe.begin() });
  if (response.length !== 1 || response[0].result?.active !== true) throw new Error('請求觀察器未啟動，尚未執行驗證封鎖。');
}
async function finishRequestProbe(tabId) {
  const response = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => globalThis.ThreadsRequestProbe.finish() });
  if (response.length !== 1 || !response[0].result) throw new Error('Request probe unavailable');
  // Page-world output is untrusted; sanitize again before storing/exporting it.
  return globalThis.ThreadsRequestProbeCore.cleanReport(response[0].result);
}
async function directCall(tabId, method, args) {
  const response = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: (method, args) => globalThis.ThreadsDirectRequest?.[method](args), args: [method, args ?? null] });
  return response.length === 1 ? response[0].result : null;
}
function cleanDirectCapture(value) {
  const checks = {};
  for (const key of ['active', 'profileBinding', 'singleCandidate', 'operation', 'documentId', 'endpoint', 'bodyEncoding', 'uniqueBodyKeys', 'variableSchema', 'additionalFields', 'targetId', 'container', 'optionalContext']) {
    if (typeof value?.checks?.[key] === 'boolean') checks[key] = value.checks[key];
  }
  return { bodyFormat: ['urlencoded', 'urlsearchparams', 'formdata', 'unsupported'].includes(value?.bodyFormat) ? value.bodyFormat : 'unknown',
    candidateCount: Number.isInteger(value?.candidateCount) ? Math.min(100, Math.max(0, value.candidateCount)) : 0,
    variableFieldCount: Number.isInteger(value?.variableFieldCount) ? Math.min(10000, Math.max(0, value.variableFieldCount)) : 0,
    additionalVariableFieldCount: Number.isInteger(value?.additionalVariableFieldCount) ? Math.min(10000, Math.max(0, value.additionalVariableFieldCount)) : 0,
    checks, report: globalThis.ThreadsRequestProbeCore.cleanReport(value?.report) };
}
async function verifyDirectRequest(tabId, taskId, username, actorUsername, confirmationToken, requireReload = true) {
  let captured = false, attempted = false, triggered = false;
  const deferred = () => ({ status: 'deferred', reason: '直接請求送出前已暫停，尚未封鎖。', evidence: { finalActionAttempted: false } });
  const authorized = () => job?.id === taskId && job.current === username && job.status === 'running';
  try {
    await mutate(async () => { if (job?.id === taskId) { job.directCapture = null; job.directRequest = null; await save(); } });
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['request-probe-core.js', 'direct-request.js'] });
    if ((await directCall(tabId, 'arm', { username }))?.active !== true) throw new Error('直接請求驗證未啟動。');
    await assertSource(job);
    if (!authorized()) return deferred();
    triggered = true;
    const trigger = await adapter(tabId, { username, actorUsername, phase: 'capture', confirmationToken });
    if (trigger.status !== 'capture-triggered') return trigger;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const status = await directCall(tabId, 'status');
      if (status?.refused || status?.captured) {
        const diagnostics = cleanDirectCapture(status.diagnostics);
        await mutate(async () => { if (job?.id === taskId) { job.directCapture = diagnostics; await save(); } });
      }
      if (status?.refused) {
        const failed = Object.entries(cleanDirectCapture(status.diagnostics).checks).filter(([, value]) => !value).map(([key]) => key);
        return { status: 'needs-attention', reason: `請求檢查未通過：${failed.join('、') || 'unknown'}；未直接送出。` };
      }
      if (status?.captured) { captured = true; break; }
      await wait(100);
    }
    if (!captured) return { status: 'unknown', reason: '未確認攔截到網站請求，可能仍由原網站送出；不重送。' };
    await assertSource(job);
    await mutate(async () => { if (authorized()) { job.phase = 'direct-submitting'; await save(); } });
    if (!authorized()) return deferred();
    attempted = true; // A lost bridge response after dispatch is also unknown.
    const sent = await directCall(tabId, 'submit');
    const report = globalThis.ThreadsRequestProbeCore.cleanReport(sent?.report);
    const server = globalThis.ThreadsRequestProbeCore.blockEvidence(report, job?.directCapture?.report);
    const confirmed = sent?.attempted === true && sent?.accepted === true && server.confirmed;
    await mutate(async () => { if (job?.id === taskId) { job.directRequest = { attempted: sent?.attempted !== false, responseAccepted: sent?.accepted === true, serverConfirmed: confirmed, verifiedAfterReload: false, report }; await save(); } });
    if (!requireReload) return { status: confirmed ? 'success' : 'unknown', reason: confirmed ? '伺服器已確認相同目標帳號為已封鎖。' : '伺服器回應未確認相同目標已封鎖；已暫停且不會重試。', evidence: { directRequest: true, verifiedAfterReload: false, server } };
    // First direct block of a batch (and after every resume/restart) must also
    // survive a new document. Later records require the exact confirmed ID.
    const documentToken = crypto.randomUUID();
    await chrome.scripting.executeScript({ target: { tabId }, func: token => { globalThis.__threadsDirectDocumentToken = token; }, args: [documentToken] });
    await chrome.tabs.reload(tabId, { bypassCache: true });
    if (!await waitForProfile(tabId, username, taskId, documentToken)) return { status: 'unknown', reason: '直接提交後已暫停，尚未核對重新載入的結果。' };
    await chrome.scripting.executeScript({ target: { tabId }, files: ['core.js', 'block-adapter.js'] });
    const verified = await adapter(tabId, { username, actorUsername, phase: 'verify' });
    const success = confirmed && verified.status === 'success';
    await mutate(async () => { if (job?.id === taskId) { job.directRequest.verifiedAfterReload = success; if (success && job.directBatch) job.directBatchValidated = true; await save(); } });
    return { status: success ? 'success' : 'unknown', reason: success ? '直接請求已回應，且重新載入後確認已封鎖。' : '直接請求或重新載入核對未通過；不會重試。', evidence: { directRequest: true, verifiedAfterReload: success, server, diagnostics: verified.evidence?.diagnostics } };
  } finally {
    try { await directCall(tabId, 'dispose'); } catch {}
    // Discard the website's optimistic state after a held-but-unsent request.
    if (triggered && !attempted) {
      try { const tab = await chrome.tabs.get(tabId); if (Core.profileFromHref(tab.url)?.username.toLowerCase() === username.toLowerCase()) await chrome.tabs.reload(tabId, { bypassCache: true }); } catch {}
    }
  }
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
    await pauseParallel();
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
  runner = (job.parallelBatch ? runParallel() : run()).finally(() => { runner = null; if (job?.status === "running") kick(); });
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
  let firstProfile = true;
  try {
    while (job?.id === taskId && job.status === "running") {
      await mutate(async () => { job = Jobs.nextItem(job, now()); await save(); });
      if (job.status !== "running" || !job.current) break;
      const username = job.current, actorUsername = job.actorUsername;
      let submitted = false, result, probeTabId = null;
      try {
        await assertSource(job);
        let tabId = job.workerTabId;
        if (Number.isInteger(tabId)) {
          if (workerOwnership?.tabId !== tabId || workerOwnership?.jobId !== taskId) tabId = null;
          else {
            const tab = await chrome.tabs.get(tabId), profile = Core.profileFromHref(tab.url);
            if (!profile || !job.items.some(a => a.username.toLowerCase() === profile.username.toLowerCase())) throw new Error("工作分頁已變更，請人工核對。");
            if (!firstProfile && tab.active === false) {
              await mutate(async () => {
                if (job.id !== taskId || job.current !== username) return;
                job = job.status === 'stopped' ? Jobs.recordResult(job, username, { status: 'skipped', reason: '中止前尚未送出最後確認。' }, now()) : Jobs.deferPrepared(job, username, '工作分頁已切到背景，請回來源面板按繼續。', now());
                await save();
              });
              break;
            }
          }
        }
        if (!Number.isInteger(tabId)) {
          const tab = await chrome.tabs.create({ url: `https://www.threads.com/@${username}`, active: true });
          tabId = tab.id; workerOwnership = { tabId, jobId: taskId }; job.workerTabId = tabId; await save();
        } else await chrome.tabs.update(tabId, { url: `https://www.threads.com/@${username}`, ...(firstProfile ? { active: true } : {}) });
        firstProfile = false;
        if (!await waitForProfile(tabId, username, taskId)) { await defer(username); break; }
        await chrome.scripting.executeScript({ target: { tabId }, files: ["core.js", "block-adapter.js"] });
        if (job.requestProbeEnabled) { await beginRequestProbe(tabId); probeTabId = tabId; }
        result = await adapter(tabId, { username, actorUsername, phase: "prepare" });
        if (result.status === 'prepared' && (job.directRequestTest || job.directBatch)) {
          submitted = true;
          result = await verifyDirectRequest(tabId, taskId, username, actorUsername, result.confirmationToken, !job.directBatch || !job.directBatchValidated);
        } else if (result.status === "prepared") {
          await assertSource(job);
          const maySubmit = await mutate(async () => {
            if (job.id !== taskId || job.current !== username || job.status !== "running") return false;
            job.phase = "confirming"; job.updatedAt = now(); await save(); return true;
          });
          if (!maySubmit || job.status !== "running") { await defer(username); break; }
          submitted = true;
          result = await adapter(tabId, { username, actorUsername, phase: "confirm", confirmationToken: result.confirmationToken });
        }
        if (result.status === 'deferred' && result.evidence?.finalActionAttempted === false) {
          await mutate(async () => {
            if (job?.id !== taskId || job.current !== username) return;
            job = job.status === 'stopped'
              ? Jobs.recordResult(job, username, { status: 'skipped', reason: '中止前尚未送出最後確認。' }, now())
              : Jobs.deferPrepared(job, username, result.reason, now());
            job.phase = null; await save();
          });
          break;
        }
        if (!["success", "already-blocked", "skipped", "failed", "unknown", "needs-attention"].includes(result.status)) result = { status: submitted ? "unknown" : "needs-attention", reason: "適配器狀態無法辨識，已暫停。" };
      } catch (error) { result = { status: submitted ? "unknown" : "needs-attention", reason: `${submitted ? "確認可能已送出，請人工核對" : "尚未送出最後確認"}：${error.message}` }; }
      finally {
        if (probeTabId !== null) {
          let report;
          try { report = await finishRequestProbe(probeTabId); }
          catch { report = { ...globalThis.ThreadsRequestProbeCore.cleanReport(null), unavailable: true }; }
          await mutate(async () => { if (job?.id === taskId) { job.requestProbe = report; await save(); } });
        }
      }
      await mutate(async () => {
        if (job?.id === taskId && job.current === username) { job = Jobs.recordResult(job, username, result, now()); job.phase = null; await save(); }
      });
      if (job.status === "running") await wait(job.directBatch ? 1000 : 3000);
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
        const nextJob = Jobs.createJob({ accounts: message.accounts, target: message.target, includeAuthor: message.includeAuthor, actorUsername: message.actorUsername, sourceTabId: sender.tab.id }, now());
        if (message.probeRequest !== undefined && typeof message.probeRequest !== 'boolean') throw new Error('請求驗證選項無效。');
        if (message.probeRequest === true && nextJob.items.length !== 1) throw new Error('請求驗證一次只處理一個已確認帳號。');
        if (message.directRequestTest !== undefined && typeof message.directRequestTest !== 'boolean') throw new Error('直接請求驗證選項無效。');
        if (message.directRequestTest === true && (nextJob.items.length !== 1 || message.probeRequest === true)) throw new Error('直接請求驗證只允許單一帳號，不能同時開啟觀察模式。');
        if (message.directBatch !== undefined && typeof message.directBatch !== 'boolean') throw new Error('直接批次選項無效。');
        if (message.directBatch === true && (message.directRequestTest === true || message.probeRequest === true)) throw new Error('批次工作不能同時啟用單人診斷模式。');
        if (message.parallelBatch !== undefined && typeof message.parallelBatch !== 'boolean') throw new Error('背景並行選項無效。');
        if (message.parallelBatch && (message.directBatch || message.directRequestTest || message.probeRequest)) throw new Error('背景並行不能同時啟用其他模式。');
        if (message.parallelBatch) {
          const previouslyDone = new Set(job?.actorUsername?.toLowerCase() === nextJob.actorUsername.toLowerCase() ? job.items.filter(row => ['success','already-blocked'].includes(row.status)).map(row => row.username.toLowerCase()) : []);
          nextJob.parallelSeed = nextJob.items.find(row => !previouslyDone.has(row.username.toLowerCase()))?.username;
          nextJob.parallelBatch = true; nextJob.parallelReady = false; nextJob.executionMode = 'background-parallel'; nextJob.concurrency = nextJob.items.length;
        }
        job = nextJob;
        if (message.probeRequest === true) { job.requestProbeEnabled = true; job.executionMode = 'ui-request-probe'; }
        if (message.directRequestTest === true) { job.directRequestTest = true; job.executionMode = 'single-direct-verification'; }
        if (message.directBatch === true) { job.directBatch = true; job.directBatchValidated = false; job.executionMode = 'direct-batch'; }
        job.sourcePage = sourcePage(sender.tab.url);
        job.extensionVersion = identity.runtimeVersion;
        job.buildVersion = identity.buildVersion; job.runtimeVersion = identity.runtimeVersion;
        job.extensionId = identity.extensionId; job.clientPanelVersion = message.panelVersion;
        await save(); kick();
      } else {
        if (!job) throw new Error("目前沒有封鎖工作。");
        if (message.type === "BLOCK_PAUSE") { job = Jobs.pause(job, now()); await pauseParallel(); }
        else if (message.type === "BLOCK_STOP") { job = Jobs.stop(job, now()); await pauseParallel(); }
        else if (message.type === "BLOCK_RESUME") {
          if (typeof message.jobId !== "string" || message.jobId !== job.id) throw new Error("原封鎖工作已變更，請重新核對目前工作後再繼續。");
          if (!sameSource(sender.tab.url, job.sourcePage || job.target.url) || String(message.actorUsername || "").trim().replace(/^@/, "").toLowerCase() !== job.actorUsername.toLowerCase()) throw new Error("請回原來源頁面，並確認目前登入的仍是原帳號後繼續。");
          job = Jobs.resume(job, now()); if (job.parallelBatch) job.concurrency = job.items.length; job.sourceTabId = sender.tab.id; if (job.directBatch) job.directBatchValidated = false;
          job.buildVersion = identity.buildVersion; job.runtimeVersion = identity.runtimeVersion;
          job.extensionId = identity.extensionId; job.clientPanelVersion = message.panelVersion;
        } else throw new Error("無法辨識工作指令。");
        await save(); if (job.status === "running") kick();
        if (job.status === "stopped" && !runner) { if(job.parallelBatch){try{await directCall(job.workerTabId,'dispose');}catch{}} await closeWorker(job); }
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
    else if (tabId === job.sourceTabId) { job = Jobs.pause(job, now()); await pauseParallel(); job.reason = "來源分頁已關閉，工作已暫停。"; await save(); }
  })).catch(() => {});
});
chrome.tabs.onActivated?.addListener(() => {
  ready.then(async () => {
    const taskId = job?.id, workerId = job?.workerTabId;
    if (job?.status !== 'running' || job.parallelReady || !Number.isInteger(workerId)) return;
    const worker = await chrome.tabs.get(workerId);
    if (worker.active !== false) return;
    await mutate(async () => {
      if (job?.id !== taskId || job.workerTabId !== workerId || job.status !== 'running') return;
      job = Jobs.pause(job, now());
      await pauseParallel();
      job.reason = '已離開工作分頁，封鎖暫停；請回來源面板按繼續。';
      await save();
    });
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (!changes.url) return;
  ready.then(() => mutate(async () => {
    if (job?.status === "running" && tabId === job.sourceTabId) {
      if (!sameSource(changes.url, job.sourcePage || job.target.url)) { job = Jobs.pause(job, now()); await pauseParallel(); job.reason = "來源頁面改變，工作已暫停。"; await save(); }
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
