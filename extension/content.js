/* No network calls, cookies, private APIs, account actions or page button clicks. */
(() => {
  "use strict";
  if (globalThis.__threadsLikesProbe) {
    globalThis.__threadsLikesProbe.show();
    return;
  }
  const Core = globalThis.ThreadsProbeCore;
  if (!Core) throw new Error("Missing probe core");
  if (!Number.isInteger(globalThis.__threadsProbeTabId)) throw new Error("Missing toolbar tab context");
  const STORE_KEY = `threadsLikesProbe.snapshot.v1.tab.${globalThis.__threadsProbeTabId}`;
  const host = document.createElement("div");
  host.id = "threads-likes-probe-host";
  host.style.cssText = "all:initial;position:fixed;inset:0 0 0 auto;width:380px;max-width:95vw;height:100vh;z-index:2147483647;pointer-events:auto;color-scheme:light;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host{font:14px/1.55 system-ui,-apple-system,'Microsoft JhengHei',sans-serif;color:#17212e}
      *{box-sizing:border-box} .panel{font:14px/1.55 system-ui,-apple-system,'Microsoft JhengHei',sans-serif;color:#17212e;height:100%;display:flex;flex-direction:column;background:#f5f7fb;box-shadow:-4px 0 24px #0002;border-left:1px solid #dce2ec}
      header{background:#182b49;color:white;padding:16px 18px;display:flex;justify-content:space-between;align-items:center}
      h1{font-size:17px;margin:0} .sub{font-size:12px;color:#c8d7ec} main{overflow:auto;flex:1;padding:16px}
      section{background:white;border:1px solid #dce2ec;border-radius:12px;padding:14px;margin-bottom:12px}
      h2{font-size:14px;margin:0 0 10px} p{margin:6px 0} small,.hint{font-size:12px;color:#536177}.warning{background:#fff7e6;border-color:#e8ca82}
      label{display:block;margin:10px 0 5px;font-size:13px} input[type=text],input[type=url],select{width:100%;border:1px solid #b8c4d5;border-radius:7px;padding:8px;background:white;color:#17212e;font:inherit}
      input[type=checkbox]{margin:0 6px 0 0;vertical-align:middle} .check{display:flex;align-items:flex-start;gap:5px} .check input{margin-top:4px;flex:none}
      button{font:inherit;border:1px solid #c4cedc;border-radius:7px;padding:8px 11px;background:white;color:#243852;cursor:pointer}button:disabled{opacity:.45;cursor:default}button.primary{background:#235bc9;border-color:#235bc9;color:white}button.danger{color:#b22b32}
      .buttons{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}header button{background:transparent;color:white;border:0;font-size:20px;padding:0 5px}
      #status{font-weight:650}#reason{font-size:12px;color:#536177} .count{font-size:30px;font-weight:750;color:#235bc9}#accounts{max-height:230px;overflow:auto;margin-top:10px}
      .account{padding:7px 0;border-top:1px solid #edf0f5;overflow-wrap:anywhere}.account a{color:#204fad;text-decoration:none}.account small{display:block}footer{padding:10px 16px;border-top:1px solid #dce2ec;background:white;font-size:11px;color:#536177}
      #notice{padding:9px 12px;background:#fff1cf;border-radius:6px;margin-bottom:12px;white-space:pre-wrap;font-size:12px}#notice:empty{display:none}
    </style>
    <div class="panel">
      <header><div><h1>Threads 按讚名單驗證</h1><div class="sub">第 1 階段 · 僅讀取與捲動</div></div><button id="close" title="關閉並暫停">×</button></header>
      <main>
        <div id="notice" role="status" aria-live="polite"></div>
        <section class="warning"><strong>這一版沒有封鎖功能</strong><p class="hint">僅收集你選定區域中可取得的帳號。捲到底仍無法證明名單完整；實際 Threads 相容性尚待驗證。</p></section>
        <section><h2>1. 確認來源</h2>
          <label for="kind">目標類型</label><select id="kind"><option value="post">貼文</option><option value="reply">留言／回覆</option></select>
          <label for="target">該目標的直接連結</label><input id="target" type="url" placeholder="https://www.threads.com/@帳號/post/代碼">
          <p class="hint">留言請填留言本身的連結。若只有主文連結，請先不要收集該留言。</p>
          <label for="declaredCount">頁面顯示的按讚數（選填）</label><input id="declaredCount" type="text" inputmode="numeric" placeholder="精確整數，例如 125">
          <label class="check"><input id="targetConfirmed" type="checkbox"><span>我已核對連結，且接下來開啟的是此目標的「按讚」名單。</span></label>
        </section>
        <section><h2>2. 選擇按讚名單區域</h2><p class="hint">先在 Threads 手動展開按讚名單，並切到「按讚」分頁。按下方按鈕後，點名單內任一帳號；工具不會開啟該帳號。</p>
          <div class="buttons"><button id="pick">選擇名單區域</button><button id="cancelPick" hidden>取消選擇</button></div>
          <p id="scopeInfo" class="hint">尚未選擇</p>
          <label class="check"><input id="scopeConfirmed" type="checkbox"><span>我已檢查橘框，只包含上述目標的按讚名單，沒有其他活動或推薦帳號。</span></label>
        </section>
        <section><h2>3. 收集與檢查</h2><div id="status" aria-live="polite">尚未開始</div><div id="reason"></div><div><span id="count" class="count">0</span> 個不重複帳號</div>
          <div class="buttons"><button id="start" class="primary">開始新收集</button><button id="pause" disabled>暫停</button><button id="resume" disabled>繼續</button><button id="stop" class="danger" disabled>中止</button></div>
          <p class="hint">開始新收集會取代此分頁的上一份紀錄，請先匯出需要保留的資料。操作 Threads 頁面時會自動暫停。名單收集上限為 10,000 人、單次執行上限為 10 分鐘。</p>
          <div id="accounts"></div>
        </section>
        <section><h2>4. 匯出本機結果</h2><p class="hint">JSON 包含來源、時間與結束原因；CSV 為帳號清單。畫面最多預覽 100 筆，匯出包含全部。</p>
          <div class="buttons"><button id="json">匯出 JSON</button><button id="csv">匯出 CSV</button><button id="clear">清除本機紀錄</button></div>
        </section>
      </main><footer>無伺服器 · 不讀取密碼或 Cookie · 不執行封鎖／追蹤／按讚</footer>
    </div>`;
  document.documentElement.appendChild(host);
  const $ = (id) => shadow.getElementById(id);
  const labels = { idle: "尚未開始", collecting: "收集中", paused: "已暫停", stopped: "已中止", ended: "收集已結束", restored: "已還原上次紀錄（不會自動繼續）" };
  let state = freshState(), scope = null, scopePage = "", outline = null, picking = false;
  let generation = 0, observer = null, sampleTimer = null, saveTimer = null, saveChain = Promise.resolve();
  let changeRevision = 0, runningSince = 0, scopeSignature = "";
  function freshState() { return { schemaVersion: 1, mode: "read-only-probe", status: "idle", reason: "", completeness: "unknown", liveCompatibility: "not-verified", target: null, accounts: [], startedAt: null, updatedAt: null, finishedAt: null, scrollPasses: 0, scopeEvidence: null, limits: { maxAccounts: 10000, maxRunMs: 600000 } }; }
  function notice(text = "") { $("notice").textContent = text; }
  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }
  function accountsIn(root) {
    const result = [];
    for (const link of root.querySelectorAll("a[href]")) {
      if (!isVisible(link)) continue;
      const account = Core.profileFromHref(link.getAttribute("href"), location.href);
      if (!account) continue;
      result.push({ ...account, label: (link.innerText || link.getAttribute("aria-label") || "").trim().slice(0, 160) });
    }
    return result;
  }
  function samePage() { return `${location.origin}${location.pathname}` === scopePage; }
  function contextSignature() {
    if (!scope) return "";
    const context = scope.closest('[role="dialog"]') || scope.parentElement;
    if (!context) return "";
    const items = [...context.querySelectorAll('h1,h2,h3,[role="heading"],[role="tab"],[aria-selected="true"],a[href]')].filter(element => {
      if (!isVisible(element)) return false;
      if (element.matches('a[href]')) return !scope.contains(element) && !!Core.canonicalTarget(element.getAttribute('href'), location.href);
      if (scope.contains(element) && element.closest('[role="listitem"],a[href]')) return false;
      return true;
    }).map(element => [element.tagName, element.getAttribute('role'), element.getAttribute('aria-selected'), element.matches('a[href]') ? Core.canonicalTarget(element.getAttribute('href'), location.href)?.url : element.textContent.trim().slice(0, 160)]);
    return JSON.stringify(items);
  }
  function validScope() { return scope && scope !== document.body && scope !== document.documentElement && isVisible(scope) && samePage() && (!scopeSignature || contextSignature() === scopeSignature); }
  function drawOutline() {
    if (!scope) return;
    const r = scope.getBoundingClientRect();
    if (!outline) { outline = document.createElement("div"); outline.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;border:3px solid #f59e0b;border-radius:6px;"; document.documentElement.appendChild(outline); }
    Object.assign(outline.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }
  function render() {
    $("status").textContent = labels[state.status] || state.status;
    $("reason").textContent = state.reason;
    $("count").textContent = state.accounts.length.toLocaleString();
    const active = state.status === "collecting", held = active || state.status === "paused";
    for (const id of ["kind", "target", "declaredCount", "targetConfirmed", "scopeConfirmed", "pick"]) $(id).disabled = held;
    $("start").disabled = held || picking;
    $("pause").disabled = !active;
    $("resume").disabled = state.status !== "paused";
    $("stop").disabled = !held;
    $("clear").disabled = held;
    $("json").disabled = !state.target;
    $("csv").disabled = !state.target;
    const list = $("accounts"); list.replaceChildren();
    for (const account of state.accounts.slice(0, 100)) {
      const row = document.createElement("div"); row.className = "account";
      const link = document.createElement("a"); link.href = account.profileUrl; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = `@${account.username}`;
      const sub = document.createElement("small"); sub.textContent = account.label || "";
      row.append(link, sub); list.append(row);
    }
  }
  function persistNow() {
    clearTimeout(saveTimer); state.updatedAt = new Date().toISOString();
    const snapshot = JSON.parse(JSON.stringify(state));
    saveChain = saveChain.catch(() => {}).then(() => chrome.storage.local.set({ [STORE_KEY]: snapshot })).catch(() => notice("本機儲存失敗。請立即匯出目前資料；不要依賴重開後還原。"));
    return saveChain;
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(persistNow, 350); }
  function disconnect() { generation++; observer?.disconnect(); observer = null; clearTimeout(sampleTimer); sampleTimer = null; }
  function finish(status, reason) {
    disconnect(); state.status = status; state.reason = reason;
    if (["ended", "stopped"].includes(status)) state.finishedAt = new Date().toISOString();
    persistNow(); render();
  }
  function sample() {
    if (state.status !== "collecting") return;
    if (!validScope()) { finish("paused", "名單關閉、區域失效或來源頁面已切換。請還原原名單後再繼續；換目標請中止並重新收集。"); return; }
    const prior = state.accounts.length;
    state.accounts = Core.mergeAccounts(state.accounts, accountsIn(scope), new Date().toISOString()).slice(0, state.limits.maxAccounts);
    if (prior !== state.accounts.length) { changeRevision++; render(); scheduleSave(); }
    drawOutline();
    if (state.accounts.length >= state.limits.maxAccounts) finish("ended", "達到 10,000 人上限。完整性未知。");
  }
  async function collect() {
    disconnect(); state.status = "collecting"; state.reason = "僅讀取所選區域；完整性未知。"; runningSince = Date.now();
    const token = generation;
    observer = new MutationObserver(() => { if (!sampleTimer) sampleTimer = setTimeout(() => { sampleTimer = null; sample(); }, 80); });
    observer.observe(scope, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "hidden", "aria-hidden"] });
    persistNow(); render();
    let stablePasses = 0;
    try {
      while (token === generation && state.status === "collecting") {
        if (document.hidden) { finish("paused", "分頁已移到背景。回到此分頁後手動繼續。"); break; }
        sample(); if (token !== generation) break;
        if (Date.now() - runningSince >= state.limits.maxRunMs) { finish("ended", "達到單次 10 分鐘上限。完整性未知。"); break; }
        const before = { revision: changeRevision, top: scope.scrollTop, height: scope.scrollHeight };
        scope.scrollTop = Math.min(scope.scrollHeight, scope.scrollTop + Math.max(160, scope.clientHeight * 0.8));
        state.scrollPasses++; scheduleSave();
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (token !== generation || state.status !== "collecting") break;
        sample(); if (token !== generation) break;
        const bottom = scope.scrollTop + scope.clientHeight >= scope.scrollHeight - 3;
        const busy = [...scope.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(isVisible);
        const unchanged = before.revision === changeRevision && before.height === scope.scrollHeight;
        stablePasses = bottom && unchanged && !busy ? stablePasses + 1 : 0;
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
    scope = candidate; scopePage = `${location.origin}${location.pathname}`; scopeSignature = contextSignature(); $("scopeConfirmed").checked = false;
    drawOutline(); const count = new Set(accountsIn(scope).map(a => a.username.toLowerCase())).size;
    $("scopeInfo").textContent = `已選定橘框區域，目前可辨識 ${count} 個帳號。請核對範圍及活動類型。`;
    cancelPicking(); notice("選擇完成。請確認橘框及來源後，再開始收集。");
  }
  $("pick").onclick = () => {
    picking = true; notice("請點 Threads 按讚名單內任一帳號文字。按 Esc 可取消。");
    $("cancelPick").hidden = false; $("pick").textContent = "等待選取…";
    document.addEventListener("click", pickClick, true); document.addEventListener("keydown", pickKey, true); render();
  };
  $("cancelPick").onclick = () => { cancelPicking(); notice("已取消選擇。"); };
  $("start").onclick = () => {
    const target = Core.canonicalTarget($("target").value);
    if (!target) return notice("請填寫有效的 Threads 貼文／留言直接連結（https://www.threads.com/@帳號/post/代碼）。");
    if (!$("targetConfirmed").checked || !$("scopeConfirmed").checked) return notice("請先勾選來源與名單區域的兩項確認。");
    if (!validScope()) return notice("名單區域已失效或頁面已改變，請重新選擇。");
    const rawCount = $("declaredCount").value.trim(), count = rawCount ? Core.normalizeCounts(rawCount) : null;
    if (rawCount && count == null) return notice("按讚數請填精確非負整數；例如 1.2K 請留空。");
    if (state.target && !confirm("開始新收集將取代上一份本機紀錄。確定已匯出需要保留的資料？")) return;
    state = freshState(); changeRevision = 0;
    state.target = { ...target, kind: $("kind").value, declaredLikeCount: count, binding: "user-confirmed", sourcePage: `${location.origin}${location.pathname}` };
    state.scopeEvidence = { selection: "user-picked-profile-link", tag: scope.tagName, role: scope.getAttribute("role"), likeOnlyConfirmedByUser: true };
    state.startedAt = new Date().toISOString(); notice(); collect();
  };
  $("pause").onclick = () => finish("paused", "使用者暫停。已保留目前名單。");
  $("resume").onclick = () => { if (!validScope()) return notice("原名單區域已失效。請中止並重新選擇、確認後開始新收集。"); notice(); collect(); };
  $("stop").onclick = () => finish("stopped", "使用者中止。保留已收集名單，不再自動捲動。");
  $("close").onclick = () => { if (state.status === "collecting") finish("paused", "面板已關閉，收集暫停。"); cancelPicking(); host.style.display = "none"; outline?.remove(); outline = null; };
  function exportFile(format) {
    if (!state.target) return;
    const snapshot = JSON.parse(JSON.stringify(state)); snapshot.exportedAt = new Date().toISOString();
    const data = format === "json" ? JSON.stringify(snapshot, null, 2) : "\uFEFF" + [["username", "profileUrl", "label", "firstSeenAt", "lastSeenAt"], ...snapshot.accounts.map(a => [a.username, a.profileUrl, a.label, a.firstSeenAt, a.lastSeenAt])].map(row => row.map(Core.csvCell).join(",")).join("\r\n");
    const blob = new Blob([data], { type: format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = `threads-likes-${state.target.kind}-${state.target.postId}.${format}`;
    shadow.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("json").onclick = () => exportFile("json"); $("csv").onclick = () => exportFile("csv");
  $("clear").onclick = async () => {
    if (!confirm("清除這個工具在本機保存的名單及紀錄？")) return;
    disconnect(); clearTimeout(saveTimer); await saveChain; await chrome.storage.local.remove(STORE_KEY);
    state = freshState(); render(); notice("已清除本機紀錄。");
  };
  for (const id of ["target", "kind"]) $(id).addEventListener("change", () => { $("targetConfirmed").checked = false; $("scopeConfirmed").checked = false; });
  document.addEventListener("visibilitychange", () => { if (state.status === "collecting" && document.hidden) finish("paused", "分頁已移到背景。回到此分頁後手動繼續。"); });
  for (const type of ["pointerdown", "click", "keydown", "wheel"]) document.addEventListener(type, event => {
    if (state.status === "collecting" && !event.composedPath().includes(host)) finish("paused", "偵測到 Threads 頁面操作，已先暫停以避免切換名單時混入其他帳號。請核對原名單後繼續。");
  }, { capture: true, passive: true });
  window.addEventListener("pagehide", () => { if (state.status === "collecting") finish("paused", "頁面已離開，收集暫停。"); });
  globalThis.__threadsLikesProbe = { show() { host.style.display = "block"; if (scope?.isConnected) drawOutline(); } };
  $("target").value = Core.canonicalTarget(location.href)?.url || "";
  render();
  // Disable collection until restoration finishes, avoiding a late overwrite.
  $("start").disabled = true; $("pick").disabled = true;
  chrome.storage.local.get(STORE_KEY).then(result => {
    const saved = result[STORE_KEY];
    if (saved?.schemaVersion === 1 && saved.mode === "read-only-probe" && Array.isArray(saved.accounts) && Core.canonicalTarget(saved.target?.url)) {
      state = { ...freshState(), ...saved, target: { ...saved.target, ...Core.canonicalTarget(saved.target.url) }, accounts: Core.mergeAccounts(saved.accounts, [], saved.updatedAt || new Date().toISOString()).slice(0, 10000), status: "restored", completeness: "unknown", liveCompatibility: "not-verified" };
      state.reason = "已還原資料。原頁面區域不會還原；請先匯出，或重新選擇來源並開始新收集。";
      $("target").value = state.target.url; $("kind").value = state.target.kind === "reply" ? "reply" : "post";
      $("declaredCount").value = state.target.declaredLikeCount ?? "";
    }
  }).catch(() => notice("無法讀取上次紀錄。新結果仍可匯出。")).finally(render);
})();
