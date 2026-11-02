(function (root) {
  "use strict";

  const Core = root.ThreadsProbeCore || (typeof require === "function" ? require("./core.js") : null);
  if (!Core) throw new Error("ThreadsProbeCore must load before ThreadsBlockJob");
  const USERNAME = /^[A-Za-z0-9._]{1,30}$/;
  const RESULT_STATUSES = new Set(["success", "already-blocked", "skipped", "failed", "unknown", "needs-attention"]);
  const MAX_ITEMS = 10000;
  const copy = value => JSON.parse(JSON.stringify(value));
  const key = value => value.toLowerCase();

  function time(value) {
    if (value === undefined) return new Date().toISOString();
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid timestamp");
    return new Date(value).toISOString();
  }

  function actorName(value) {
    if (typeof value !== "string" || !USERNAME.test(value.trim().replace(/^@/, ""))) throw new Error("Invalid actor username");
    return value.trim().replace(/^@/, "");
  }

  function currentItem(job) {
    return job.current == null ? null : job.items.find(item => key(item.username) === key(job.current));
  }

  function createJob(input, nowISO) {
    if (!input || typeof input !== "object") throw new Error("Missing job input");
    const actorUsername = actorName(input.actorUsername);
    const rawTarget = input.target;
    const target = Core.canonicalTarget(typeof rawTarget === "string" ? rawTarget : rawTarget?.url);
    if (!target) throw new Error("Invalid target URL");
    if (typeof rawTarget === "object" && rawTarget) {
      if (rawTarget.username && key(rawTarget.username) !== key(target.username)) throw new Error("Target username does not match URL");
      if (rawTarget.postId && rawTarget.postId !== target.postId) throw new Error("Target post ID does not match URL");
    }
    if (!Number.isInteger(input.sourceTabId) || input.sourceTabId < 0) throw new Error("Invalid source tab ID");
    if (!Array.isArray(input.accounts)) throw new Error("Accounts must be an array");
    const now = time(nowISO), items = [], seen = new Set();
    for (const account of input.accounts) {
      if (!account || typeof account.username !== "string" || !USERNAME.test(account.username)) throw new Error("Invalid account username");
      const profile = Core.profileFromHref(account.profileUrl);
      if (!profile || key(profile.username) !== key(account.username)) throw new Error("Account profile URL does not match username");
      const id = key(account.username);
      if (id === key(actorUsername) || id === key(target.username) || seen.has(id)) continue;
      seen.add(id);
      items.push({ username: account.username, profileUrl: `https://www.threads.com/@${account.username}`, role: "liker", status: "pending", attempts: 0, reason: "", startedAt: null, finishedAt: null });
    }
    const includeAuthor = input.includeAuthor === true;
    if (includeAuthor && key(target.username) !== key(actorUsername)) {
      items.push({ username: target.username, profileUrl: `https://www.threads.com/@${target.username}`, role: "author", status: "pending", attempts: 0, reason: "", startedAt: null, finishedAt: null });
    }
    if (items.length === 0) throw new Error("No eligible accounts selected");
    if (items.length > MAX_ITEMS) throw new Error("A job can contain at most 10000 accounts");
    const id = typeof input.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(input.id)
      ? input.id
      : (root.crypto?.randomUUID ? root.crypto.randomUUID() : (typeof require === "function" ? require("node:crypto").randomUUID() : null));
    if (!id) throw new Error("Cannot create job identifier");
    return {
      schemaVersion: 1, id, status: "running", sourceTabId: input.sourceTabId, actorUsername,
      target: { ...target, kind: rawTarget?.kind === "reply" ? "reply" : "post" }, includeAuthor,
      items, current: null, workerTabId: null, reason: "", createdAt: now, updatedAt: now, finishedAt: null
    };
  }

  function nextItem(job, nowISO) {
    const next = copy(job), now = time(nowISO);
    if (next.status !== "running" || next.current != null) return next;
    if (next.items.some(item => item.status === "in-progress")) {
      next.status = "paused"; next.reason = "Untracked in-progress item; recovery is required"; next.updatedAt = now; return next;
    }
    const item = next.items.find(item => item.status === "pending");
    if (!item) {
      next.status = "completed"; next.reason = "No pending accounts remain"; next.updatedAt = now; next.finishedAt = now; return next;
    }
    // A pending item with an earlier dispatch is inconsistent. Never retry it.
    if (item.attempts !== 0) {
      item.status = "unknown"; item.reason = "Previously dispatched item will not be retried automatically"; item.finishedAt = now;
      next.status = "paused"; next.reason = item.reason; next.updatedAt = now; return next;
    }
    item.status = "in-progress"; item.attempts = 1; item.startedAt = now;
    next.current = item.username; next.updatedAt = now;
    return next;
  }

  function recordResult(job, username, result, nowISO) {
    if (typeof username !== "string" || !job.current || key(job.current) !== key(username)) throw new Error("Result does not match the current account");
    if (!result || !RESULT_STATUSES.has(result.status)) throw new Error("Invalid result status");
    const next = copy(job), now = time(nowISO), item = currentItem(next);
    if (!item) throw new Error("Current account is missing from job items");
    item.status = result.status; item.reason = typeof result.reason === "string" ? result.reason : ""; item.finishedAt = now;
    if (result.evidence !== undefined) item.evidence = copy(result.evidence);
    next.current = null; next.updatedAt = now;
    if (next.status === "stopped") return next;
    if (["unknown", "needs-attention"].includes(result.status)) {
      next.status = "paused"; next.reason = item.reason || "Manual verification is required";
    } else if (next.status === "running" && !next.items.some(row => row.status === "pending")) {
      next.status = "completed"; next.reason = "No pending accounts remain"; next.finishedAt = now;
    }
    return next;
  }

  function pause(job, nowISO) {
    const next = copy(job);
    if (next.status !== "running") return next;
    next.status = "paused"; next.reason = "Paused by user; an already dispatched action may still finish"; next.updatedAt = time(nowISO);
    return next;
  }

  function resume(job, nowISO) {
    const next = copy(job);
    if (next.status !== "paused") return next;
    next.updatedAt = time(nowISO);
    if (next.current != null) {
      next.reason = "Wait for the current action to finish before resuming";
      return next;
    }
    if (!next.items.some(item => item.status === "pending")) {
      next.reason = "No pending accounts remain; review unresolved results or stop this job";
      return next;
    }
    next.status = "running"; next.reason = "Resumed by user; unresolved accounts will not be retried";
    return next;
  }

  function stop(job, nowISO) {
    const next = copy(job);
    if (["stopped", "completed"].includes(next.status)) return next;
    const now = time(nowISO);
    for (const item of next.items) {
      if (item.status === "pending") { item.status = "cancelled"; item.reason = "Cancelled by user"; item.finishedAt = now; }
    }
    const item = currentItem(next);
    if (item) { item.status = "unknown"; item.reason = "Stopped while action was in flight; outcome is unknown until reported"; item.finishedAt = now; }
    next.status = "stopped"; next.reason = "Stopped by user; pending accounts cancelled"; next.updatedAt = now; next.finishedAt = now;
    // Retain current so the in-flight operation can report its actual outcome.
    return next;
  }

  function recover(job, nowISO) {
    const next = copy(job), now = time(nowISO);
    const interrupted = next.status === "running" || next.current != null || next.items.some(item => item.status === "in-progress");
    if (!interrupted) return next;
    for (const item of next.items) {
      if (item.status === "in-progress" || (next.current && key(item.username) === key(next.current))) {
        item.status = "unknown"; item.reason = "Interrupted action; verify manually, never retry automatically"; item.finishedAt = now;
      }
    }
    next.current = null; next.updatedAt = now;
    if (next.status !== "stopped") {
      next.status = "paused"; next.reason = "Recovered after interruption; explicit resume is required";
    }
    return next;
  }

  // Call only after the worker has explicitly reported that preparation ended
  // without sending the final block confirmation. Unknown outcomes must never
  // use this path. This restores eligibility without scheduling any work.
  function deferPrepared(job, username, reason, nowISO) {
    if (job.status === "stopped") return copy(job);
    if (!["running", "paused"].includes(job.status)) throw new Error("Only active preparation can be deferred");
    if (typeof username !== "string" || !job.current || key(job.current) !== key(username)) throw new Error("Deferred preparation does not match the current account");
    const next = copy(job), item = currentItem(next), now = time(nowISO);
    if (!item || item.status !== "in-progress") throw new Error("Only an in-progress preparation can be deferred");
    item.status = "pending"; item.attempts = 0; item.startedAt = null; item.finishedAt = null;
    item.reason = typeof reason === "string" ? reason : "Preparation deferred before final confirmation";
    item.preparationsDeferred = (item.preparationsDeferred || 0) + 1;
    item.lastDeferredAt = now;
    next.current = null; next.status = "paused"; next.reason = item.reason; next.updatedAt = now;
    return next;
  }

  const api = Object.freeze({ createJob, nextItem, recordResult, pause, resume, stop, recover, deferPrepared });
  root.ThreadsBlockJob = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
