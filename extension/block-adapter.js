(function (root) {
  "use strict";
  if (root.ThreadsBlockAdapter?.version === 2) return;
  const USER = /^[A-Za-z0-9._]{1,30}$/;
  const HOSTS = new Set(["threads.com", "www.threads.com", "threads.net", "www.threads.net"]);
  const PROFILE_LABELS = new Set(["profile", "個人檔案", "个人主页", "個人主頁", "个人资料"]);
  const MORE_LABELS = new Set(["more", "more options", "options", "更多", "更多選項", "更多选项"]);
  const BLOCK_LABELS = new Set(["block", "封鎖", "封锁"]);
  const UNBLOCK_LABELS = new Set(["unblock", "解除封鎖", "解除封锁", "取消封鎖", "取消封锁"]);
  const OTHER_ACTION_LABELS = new Set(["mute", "unmute", "restrict", "unrestrict", "report", "copy link", "copy profile link", "噤聲", "取消噤聲", "靜音", "静音", "限制", "取消限制", "檢舉", "举报", "複製連結", "复制链接"]);
  const norm = value => String(value || "").replace(/\s+/g, " ").trim();
  const low = value => norm(value).toLowerCase();
  const all = (node, selector) => Array.from(node?.querySelectorAll?.(selector) || []);
  const text = element => norm(element?.innerText ?? element?.textContent);

  function profileUsernameFromUrl(raw, base) {
    if (typeof raw !== "string" || /[\u0000-\u001f\u007f]/.test(raw)) return null;
    try {
      const url = new URL(raw, base || "https://www.threads.com");
      if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.username || url.password || url.port) return null;
      return /^\/@([A-Za-z0-9._]{1,30})\/?$/.exec(url.pathname)?.[1] || null;
    } catch { return null; }
  }

  function exactAccessibleText(element, doc) {
    if (!element) return "";
    const aria = element.getAttribute?.("aria-label");
    if (aria) return norm(aria);
    const refs = element.getAttribute?.("aria-labelledby");
    if (refs && doc?.getElementById) {
      const value = norm(refs.split(/\s+/).map(id => text(doc.getElementById(id))).join(" "));
      if (value) return value;
    }
    const own = text(element);
    if (own) return own;
    const title = element.getAttribute?.("title");
    if (title) return norm(title);
    const icons = all(element, "svg[aria-label],svg[title],svg title");
    const labels = [...new Set(icons.map(icon => norm(icon.getAttribute?.("aria-label") || icon.getAttribute?.("title") || icon.textContent)).filter(Boolean))];
    return labels.length === 1 ? labels[0] : "";
  }

  function createAdapter(env) {
    const doc = env.document;
    const now = env.now || (() => Date.now());
    const delay = env.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const getStyle = env.getComputedStyle || root.getComputedStyle?.bind(root);
    const href = () => typeof env.href === "function" ? env.href() : (env.location?.href || root.location?.href || "");
    let prepared = null, stage = "initial";
    function visible(element) {
      if (!element?.isConnected || element.closest?.("[hidden]")) return false;
      const rect = element.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = getStyle ? getStyle(element) : {};
      // aria-hidden can be applied to the background while a modal is open.
      // Reading the unchanged background identity remains necessary; clicks
      // additionally require a topmost hit test below.
      return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
    }
    function controls(scope) { return all(scope, "button,[role=\"button\"],[role=\"menuitem\"]").filter(visible); }
    function matchesLabel(element, labels) { return labels.has(low(exactAccessibleText(element, doc))); }
    function readableActorFromNavigation() {
      const actors = new Map();
      for (const link of all(doc, "a[href]")) {
        if (!visible(link)) continue;
        const username = profileUsernameFromUrl(link.getAttribute("href"), href());
        if (!username) continue;
        const explicit = norm(link.getAttribute("aria-label")) || all(link, "svg[aria-label],svg[title],svg title").map(icon => norm(icon.getAttribute("aria-label") || icon.getAttribute("title") || icon.textContent)).find(label => PROFILE_LABELS.has(low(label)));
        const semanticNav = link.closest?.("nav,[role=\"navigation\"]");
        if (!(PROFILE_LABELS.has(low(explicit)) || (semanticNav && PROFILE_LABELS.has(low(exactAccessibleText(link, doc)))))) continue;
        actors.set(username.toLowerCase(), username);
      }
      return actors.size === 1 ? [...actors.values()][0] : null;
    }
    function profileCandidates(username) {
      const candidates = new Map(), exact = new Set([low(username), `@${low(username)}`]);
      const excluded = 'nav,[role="navigation"],article,[role="article"],aside,[role="complementary"],[role="dialog"],[role="menu"]';
      const identities = all(doc, 'h1,h2,h3,span,div,[role="heading"]').filter(element => {
        if (!visible(element) || !exact.has(low(text(element))) || element.closest?.(excluded)) return false;
        // Prefer the actual username leaf, avoiding incidental wrapper text.
        return !Array.from(element.children || []).some(child => visible(child) && exact.has(low(text(child))));
      });
      for (const identity of identities) {
        const linked = identity.closest?.('a[href]');
        if (linked && low(profileUsernameFromUrl(linked.getAttribute('href'), href())) !== low(username)) continue;
        for (let scope = identity.parentElement, depth = 0; scope && depth < 32; scope = scope.parentElement, depth++) {
          if (scope === doc || ['BODY', 'HTML'].includes(scope.tagName) || scope.closest?.(excluded)) break;
          // Never promote a username in a post/feed/nav to a profile header.
          if (all(scope, 'a[href]').some(link => /\/@[^/]+\/post\//.test(link.getAttribute('href') || ''))) break;
          if (all(scope, 'nav,[role="navigation"],aside,[role="complementary"],article,[role="article"]').length) break;
          const buttons = controls(scope);
          const menus = buttons.filter(element => matchesLabel(element, MORE_LABELS) && element.getAttribute('aria-haspopup') !== 'false');
          const unblock = buttons.filter(element => matchesLabel(element, UNBLOCK_LABELS));
          if (menus.length > 1 || unblock.length > 1) break;
          if (menus.length === 1 || (menus.length === 0 && unblock.length === 1)) {
            const key = menus[0] || unblock[0];
            // Keep the smallest ancestor tying this username to its action.
            if (!candidates.has(key)) candidates.set(key, { scope, identity, menu: menus[0] || null, unblock: unblock[0] || null });
            break;
          }
        }
      }
      return { identities: identities.length, candidates: [...candidates.values()] };
    }
    function profileScope(username) { const found = profileCandidates(username); return found.candidates.length === 1 ? found.candidates[0] : null; }
    function barrier() {
      const current = href();
      if (/\/(?:login|challenge|checkpoint|accounts\/login)(?:[/?#]|$)/i.test(current)) return "目前頁面要求登入或驗證。";
      for (const node of all(doc, '[role="dialog"],dialog[open],[role="alert"]').filter(visible)) {
        if (/captcha|verify your|verification|security check|log in|sign in|try again later|temporarily (?:blocked|restricted)|操作過於頻繁|操作过于频繁|請稍後再試|请稍后再试|驗證你的|验证你的|登入|登录/i.test(text(node))) return "頁面出現登入、驗證或操作限制提示。";
      }
      if (all(doc, 'input[type="password"]').some(visible)) return "頁面要求登入。";
      return null;
    }
    function guard(username, actorUsername, needScope = true) {
      if (!USER.test(username || "") || !USER.test(actorUsername || "")) return { code: 'invalid-identity', reason: "目標或登入帳號格式無效。" };
      if (low(username) === low(actorUsername)) return { code: 'self', reason: "不能封鎖目前登入的自己。" };
      if (low(profileUsernameFromUrl(href())) !== low(username)) return { code: 'wrong-url', reason: "目前個人檔案 URL 與佇列目標不一致。" };
      const blocked = barrier(); if (blocked) return { code: 'barrier', reason: blocked };
      const actor = readableActorFromNavigation();
      if (!actor) return { code: 'actor-missing', reason: "無法從導覽列確認目前登入帳號。" };
      if (low(actor) !== low(actorUsername)) return { code: 'actor-changed', reason: "目前登入帳號已改變。" };
      const context = profileScope(username);
      if (needScope && !context) return { code: 'profile-missing', reason: "無法唯一辨識目標的個人檔案標頭與更多選單。" };
      return { actor, context };
    }
    function safelyClick(element) {
      if (!visible(element) || element.disabled || element.getAttribute("aria-disabled") === "true") return false;
      const rect = element.getBoundingClientRect();
      const top = doc.elementFromPoint?.(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!top || !(top === element || element.contains(top))) return false;
      element.click();
      return true;
    }
    async function waitFor(read, timeout = 5000) {
      const end = now() + timeout;
      do { const value = read(); if (value) return value; await delay(120); } while (now() < end);
      return null;
    }
    function targetDialog(username, previousOption = null) {
      const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const mention = new RegExp(`(^|[^A-Za-z0-9._])@?${escaped}(?![A-Za-z0-9._])`, "i");
      const dialogs = all(doc, '[role="dialog"],dialog[open]').filter(visible);
      if (dialogs.length !== 1 || !mention.test(text(dialogs[0]))) return null;
      const buttons = controls(dialogs[0]).filter(element => matchesLabel(element, BLOCK_LABELS));
      if (controls(dialogs[0]).some(element => matchesLabel(element, OTHER_ACTION_LABELS))) return null;
      return buttons.length === 1 && buttons[0] !== previousOption ? { dialog: dialogs[0], button: buttons[0] } : null;
    }
    function inspect(args = {}) {
      const { username, actorUsername } = args;
      const found = USER.test(username || '') ? profileCandidates(username) : { identities: 0, candidates: [] };
      const actor = readableActorFromNavigation(), profile = profileUsernameFromUrl(href());
      const context = found.candidates.length === 1 ? found.candidates[0] : null;
      return { stage, currentProfileUsername: profile, expectedUsername: username || null, actorUsernameDetected: actor, targetMatches: !!profile && low(profile) === low(username), actorMatches: !!actor && low(actor) === low(actorUsername), mainCount: all(doc, 'main,[role="main"]').length, identityCandidateCount: found.identities, profileHeaderCandidateCount: found.candidates.length, hasProfileMenu: !!context?.menu, menuPopup: context?.menu?.getAttribute('aria-haspopup') || null, hasUnblock: !!context && controls(context.scope).some(element => matchesLabel(element, UNBLOCK_LABELS)), visibleDialogCount: all(doc, '[role="dialog"],dialog[open]').filter(visible).length, barrier: barrier() };
    }
    function result(status, username, actorUsername, reason, extra = {}) {
      const diagnostics = inspect({ username, actorUsername });
      return { status, username, actorUsername, reason: `[${stage}] ${reason}`, ...extra, evidence: { ...(extra.evidence || {}), diagnostics } };
    }
    async function perform(args) {
      const { username, actorUsername, phase, confirmationToken } = args || {};
      if (!["prepare", "confirm"].includes(phase)) return result("needs-attention", username, actorUsername, "未知的執行階段。");
      let finalActionAttempted = false; stage = phase === 'prepare' ? 'profile-ready' : 'confirm-guard';
      try {
        let current = guard(username, actorUsername);
        if (phase === 'prepare' && ['actor-missing', 'profile-missing'].includes(current.code)) {
          stage = 'profile-hydration';
          current = await waitFor(() => { const ready = guard(username, actorUsername); return ['actor-missing', 'profile-missing'].includes(ready.code) ? null : ready; }, 8000) || guard(username, actorUsername);
        }
        if (current.reason) return result("needs-attention", username, actorUsername, current.reason);
        if (phase === "prepare") {
          prepared = null;
          if (controls(current.context.scope).some(element => matchesLabel(element, UNBLOCK_LABELS))) return result("already-blocked", username, actorUsername, "目標個人檔案已顯示解除封鎖。");
          if (all(doc, '[role="dialog"],dialog[open]').some(visible)) return result("needs-attention", username, actorUsername, "已有其他對話框開啟，請先關閉後重試。");
          stage = 'profile-actions';
          if (!current.context.menu || !safelyClick(current.context.menu)) return result("needs-attention", username, actorUsername, "目標個人檔案選單被遮擋或無法點擊。");
          const opened = await waitFor(() => {
            const issue = guard(username, actorUsername); if (issue.reason) return { reason: issue.reason };
            const popups = all(doc, '[role="menu"],[role="dialog"],dialog[open]').filter(visible);
            const outer = popups.filter(node => !popups.some(other => other !== node && other.contains(node)));
            return outer.length === 1 ? { menu: outer[0] } : null;
          });
          if (!opened || opened.reason) return result("needs-attention", username, actorUsername, opened?.reason || "無法辨識唯一的個人檔案選單。");
          const menuControls = controls(opened.menu);
          if (menuControls.some(element => matchesLabel(element, UNBLOCK_LABELS))) return result("already-blocked", username, actorUsername, "目標選單已顯示解除封鎖。");
          if (opened.menu.getAttribute('role') === 'dialog' && !menuControls.some(element => matchesLabel(element, OTHER_ACTION_LABELS))) return result('needs-attention', username, actorUsername, '無法區分個人檔案動作選單與最終確認視窗，尚未送出封鎖。');
          const blockOptions = menuControls.filter(element => matchesLabel(element, BLOCK_LABELS));
          current = guard(username, actorUsername);
          if (current.reason || blockOptions.length !== 1 || !safelyClick(blockOptions[0])) return result("needs-attention", username, actorUsername, current.reason || "無法唯一辨識或點擊封鎖選項。");
          stage = 'block-confirmation';
          const dialog = await waitFor(() => {
            const issue = guard(username, actorUsername); if (issue.reason) return { reason: issue.reason };
            return targetDialog(username, blockOptions[0]);
          });
          if (!dialog || dialog.reason) return result("needs-attention", username, actorUsername, dialog?.reason || "封鎖確認視窗缺少精確目標帳號，或按鈕不唯一。");
          const token = env.token ? env.token() : root.crypto.randomUUID();
          prepared = { username: low(username), actor: low(actorUsername), token, dialog: dialog.dialog, scope: current.context.scope, href: href() };
          return result("prepared", username, actorUsername, "已核對目標並開啟確認視窗，尚未送出封鎖。", { confirmationToken: token, evidence: { targetProfileUrl: href(), actorSource: "profile-navigation", targetIdentity: username, confirmationMentionsExactUsername: true } });
        }
        const dialog = targetDialog(username);
        if (!prepared || prepared.token !== confirmationToken || prepared.username !== low(username) || prepared.actor !== low(actorUsername) || prepared.href !== href() || !dialog || dialog.dialog !== prepared.dialog || current.context.scope !== prepared.scope) return result("needs-attention", username, actorUsername, "確認授權或頁面上下文已失效，必須重新準備。");
        // Consume before the final click: an uncertain result may never be retried
        // with the same token and cannot accidentally toggle an unblock control.
        prepared = null; stage = 'block-submit';
        finalActionAttempted = true;
        if (!safelyClick(dialog.button)) return result("needs-attention", username, actorUsername, "封鎖確認按鈕被遮擋或已停用。");
        stage = 'block-verification';
        const outcome = await waitFor(() => {
          const issue = guard(username, actorUsername);
          if (issue.reason) return { reason: issue.reason };
          return controls(issue.context.scope).some(element => matchesLabel(element, UNBLOCK_LABELS)) ? { verified: true } : null;
        }, 6000);
        if (outcome?.verified) return result("success", username, actorUsername, "已確認目標個人檔案顯示解除封鎖。", { evidence: { verification: "target-profile-unblock-control" } });
        return result("unknown", username, actorUsername, outcome?.reason || "已送出封鎖，但沒有讀到目標已封鎖的明確狀態；不會自動重試。");
      } catch (error) {
        return result(finalActionAttempted ? "unknown" : "needs-attention", username, actorUsername, `頁面操作中斷：${error.message}`);
      }
    }
    return Object.freeze({ perform, readableActorFromNavigation, profileScope, targetDialog, inspect });
  }
  let live;
  const api = Object.freeze({ version: 2, profileUsernameFromUrl, exactAccessibleText, createAdapter, perform(args) { live ||= createAdapter({ document: root.document, location: root.location }); return live.perform(args); }, inspect(args) { live ||= createAdapter({ document: root.document, location: root.location }); return live.inspect(args); }, readableActorFromNavigation() { live ||= createAdapter({ document: root.document, location: root.location }); return live.readableActorFromNavigation(); } });
  root.ThreadsBlockAdapter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
