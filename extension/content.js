/* Collector reads DOM; explicit user-confirmed blocking runs in the background. */
(() => {
  "use strict";
  const EXTENSION_VERSION = "0.4.9";
  const EXTENSION_ID = chrome.runtime?.id || "";
  const RUNTIME_VERSION = chrome.runtime?.getManifest?.()?.version || EXTENSION_VERSION;
  if (RUNTIME_VERSION !== EXTENSION_VERSION) throw new Error("套件與面板版本不一致，請重新載入擴充功能。");
  if (globalThis.__threadsLikesProbe) {
    if (globalThis.__threadsLikesProbe.version !== EXTENSION_VERSION || globalThis.__threadsLikesProbe.extensionId !== EXTENSION_ID) throw new Error("頁面仍有舊版工具，請按擴充功能圖示重新開啟。");
    globalThis.__threadsLikesProbe.show();
    return;
  }
  if (document.getElementById("threads-likes-probe-host")) throw new Error("頁面仍有另一份工具面板，請按擴充功能圖示重新開啟。");
  const Core = globalThis.ThreadsProbeCore;
  if (!Core) throw new Error("Missing probe core");
  if (!Number.isInteger(globalThis.__threadsProbeTabId)) throw new Error("Missing toolbar tab context");
  const STORE_KEY = `threadsLikesProbe.snapshot.v1.tab.${globalThis.__threadsProbeTabId}`;
  const host = document.createElement("div");
  host.id = "threads-likes-probe-host";
  host.dataset.panelVersion = EXTENSION_VERSION;
  host.dataset.extensionId = EXTENSION_ID;
  host.style.cssText = "all:initial;position:fixed;inset:0 0 0 auto;width:380px;max-width:95vw;height:100vh;z-index:2147483647;pointer-events:auto;color-scheme:light;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host{font:14px/1.55 system-ui,-apple-system,'Microsoft JhengHei',sans-serif;color:#17212e}
      *{box-sizing:border-box} .panel{font:14px/1.55 system-ui,-apple-system,'Microsoft JhengHei',sans-serif;color:#17212e;height:100%;display:flex;flex-direction:column;background:#f5f7fb;box-shadow:-4px 0 24px #0002;border-left:1px solid #dce2ec}
      header{background:#182b49;color:white;padding:16px 18px;display:flex;justify-content:space-between;align-items:center}
      h1{font-size:17px;margin:0} .sub{font-size:12px;color:#c8d7ec} main{overflow:auto;flex:1;padding:16px}
      section{display:block;background:white;border:1px solid #dce2ec;border-radius:12px;padding:14px;margin-bottom:12px}
      h2{font-size:14px;margin:0 0 10px} p{margin:6px 0} small,.hint{font-size:12px;color:#536177}.warning{background:#fff7e6;border-color:#e8ca82}
      label{display:block;margin:10px 0 5px;font-size:13px} input[type=text],input[type=url],select{width:100%;border:1px solid #b8c4d5;border-radius:7px;padding:8px;background:white;color:#17212e;font:inherit}
      input[type=checkbox]{margin:0 6px 0 0;vertical-align:middle} .check{display:flex;align-items:flex-start;gap:5px} .check input{margin-top:4px;flex:none}
      button{font:inherit;border:1px solid #c4cedc;border-radius:7px;padding:8px 11px;background:white;color:#243852;cursor:pointer}button:disabled{opacity:.45;cursor:default}button.primary{background:#235bc9;border-color:#235bc9;color:white}button.danger{color:#b22b32}
      .buttons{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}header button{background:transparent;color:white;border:0;font-size:20px;padding:0 5px}
      #status{font-weight:650}#reason,#progress{font-size:12px;color:#536177}#blockStatus,#sourceInfo{white-space:pre-line;overflow-wrap:anywhere} .count{font-size:30px;font-weight:750;color:#235bc9}#accounts{max-height:300px;overflow:auto;margin-top:10px}
      .account{padding:7px 0;border-top:1px solid #edf0f5;overflow-wrap:anywhere}.account a{color:#204fad;text-decoration:none}.account small{display:block}footer{padding:10px 16px;border-top:1px solid #dce2ec;background:white;font-size:11px;color:#536177}
      #notice{padding:9px 12px;background:#fff1cf;border-radius:6px;margin-bottom:12px;white-space:pre-wrap;font-size:12px}#notice:empty{display:none}
      [hidden]{display:none!important} .step{display:inline-grid;place-items:center;width:23px;height:23px;background:#e9efff;color:#235bc9;border-radius:50%;margin-right:7px;font-size:12px}details{margin-top:12px;border-top:1px solid #edf0f5;padding-top:10px}summary{cursor:pointer;color:#536177;font-size:12px}summary:hover{color:#235bc9}#sourceInfo{background:#f3f6fb;border-radius:8px;padding:10px;margin:0}#actorInfo{font-size:12px;color:#536177}#blockStart{width:100%;padding:11px;font-weight:650}#selectionSummary{font-weight:650}.collection-summary{display:flex;align-items:center;justify-content:space-between;gap:10px}.collection-summary .count{line-height:1.2}.muted-count{font-size:12px;color:#536177}#blockResults{max-height:260px;overflow:auto}#listControls{margin-top:12px}#sourceStep h2,#collectionStep h2,#blockingStep h2{display:flex;align-items:center}
    </style>
    <div class="panel">
      <header><div><h1>Threads 封鎖工具（修正版）</h1><div id="buildInfo" class="sub"></div></div><button id="close" title="關閉並暫停">×</button></header>
      <main>
        <div id="notice" role="status" aria-live="polite"></div>
        <section id="workBanner" class="warning" hidden><strong>有暫停中的封鎖工作</strong><p class="hint">請繼續或中止原工作。要重新收集或重新選名單，請先中止舊工作。</p><button id="blockReturn" class="danger">中止舊工作並回到名單</button></section>
        <section id="sourceStep"><h2><span class="step">1</span>選擇目標與名單</h2>
          <input id="target" type="hidden"><p id="sourceInfo">正在辨識目前頁面…</p><div class="buttons"><button id="pickTarget">更換目標</button><button id="cancelTarget" hidden>取消</button></div>
          <p class="hint">在 Threads 開啟這則內容的「查看動態 → 按讚」，再選擇名單區域。</p>
          <div class="buttons"><button id="pick">選擇名單區域</button><button id="cancelPick" hidden>取消選擇</button></div>
          <p id="scopeInfo" class="hint">尚未選擇</p>
          <label class="check"><input id="scopeConfirmed" type="checkbox"><span>已核對目標，橘框只包含這則內容的按讚名單。</span></label>
        </section>
        <section id="collectionStep"><h2><span class="step">2</span>收集並檢查名單</h2><div class="collection-summary"><div><div id="status" aria-live="polite">尚未開始</div><div id="progress" aria-live="polite"></div></div><div><span id="count" class="count">0</span><div class="muted-count">個按讚帳號</div></div></div><div id="reason"></div>
          <div class="buttons"><button id="start" class="primary">開始新收集</button><button id="pause" disabled>暫停</button><button id="resume" disabled>繼續</button><button id="review" disabled>結束並檢查名單</button><button id="stop" class="danger" disabled>中止收集</button></div>
          <p class="hint">可隨時結束並檢查已收集帳號。約 15 秒沒有新增便保留結果；不可見帳號可能不在名單中。</p>
          <div id="listControls" hidden><details><summary>搜尋與調整選取</summary><label for="search">搜尋帳號</label><input id="search" type="text" placeholder="帳號或名稱"><div class="buttons"><button id="selectAll">全選按讚帳號</button><button id="selectNone">全部取消</button></div></details><div id="accounts"></div><div id="pagination" class="buttons"><button id="prevPage">上一頁</button><span id="pageInfo" class="hint"></span><button id="nextPage">下一頁</button></div></div>
        </section>
        <section id="blockingStep" hidden><h2><span class="step">3</span>確認並封鎖</h2>
          <p id="actorInfo" aria-live="polite">正在確認登入帳號…</p><button id="refreshActor" hidden>重新確認登入</button><p id="backgroundWarning" class="hint" role="status" hidden></p><p id="selectionSummary"></p>
          <details id="authorOptions"><summary>作者封鎖選項</summary><p id="authorInfo" class="hint">請先收集名單。</p><label class="check"><input id="includeAuthor" type="checkbox"><span>同時封鎖這則內容的作者</span></label></details>
          <label id="blockApproval" class="check"><input id="blockConfirmed" type="checkbox"><span>我已檢查勾選名單，確認要封鎖這些帳號。</span></label>
          <div class="buttons"><button id="blockStart" class="primary">一鍵封鎖已選名單</button><button id="blockPause">暫停封鎖</button><button id="blockResume">繼續封鎖</button><button id="blockStop" class="danger">中止封鎖</button></div>
          <div id="blockStatus" role="status" aria-live="polite">尚無封鎖工作</div><div id="blockResults"></div>
          <p class="hint">開始／繼續時會切換到工作分頁，請保持它在前景。切回來源分頁會暫停，可在這裡繼續或中止。</p>
          <details id="requestProbeTools"><summary>驗證快速封鎖方法</summary><p class="hint">只選一個尚未封鎖的帳號並完成名單確認。直接請求測試會保留網站產生的同一筆封鎖內容，改由工具提交一次，再重新載入核對。測試會真的封鎖此人；目前尚未開放快速批次。</p><button id="directStart">驗證直接請求並封鎖此帳號</button><button id="probeStart">僅用網頁封鎖並記錄請求</button><p id="probeStatus" class="hint" role="status"></p></details>
          <p class="hint">會更改 Threads 帳號狀態。暫停／中止不撤銷已完成封鎖；結果不明不會自動重試。</p>
        </section>
        <details id="tools"><summary>匯出與本機紀錄</summary><div class="buttons"><button id="diagnostics">匯出完整診斷 JSON</button><button id="json">匯出名單 JSON</button><button id="csv">匯出 CSV</button><button id="blockExport">匯出封鎖紀錄</button><button id="clear" class="danger">清除名單</button></div></details>
      </main><footer>本機紀錄 · 不讀取密碼或 Cookie · 使用 Threads 網頁操作封鎖</footer>
    </div>`;
  document.documentElement.appendChild(host);
  const $ = (id) => shadow.getElementById(id);
  $("buildInfo").textContent = `${EXTENSION_VERSION} · 套件 ${RUNTIME_VERSION}`;
  $("buildInfo").title = `擴充功能 ID：${EXTENSION_ID}`;
  const labels = { idle: "尚未開始", collecting: "收集中", paused: "已暫停", stopped: "已中止", ended: "收集已結束", restored: "已還原上次紀錄（不會自動繼續）" };
  let state = freshState(), scope = null, scopePage = "", outline = null, picking = false, pickingTarget = false;
  let generation = 0, observer = null, sampleTimer = null, saveTimer = null, saveChain = Promise.resolve();
  let changeRevision = 0, runningSince = 0, scopeSignature = "", listPage = 0, blockJob = null, blockRequest = false, commandRevision = 0, pauseAfterRequest = false;
  let samplePromise = null, sampleGeneration = null, scanCursor = 0, lastGrowthAt = 0, renderTimer = null, outlineFrame = null, pickedSourcePage = null;
  let detectedActor = "", actorError = "", actorPromise = null, actorChecking = false;
  let backgroundIdentity = null;
  function compatibleBackground(value = backgroundIdentity) { return value?.buildVersion === EXTENSION_VERSION && value?.runtimeVersion === RUNTIME_VERSION && value?.extensionId === EXTENSION_ID; }
  function readBackgroundIdentity(value) { backgroundIdentity = { buildVersion: value?.buildVersion || null, runtimeVersion: value?.runtimeVersion || null, extensionId: value?.extensionId || null }; if (!compatibleBackground()) $("blockConfirmed").checked = false; }
  function freshState() { return { schemaVersion: 1, extensionVersion: EXTENSION_VERSION, mode: "read-only-probe", status: "idle", reason: "", completeness: "unknown", liveCompatibility: "not-verified", target: null, accounts: [], blockSelection: [], diagnostics: [], startedAt: null, updatedAt: null, finishedAt: null, scrollPasses: 0, scopeEvidence: null, limits: { maxAccounts: 10000, maxRunMs: 120000, noGrowthMs: 15000 } }; }
  function notice(text = "") { $("notice").textContent = text; }
  function pageIdentity() { return Core.sourcePage?.(location.href) || `${location.origin}${location.pathname}${location.search}${location.hash}`; }
  function detectedTarget() {
    return Core.canonicalTarget(location.href) || Core.canonicalTarget(document.querySelector('link[rel="canonical"]')?.getAttribute("href"), location.href);
  }
  function resetApprovals() { $("scopeConfirmed").checked = false; $("includeAuthor").checked = false; $("blockConfirmed").checked = false; }
  function setDetectedTarget(target, summary = "", picked = false) {
    const changed = $("target").value !== (target?.url || "");
    $("target").value = target?.url || "";
    $("sourceInfo").textContent = target ? `${picked ? "已選定" : "已自動辨識"} @${target.username}${summary ? `\n${summary.slice(0, 180)}` : ""}` : "未辨識到單一目標。按「更換目標」，再點這則內容。";
    $("sourceInfo").title = target?.url || "";
    if (changed) { resetApprovals(); scope = null; scopeSignature = ""; outline?.remove(); outline = null; $("scopeInfo").textContent = "尚未選擇"; }
    if (picked) pickedSourcePage = pageIdentity();
  }
  function sourceFromElement(element) {
    if (!(element instanceof Element)) return null;
    for (let node = element, depth = 0; node && node !== document.body && depth < 14; node = node.parentElement, depth++) {
      if (node === host) return null;
      const links = [...(node.matches("a[href]") ? [node] : []), ...node.querySelectorAll("a[href]")];
      const targets = new Map();
      for (const link of links) {
        if (!link.querySelector("time")) continue;
        const target = Core.canonicalTarget(link.getAttribute("href"), location.href);
        if (target && isVisible(link)) targets.set(target.url, target);
      }
      if (targets.size === 1) return { target: [...targets.values()][0], summary: node.innerText.trim().slice(0, 180) };
      if (targets.size > 1) return null;
    }
    return null;
  }
  function cancelTargetPicking() {
    pickingTarget = false; document.removeEventListener("click", pickTargetClick, true); document.removeEventListener("keydown", pickTargetKey, true);
    $("cancelTarget").hidden = true; render();
  }
  function pickTargetKey(event) { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); cancelTargetPicking(); notice("已取消來源選擇。"); } }
  function pickTargetClick(event) {
    if (event.composedPath().includes(host)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const found = sourceFromElement(event.target);
    if (!found) return notice("未能唯一辨識這張卡片。請點目標的正文或時間，不要點整個串文外框。");
    setDetectedTarget(found.target, found.summary, true); cancelTargetPicking(); notice("來源已取得。請開啟這則內容的按讚名單，再選擇名單區域。");
  }
  $("pickTarget").onclick = () => {
    cancelPicking(); pickingTarget = true; $("cancelTarget").hidden = false; notice("請點目標貼文／留言的正文或時間。這次點擊只選擇來源，不會導向頁面。");
    document.addEventListener("click", pickTargetClick, true); document.addEventListener("keydown", pickTargetKey, true); render();
  };
  $("cancelTarget").onclick = () => { cancelTargetPicking(); notice("已取消來源選擇。"); };
  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }
  function accountsIn(root, maxLinks = 200) {
    const result = [], links = root.querySelectorAll("a[href]");
    for (let index = 0; index < Math.min(links.length, maxLinks); index++) {
      const link = links[index];
      if (!isVisible(link)) continue;
      const account = Core.profileFromHref(link.getAttribute("href"), location.href);
      if (!account) continue;
      const author = Core.canonicalTarget($("target").value)?.username || state.target?.username;
      if (author && account.username.toLowerCase() === author.toLowerCase()) continue;
      result.push({ ...account, label: (link.innerText || link.getAttribute("aria-label") || "").trim().slice(0, 160) });
    }
    return result;
  }
  function samePage() { return pageIdentity() === scopePage; }
  function contextLabel(element) {
    const value = element.textContent.trim().slice(0, 160);
    // Strip counts only from known activity labels. Digits in usernames remain identity evidence.
    return value.replace(/^(likes?|按讚|赞|讚|喜歡|喜欢)\s*[（(]?\s*\d[\d,.\s]*(?:[kKmM萬千])?\s*[)）]?$/i, "$1");
  }
  function contextSignature() {
    if (!scope) return "";
    const context = scope.closest('[role="dialog"]') || scope.parentElement;
    if (!context) return "";
    const items = [...context.querySelectorAll('h1,h2,h3,[role="heading"],[role="tab"],[aria-selected="true"]')].slice(0, 60).filter(element => {
      if (!isVisible(element)) return false;
      if (scope !== context && scope.contains(element)) return false;
      if (scope.contains(element) && element.closest('[role="listitem"],a[href]')) return false;
      return true;
    }).map(element => [element.tagName, element.getAttribute('role'), element.getAttribute('aria-selected'), contextLabel(element)]);
    return JSON.stringify(items);
  }
  function validScope() { return scope && scope !== document.body && scope !== document.documentElement && isVisible(scope) && samePage() && (!scopeSignature || contextSignature() === scopeSignature); }
  function drawOutline() {
    if (!scope) return;
    const r = scope.getBoundingClientRect();
    if (!outline) {
      outline = document.createElement("div"); outline.id = "threads-likes-probe-outline"; outline.setAttribute("aria-hidden", "true");
      outline.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;border:6px solid #ff6a00;border-radius:8px;background:rgba(255,106,0,.09);box-shadow:0 0 0 2px white,0 0 0 4px #111,0 0 26px #ff6a0080;";
      const label = document.createElement("div"); label.textContent = "已選按讚名單區域"; label.style.cssText = "position:absolute;top:-34px;left:0;background:#ff6a00;color:#111;border:2px solid white;border-radius:6px;padding:3px 8px;font:bold 13px/1.5 system-ui,sans-serif;box-shadow:0 1px 4px #0008;"; outline.append(label); document.documentElement.appendChild(outline);
    }
    Object.assign(outline.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    outline.firstElementChild.style.top = r.top >= 36 ? "-34px" : `${r.height + 6}px`;
  }
  function followOutline() { if (!outlineFrame) outlineFrame = requestAnimationFrame(() => { outlineFrame = null; if (scope?.isConnected && host.style.display !== "none") drawOutline(); }); }
  window.addEventListener("scroll", followOutline, { capture: true, passive: true }); window.addEventListener("resize", followOutline, { passive: true });
  function render() {
    $("buildInfo").textContent = `${EXTENSION_VERSION} · 套件 ${RUNTIME_VERSION} · 背景 ${backgroundIdentity?.buildVersion || "未確認"}`;
    $("backgroundWarning").hidden = !backgroundIdentity || compatibleBackground();
    $("backgroundWarning").textContent = `目前背景 ${backgroundIdentity?.buildVersion || "舊版／未確認"} 與面板 ${EXTENSION_VERSION} 不同。請重新載入「Threads 封鎖工具（修正版）」，再開啟此面板。`;
    $("status").textContent = labels[state.status] || state.status;
    $("reason").textContent = state.reason;
    $("count").textContent = state.accounts.length.toLocaleString();
    const active = state.status === "collecting", blocking = !!blockJob && (["running", "paused"].includes(blockJob.status) || !!blockJob.current), held = active || state.status === "paused";
    $("workBanner").hidden = blockJob?.status !== "paused";
    $("blockReturn").disabled = blockJob?.status !== "paused" || blockRequest;
    for (const id of ["target", "scopeConfirmed", "pick", "pickTarget"]) $(id).disabled = held || blocking || blockRequest || actorChecking;
    $("start").disabled = held || picking || pickingTarget || blocking || blockRequest || actorChecking;
    $("pause").disabled = !active;
    $("resume").disabled = state.status !== "paused";
    $("stop").disabled = !held;
    $("review").disabled = !held;
    $("start").hidden = held || blocking;
    $("pause").hidden = !active;
    $("resume").hidden = state.status !== "paused";
    $("review").hidden = !held;
    $("stop").hidden = !held;
    $("clear").disabled = held || blocking || blockRequest || actorChecking;
    $("json").disabled = !state.target;
    $("csv").disabled = !state.target;
    $("diagnostics").disabled = !state.target && !blockJob;
    const selected = new Set(state.blockSelection || []), query = $("search").value.trim().toLowerCase();
    const rows = state.accounts.filter(a => `${a.username} ${a.label}`.toLowerCase().includes(query));
    const pages = Math.max(1, Math.ceil(rows.length / 100)); listPage = Math.min(listPage, pages - 1);
    $("listControls").hidden = !state.accounts.length;
    $("pagination").hidden = pages < 2;
    $("blockingStep").hidden = !state.accounts.length && !blockJob;
    const list = $("accounts"); list.replaceChildren();
    for (const account of rows.slice(listPage * 100, (listPage + 1) * 100)) {
      const row = document.createElement("div"); row.className = "account";
      const check = document.createElement("input"); check.type = "checkbox"; check.checked = selected.has(account.username.toLowerCase()); check.disabled = held || blocking || blockRequest || actorChecking; check.setAttribute("aria-label", `選取 @${account.username}`);
      check.onchange = () => { const set = new Set(state.blockSelection); if (check.checked) set.add(account.username.toLowerCase()); else set.delete(account.username.toLowerCase()); state.blockSelection = [...set]; $("blockConfirmed").checked = false; scheduleSave(); render(); };
      const link = document.createElement("a"); link.href = account.profileUrl; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = `@${account.username}`;
      const sub = document.createElement("small"); sub.textContent = account.label || "";
      row.append(check, link, sub); list.append(row);
    }
    $("pageInfo").textContent = `${listPage + 1} / ${pages} 頁，共 ${rows.length} 筆`;
    $("prevPage").disabled = listPage === 0; $("nextPage").disabled = listPage >= pages - 1;
    for (const id of ["selectAll", "selectNone", "includeAuthor", "blockConfirmed"]) $(id).disabled = held || blocking || blockRequest || actorChecking;
    $("authorInfo").textContent = state.target ? `來源作者：@${state.target.username}。作者已從按讚名單移除，僅依下方選項額外加入。` : "請先收集名單。";
    $("actorInfo").textContent = detectedActor ? `登入帳號 @${detectedActor} · 自動排除自己` : actorError || "正在確認登入帳號…";
    $("refreshActor").hidden = !!detectedActor || !actorError;
    $("refreshActor").disabled = actorChecking || blockRequest;
    const actor = detectedActor.toLowerCase(), likers = state.accounts.filter(a => selected.has(a.username.toLowerCase()) && a.username.toLowerCase() !== actor);
    const extraAuthor = $("includeAuthor").checked && state.target && state.target.username.toLowerCase() !== actor;
    $("selectionSummary").textContent = `已選 ${likers.length} 個按讚帳號${extraAuthor ? " ＋ 1 位作者" : ""}；登入的自己會排除。`;
    $("blockStart").disabled = !compatibleBackground() || !detectedActor || actorChecking || !state.target || state.target.url !== $("target").value || held || blocking || blockRequest || !(likers.length + (extraAuthor ? 1 : 0));
    $("blockStart").textContent = `一鍵封鎖 ${likers.length + (extraAuthor ? 1 : 0)} 個帳號`;
    $("probeStart").disabled = $("blockStart").disabled || likers.length + (extraAuthor ? 1 : 0) !== 1;
    $("directStart").disabled = $("probeStart").disabled;
    $("requestProbeTools").hidden = blocking && !blockJob?.requestProbeEnabled && !blockJob?.directRequestTest;
    $("probeStatus").textContent = blockJob?.directRequest
      ? blockJob.directRequest.verifiedAfterReload ? '此帳號直接提交及重新載入核對已通過。請匯出完整診斷 JSON，尚未啟用快速批次。' : '直接請求尚未通過完整核對。請匯出完整診斷 JSON；不會自動重試。'
      : blockJob?.directRequestTest ? blockJob.status === 'running' ? '單一帳號直接請求驗證中。' : '尚未確認直接提交，請匯出完整診斷 JSON 查看檢查結果。' : blockJob?.requestProbe
      ? `已記錄 ${blockJob.requestProbe.records?.length || 0} 筆候選請求。請匯出完整診斷 JSON；尚未確認直接請求可用或作用範圍。`
      : blockJob?.requestProbeEnabled ? '請求驗證中；仍使用網頁操作。' : '';
    $("blockPause").disabled = blockJob?.status !== "running" || blockRequest;
    $("blockResume").disabled = !compatibleBackground() || !detectedActor || actorChecking || blockJob?.status !== "paused" || !!blockJob?.current || blockRequest || !blockJob?.items.some(a => a.status === "pending");
    $("blockStop").disabled = !blocking || blockRequest;
    $("blockStart").hidden = blocking;
    $("blockApproval").hidden = blocking;
    $("authorOptions").hidden = blocking;
    $("blockPause").hidden = blockJob?.status !== "running";
    $("blockResume").hidden = blockJob?.status !== "paused";
    $("blockStop").hidden = !blocking;
    $("blockExport").disabled = !blockJob;
    const names = { running: "封鎖執行中", paused: "封鎖已暫停", stopped: "封鎖已中止", completed: "佇列已處理完畢（請核對逐筆結果）" };
    const statuses = { pending: "等待", "in-progress": "處理中", success: "封鎖成功", "already-blocked": "已封鎖，略過", skipped: "略過", failed: "失敗", unknown: "結果不明", "needs-attention": "需人工檢查", cancelled: "已取消" };
    $("blockStatus").textContent = blockJob ? `${names[blockJob.status] || blockJob.status} · ${blockJob.items.filter(a => !["pending", "in-progress"].includes(a.status)).length}/${blockJob.items.length} · 登入 @${blockJob.actorUsername}${blockJob.current ? ` · 目前 @${blockJob.current}` : ""}${blockJob.extensionVersion ? `\n工作版本：${blockJob.extensionVersion}${blockJob.extensionVersion !== RUNTIME_VERSION ? "（舊工作紀錄）" : ""}` : ""}\n來源：${blockJob.target.url}\n${blockJob.reason || ""}` : "尚無封鎖工作";
    const resultList = $("blockResults"); resultList.replaceChildren();
    if (blockJob) for (const item of blockJob.items.filter(a => a.status !== "pending").slice(-100)) {
      const row = document.createElement("div"); row.className = "account"; row.textContent = `@${item.username}${item.role === "author" ? "（作者）" : ""}：${statuses[item.status] || item.status}`;
      const detail = document.createElement("small"); detail.textContent = item.reason || ""; row.append(detail); resultList.append(row);
    }
  }
  function persistNow() {
    clearTimeout(saveTimer); saveTimer = null; state.updatedAt = new Date().toISOString();
    const snapshot = JSON.parse(JSON.stringify(state));
    saveChain = saveChain.catch(() => {}).then(() => chrome.storage.local.set({ [STORE_KEY]: snapshot })).catch(() => notice("本機儲存失敗。請立即匯出目前資料；不要依賴重開後還原。"));
    return saveChain;
  }
  function scheduleSave() { if (!saveTimer) saveTimer = setTimeout(persistNow, 1000); }
  function requestRender() { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 150); }
  function disconnect() { generation++; observer?.disconnect(); observer = null; clearTimeout(sampleTimer); sampleTimer = null; clearTimeout(renderTimer); renderTimer = null; }
  function finish(status, reason) {
    disconnect(); state.status = status; state.reason = reason;
    if (["ended", "stopped"].includes(status)) state.finishedAt = new Date().toISOString();
    persistNow(); render();
  }
  async function sample(token = generation) {
    if (samplePromise) {
      const priorGeneration = sampleGeneration; await samplePromise;
      if (priorGeneration !== token && token === generation && state.status === "collecting") return sample(token);
      return;
    }
    if (state.status !== "collecting" || token !== generation) return;
    sampleGeneration = token;
    samplePromise = (async () => {
      if (!validScope()) { finish("paused", "名單關閉、活動或來源頁面已切換。可按「結束並檢查名單」保留目前結果。"); return; }
      const links = scope.querySelectorAll("a[href]"), incoming = [], end = Math.min(links.length, scanCursor + 2400);
      $("progress").textContent = `正在讀取第 ${state.scrollPasses + 1} 輪，檢查 ${Math.min(end, links.length)} / ${links.length} 個連結…`;
      for (let index = scanCursor; index < end; index++) {
        if (index % 80 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (token !== generation || state.status !== "collecting") return;
        }
        const link = links[index], account = Core.profileFromHref(link.getAttribute("href"), location.href);
        if (!account || account.username.toLowerCase() === state.target.username.toLowerCase() || !isVisible(link)) continue;
        incoming.push({ ...account, label: (link.innerText || link.getAttribute("aria-label") || "").trim().slice(0, 160) });
      }
      scanCursor = end >= links.length ? 0 : end;
      if (token !== generation || state.status !== "collecting") return;
      if (!validScope()) { finish("paused", "讀取期間活動或來源變更，已暫停以免混入其他帳號。"); return; }
      const previousNames = new Set(state.accounts.map(a => a.username.toLowerCase())), selected = new Set(state.blockSelection), prior = state.accounts.length;
      state.accounts = Core.mergeAccounts(state.accounts, incoming, new Date().toISOString()).filter(a => a.username.toLowerCase() !== state.target.username.toLowerCase()).slice(0, state.limits.maxAccounts);
      for (const account of state.accounts) if (!previousNames.has(account.username.toLowerCase())) selected.add(account.username.toLowerCase());
      state.blockSelection = [...selected];
      if (prior !== state.accounts.length) { lastGrowthAt = Date.now(); changeRevision++; $("blockConfirmed").checked = false; requestRender(); scheduleSave(); }
      $("count").textContent = state.accounts.length.toLocaleString(); drawOutline();
      if (state.accounts.length >= state.limits.maxAccounts) finish("ended", "達到 10,000 人上限。完整性未知。");
    })();
    try { await samplePromise; } finally { samplePromise = null; sampleGeneration = null; }
  }
  async function collect() {
    disconnect(); state.status = "collecting"; state.reason = "僅讀取所選區域；完整性未知。可隨時結束並檢查已收集名單。"; runningSince = Date.now(); lastGrowthAt = runningSince;
    const token = generation;
    observer = new MutationObserver(() => { if (!sampleTimer) sampleTimer = setTimeout(() => { sampleTimer = null; sample(token).catch(error => { if (token === generation) finish("paused", `讀取中斷：${error.message}`); }); }, 350); });
    observer.observe(scope, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "hidden", "aria-hidden"] });
    persistNow(); render();
    let stablePasses = 0;
    try {
      while (token === generation && state.status === "collecting") {
        if (document.hidden) { finish("paused", "分頁已移到背景。回到此分頁後手動繼續。"); break; }
        await sample(token); if (token !== generation) break;
        if (Date.now() - runningSince >= state.limits.maxRunMs) { finish("ended", "達到單次 2 分鐘上限，已保留資料供檢查。完整性未知。"); break; }
        const before = { revision: changeRevision, top: scope.scrollTop, height: scope.scrollHeight };
        scope.scrollTop = Math.min(scope.scrollHeight, scope.scrollTop + Math.max(160, scope.clientHeight * 0.8));
        state.scrollPasses++; scheduleSave();
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (token !== generation || state.status !== "collecting") break;
        await sample(token); if (token !== generation) break;
        const bottom = scope.scrollTop + scope.clientHeight >= scope.scrollHeight - 3;
        const busy = [...scope.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(isVisible);
        const unchanged = before.revision === changeRevision && before.height === scope.scrollHeight;
        state.diagnostics.push({ pass: state.scrollPasses, at: new Date().toISOString(), beforeTop: before.top, afterTop: scope.scrollTop, clientHeight: scope.clientHeight, scrollHeight: scope.scrollHeight, accounts: state.accounts.length, newAccountsObserved: before.revision !== changeRevision, bottom, busy });
        state.diagnostics = state.diagnostics.slice(-600);
        const noGrowth = Math.max(0, Math.floor((Date.now() - lastGrowthAt) / 1000));
        $("progress").textContent = `已檢查 ${state.scrollPasses} 輪 · ${state.accounts.length} 個帳號 · ${noGrowth} 秒無新增${busy ? " · 網站仍顯示載入中" : ""}`;
        scheduleSave();
        stablePasses = bottom && unchanged && !busy && scanCursor === 0 ? stablePasses + 1 : 0;
        if (Date.now() - lastGrowthAt >= state.limits.noGrowthMs && scanCursor === 0) { finish("ended", `約 15 秒沒有新增帳號${busy ? "，網站載入指示仍未結束" : "，捲動可能沒有取得更多資料"}。已保留目前名單供檢查；完整性未知。`); break; }
        if (stablePasses >= 5) { finish("ended", "已到所選區域底部，連續 5 次檢查沒有新增帳號。可能仍有未載入資料，完整性未知。"); break; }
      }
    } catch (error) { if (token === generation) finish("paused", `頁面讀取中斷：${error.message}`); }
  }
  function candidateFor(element) {
    if (!(element instanceof Element) || element === host) return null;
    const link = element.closest("a[href]");
    if (!link || !Core.profileFromHref(link.getAttribute("href"), location.href)) return null;
    let fallback = null;
    for (let node = link.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (node === host) return null;
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.clientHeight > 0) return node;
      if (!fallback && ["list", "dialog"].includes(node.getAttribute("role"))) fallback = node;
    }
    return fallback;
  }
  function cancelPicking() {
    picking = false; document.removeEventListener("click", pickClick, true); document.removeEventListener("keydown", pickKey, true);
    $("cancelPick").hidden = true; $("pick").textContent = "選擇名單區域"; render();
  }
  function pickKey(event) { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); cancelPicking(); notice("已取消選擇。"); } }
  function pickClick(event) {
    if (event.composedPath().includes(host)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const candidate = candidateFor(event.target);
    if (!candidate) { notice("無法辨識名單區域。請點按讚名單內的帳號文字；若仍失敗，此頁面目前不支援。按 Esc 取消。"); return; }
    scope = candidate; scopePage = pageIdentity(); scopeSignature = contextSignature(); $("scopeConfirmed").checked = false;
    drawOutline(); const count = new Set(accountsIn(scope).map(a => a.username.toLowerCase())).size;
    $("scopeInfo").textContent = `已選定橘框區域，預覽前 200 個連結可辨識 ${count} 個帳號。完整結果開始收集後取得，請核對範圍及活動類型。`;
    cancelPicking(); notice("選擇完成。請確認橘框及來源後，再開始收集。");
  }
  $("pick").onclick = () => {
    cancelTargetPicking();
    picking = true; notice("請點 Threads 按讚名單內任一帳號文字。按 Esc 可取消。");
    $("cancelPick").hidden = false; $("pick").textContent = "等待選取…";
    document.addEventListener("click", pickClick, true); document.addEventListener("keydown", pickKey, true); render();
  };
  $("cancelPick").onclick = () => { cancelPicking(); notice("已取消選擇。"); };
  $("start").onclick = () => {
    const target = Core.canonicalTarget($("target").value);
    if (!target) return notice("尚未辨識目標。請按「更換目標」，再點正文或時間。");
    if (!$("scopeConfirmed").checked) return notice("請先勾選目標與橘框名單的確認。");
    if (!validScope()) return notice("名單區域已失效或頁面已改變，請重新選擇。");
    if (state.target && !confirm("開始新收集將取代上一份本機紀錄。確定已匯出需要保留的資料？")) return;
    state = freshState(); changeRevision = 0; listPage = 0; scanCursor = 0; $("includeAuthor").checked = false; $("blockConfirmed").checked = false;
    // Both Threads posts and replies use /post/ URLs and the same workflow.
    // Keep the legacy export kind without asking users to classify the target.
    state.target = { ...target, kind: "post", declaredLikeCount: null, binding: "user-confirmed", sourceSelection: pickedSourcePage ? "picked-card-timestamp" : "page-url-or-canonical", sourcePage: pageIdentity() };
    state.scopeEvidence = { selection: "user-picked-profile-link", tag: scope.tagName, role: scope.getAttribute("role"), likeOnlyConfirmedByUser: true };
    state.startedAt = new Date().toISOString(); notice(); collect();
  };
  $("pause").onclick = () => finish("paused", "使用者暫停。已保留目前名單。");
  $("resume").onclick = () => { if (!validScope()) return notice("原名單區域已失效。請中止並重新選擇、確認後開始新收集。"); notice(); collect(); };
  $("stop").onclick = () => finish("stopped", "使用者中止。保留已收集名單，不再自動捲動。");
  $("review").onclick = () => finish("ended", "使用者結束收集並檢查名單，已保留部分結果；完整性未知。");
  function pauseBlockingOnLeave() { if (blockRequest || actorChecking) pauseAfterRequest = true; else if (blockJob?.status === "running") blockCommand("BLOCK_PAUSE"); }
  $("close").onclick = () => { if (state.status === "collecting") finish("paused", "面板已關閉，收集暫停。"); pauseBlockingOnLeave(); cancelPicking(); cancelTargetPicking(); host.style.display = "none"; outline?.remove(); outline = null; };
  function exportFile(format) {
    if (!state.target) return;
    const snapshot = JSON.parse(JSON.stringify(state)); snapshot.exportedAt = new Date().toISOString();
    const data = format === "json" ? JSON.stringify(snapshot, null, 2) : "\uFEFF" + [["username", "profileUrl", "label", "firstSeenAt", "lastSeenAt"], ...snapshot.accounts.map(a => [a.username, a.profileUrl, a.label, a.firstSeenAt, a.lastSeenAt])].map(row => row.map(Core.csvCell).join(",")).join("\r\n");
    const blob = new Blob([data], { type: format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = `threads-likes-${state.target.kind}-${state.target.postId}.${format}`;
    shadow.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("json").onclick = () => exportFile("json"); $("csv").onclick = () => exportFile("csv");
  $("diagnostics").onclick = () => {
    const report = { schemaVersion: 1, extensionVersion: EXTENSION_VERSION, panelVersion: EXTENSION_VERSION, runtimeVersion: RUNTIME_VERSION, extensionId: EXTENSION_ID, backgroundIdentity, collector: state.target ? JSON.parse(JSON.stringify(state)) : null, blockingJob: blockJob ? JSON.parse(JSON.stringify(blockJob)) : null, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json;charset=utf-8" }), url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `threads-diagnostics-${state.target?.postId || blockJob?.target?.postId || Date.now()}.json`; shadow.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  async function blockCommand(type, payload = {}) {
    if (!chrome.runtime?.sendMessage) { notice("擴充功能背景連線不可用，請重新載入擴充功能及此頁面。"); return; }
    commandRevision++; blockRequest = true; render();
    let dispatched = false;
    try {
      if (["BLOCK_START", "BLOCK_RESUME"].includes(type)) {
        const sourceAtCheck = pageIdentity();
        const identity = await chrome.runtime.sendMessage({ type: "BLOCK_GET" });
        readBackgroundIdentity(identity);
        if (!identity?.ok || !compatibleBackground()) throw new Error(`面板 ${EXTENSION_VERSION} 與背景 ${backgroundIdentity.buildVersion || "舊版／未確認"} 不相容。請開啟「Threads 封鎖工具（修正版）」後重新核對。`);
        if (pauseAfterRequest || host.style.display === "none" || document.hidden || sourceAtCheck !== pageIdentity()) throw new Error("面板或來源已離開，尚未派送封鎖指令。");
        if (type === "BLOCK_RESUME" && (!payload.jobId || identity.job?.id !== payload.jobId || identity.job?.status !== "paused")) throw new Error("原工作已變更，尚未繼續封鎖。請重新核對工作紀錄。");
      }
      dispatched = true;
      const result = await chrome.runtime.sendMessage({ type, ...payload, panelVersion: EXTENSION_VERSION, extensionId: EXTENSION_ID });
      if (!result?.ok) throw new Error(result?.error || "背景工作沒有回應。");
      blockJob = result.job || null;
      if (type === "BLOCK_START") $("blockConfirmed").checked = false;
      notice();
    } catch (error) { notice(`封鎖工作：${error.message}`); }
    finally {
      if ((pauseAfterRequest || host.style.display === "none") && ((dispatched && (type === "BLOCK_START" || type === "BLOCK_RESUME")) || blockJob?.status === "running")) {
        try { const paused = await chrome.runtime.sendMessage({ type: "BLOCK_PAUSE" }); if (paused?.ok) blockJob = paused.job || null; else notice(paused?.error || "暫停未獲確認，請檢查工作紀錄。"); } catch { notice("暫停未獲確認，請檢查工作紀錄。"); }
      }
      pauseAfterRequest = false; blockRequest = false; render();
    }
  }
  async function refreshActor() {
    if (actorPromise) return actorPromise;
    actorPromise = (async () => {
      let next = "";
      try {
        const result = await chrome.runtime?.sendMessage({ type: "BLOCK_ACTOR" });
        if (!result?.ok || !/^[A-Za-z0-9._]{1,30}$/.test(result.actorUsername || "")) throw new Error("actor unavailable");
        next = result.actorUsername;
        actorError = "";
      } catch { actorError = "無法確認登入帳號。請先在此分頁登入 Threads，再重新整理。"; }
      if (next.toLowerCase() !== detectedActor.toLowerCase()) $("blockConfirmed").checked = false;
      detectedActor = next;
      render();
      return next;
    })();
    try { return await actorPromise; } finally { actorPromise = null; }
  }
  $("refreshActor").onclick = refreshActor;
  async function startBlocking(probeRequest = false, directRequestTest = false) {
    if (!state.target || !$("blockConfirmed").checked) return notice("請先檢查完整名單並勾選封鎖確認。");
    if (actorChecking || blockRequest) return;
    const previousActor = detectedActor, target = JSON.parse(JSON.stringify(state.target)), sourcePage = pageIdentity();
    const selected = new Set(state.blockSelection), accounts = state.accounts.filter(a => selected.has(a.username.toLowerCase()) && a.username.toLowerCase() !== previousActor.toLowerCase()).map(account => ({ ...account }));
    const includeAuthor = $("includeAuthor").checked;
    actorChecking = true; render();
    const actorUsername = await refreshActor();
    actorChecking = false; render();
    if (pauseAfterRequest || host.style.display === "none" || document.hidden || sourcePage !== pageIdentity()) { pauseAfterRequest = false; $("blockConfirmed").checked = false; return notice("面板或來源已離開，尚未開始封鎖。請重新檢查名單。"); }
    if (!actorUsername) return notice(actorError);
    if (previousActor.toLowerCase() !== actorUsername.toLowerCase() || !$("blockConfirmed").checked || state.target?.url !== target.url || $("target").value !== target.url) return notice("登入帳號或目標已改變。請重新檢查名單並確認。");
    const count = accounts.length + (includeAuthor && target.username.toLowerCase() !== actorUsername.toLowerCase() ? 1 : 0);
    if (!count) return notice("沒有可封鎖的已選帳號。");
    if ((probeRequest || directRequestTest) && count !== 1) return notice('請只選一個帳號進行請求驗證（包含作者選項）。');
    blockCommand("BLOCK_START", { target, accounts, includeAuthor, actorUsername, confirmed: true, ...(probeRequest ? { probeRequest: true } : {}), ...(directRequestTest ? { directRequestTest: true } : {}) });
  }
  $("blockStart").onclick = () => startBlocking();
  $("probeStart").onclick = () => startBlocking(true);
  $("directStart").onclick = () => startBlocking(false, true);
  $("blockPause").onclick = () => blockCommand("BLOCK_PAUSE");
  $("blockResume").onclick = async () => {
    if (actorChecking || blockRequest) return;
    const sourcePage = pageIdentity(), jobId = blockJob?.id, revision = commandRevision;
    actorChecking = true; render(); const actorUsername = await refreshActor(); actorChecking = false; render();
    if (pauseAfterRequest || host.style.display === "none" || document.hidden || sourcePage !== pageIdentity()) { pauseAfterRequest = false; return notice("面板或來源已離開，工作維持暫停。"); }
    if (blockRequest || revision !== commandRevision || blockJob?.id !== jobId || blockJob?.status !== "paused") return notice("原工作已變更，尚未繼續封鎖。");
    if (!actorUsername) return notice(actorError);
    if (actorUsername.toLowerCase() !== blockJob?.actorUsername?.toLowerCase()) return notice("目前登入帳號與原工作不同，請切換回原帳號後繼續。");
    blockCommand("BLOCK_RESUME", { actorUsername, jobId });
  };
  $("blockStop").onclick = () => blockCommand("BLOCK_STOP");
  $("blockReturn").onclick = async () => { await blockCommand("BLOCK_STOP"); if (blockJob?.status === "stopped" && state.status === "paused") finish("ended", "舊封鎖工作已中止，已保留收集名單供檢查。"); };
  $("blockExport").onclick = () => {
    if (!blockJob) return;
    const blob = new Blob([JSON.stringify({ ...blockJob, exportedAt: new Date().toISOString() }, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = `threads-block-${blockJob.id}.json`; shadow.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $("selectAll").onclick = () => { state.blockSelection = state.accounts.map(a => a.username.toLowerCase()); $("blockConfirmed").checked = false; scheduleSave(); render(); };
  $("selectNone").onclick = () => { state.blockSelection = []; $("blockConfirmed").checked = false; scheduleSave(); render(); };
  $("search").oninput = () => { listPage = 0; render(); };
  $("prevPage").onclick = () => { listPage--; render(); }; $("nextPage").onclick = () => { listPage++; render(); };
  $("includeAuthor").addEventListener("input", () => { $("blockConfirmed").checked = false; render(); });
  let polling = false;
  async function pollJob() {
    if (!chrome.runtime?.sendMessage || blockRequest || polling || host.style.display === "none") return;
    polling = true; const revision = commandRevision;
    try {
      const result = await chrome.runtime.sendMessage({ type: "BLOCK_GET" });
      if (revision === commandRevision && !blockRequest && result?.ok) { readBackgroundIdentity(result); if (JSON.stringify(result.job) !== JSON.stringify(blockJob)) blockJob = result.job || null; render(); }
    } catch { /* Explicit commands report connection failures. */ }
    finally { polling = false; }
  }
  if (chrome.runtime?.sendMessage) { setInterval(pollJob, 1500); pollJob(); }
  if (chrome.runtime?.sendMessage) { setInterval(() => { if (!blockRequest && !actorChecking && host.style.display !== "none") refreshActor(); }, 6000); refreshActor(); }
  $("clear").onclick = async () => {
    if (!confirm("清除這個工具在本機保存的名單及紀錄？")) return;
    disconnect(); clearTimeout(saveTimer); await saveChain; await chrome.storage.local.remove(STORE_KEY);
    state = freshState(); $("includeAuthor").checked = false; $("blockConfirmed").checked = false; render(); notice("已清除本機紀錄。");
  };
  $("target").addEventListener("change", resetApprovals);
  document.addEventListener("visibilitychange", () => { if (state.status === "collecting" && document.hidden) finish("paused", "分頁已移到背景。回到此分頁後手動繼續。"); });
  document.addEventListener("click", event => {
    if (state.status !== "collecting" || event.composedPath().includes(host) || scope?.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest('button,[role="button"],[role="tab"],a[href]')) finish("paused", "偵測到名單外的頁面控制操作，已暫停。可繼續原名單或結束並檢查已收集結果。");
  }, { capture: true, passive: true });
  window.addEventListener("pagehide", () => { if (state.status === "collecting") finish("paused", "頁面已離開，收集暫停。"); pauseBlockingOnLeave(); });
  globalThis.__threadsLikesProbe = { version: EXTENSION_VERSION, extensionId: EXTENSION_ID, show() { host.style.display = "block"; if (scope?.isConnected) drawOutline(); } };
  setDetectedTarget(detectedTarget());
  render();
  // Disable collection until restoration finishes, avoiding a late overwrite.
  $("start").disabled = true; $("pick").disabled = true;
  chrome.storage.local.get(STORE_KEY).then(result => {
    const saved = result[STORE_KEY];
    if (saved?.schemaVersion === 1 && saved.mode === "read-only-probe" && Array.isArray(saved.accounts) && Core.canonicalTarget(saved.target?.url)) {
      state = { ...freshState(), ...saved, target: { ...saved.target, ...Core.canonicalTarget(saved.target.url) }, accounts: Core.mergeAccounts(saved.accounts, [], saved.updatedAt || new Date().toISOString()).slice(0, 10000), status: "restored", completeness: "unknown", liveCompatibility: "not-verified" };
      state.extensionVersion = EXTENSION_VERSION; state.limits = { maxAccounts: 10000, maxRunMs: 120000, noGrowthMs: 15000 };
      state.accounts = state.accounts.filter(a => a.username.toLowerCase() !== state.target.username.toLowerCase());
      const choices = Array.isArray(saved.blockSelection) ? new Set(saved.blockSelection) : null;
      state.blockSelection = state.accounts.filter(a => !choices || choices.has(a.username.toLowerCase())).map(a => a.username.toLowerCase());
      state.reason = "已還原資料。原頁面區域不會還原；請先匯出，或重新選擇來源並開始新收集。";
      if (!$("target").value) $("sourceInfo").textContent = `已還原上次 @${state.target.username} 的名單。要開始新收集，請先選擇目前的貼文／留言。`;
    }
  }).catch(() => notice("無法讀取上次紀錄。新結果仍可匯出。")).finally(render);
  let observedPage = pageIdentity();
  setInterval(() => {
    const currentPage = pageIdentity();
    if (currentPage !== observedPage) {
      observedPage = currentPage; pickedSourcePage = null;
      if (state.status === "collecting") finish("paused", "來源頁面已改變，已保留目前收集結果。");
      setDetectedTarget(detectedTarget()); refreshActor(); render();
    } else if (!$("target").value && !pickedSourcePage && !pickingTarget) {
      const target = detectedTarget(); if (target) { setDetectedTarget(target); render(); }
    }
  }, 800);
})();
