(function (root) {
  "use strict";

  const ORIGIN = "https://www.threads.com";
  const HOSTS = new Set(["threads.com", "www.threads.com", "threads.net", "www.threads.net"]);
  const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

  function threadsUrl(raw, base) {
    if (typeof raw !== "string" || /[\u0000-\u001f\u007f]/.test(raw)) return null;
    try {
      const url = new URL(raw, base === undefined ? ORIGIN : base);
      if (url.protocol !== "https:" || !HOSTS.has(url.hostname) || url.username || url.password || url.port) return null;
      return url;
    } catch (_) {
      return null;
    }
  }

  function canonicalTarget(raw, base) {
    const url = threadsUrl(raw, base);
    if (!url) return null;
    const match = /^\/@([A-Za-z0-9._]{1,30})\/post\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (!match) return null;
    const [, username, postId] = match;
    return { url: `${ORIGIN}/@${username}/post/${postId}`, username, postId };
  }

  function profileFromHref(raw, base) {
    const url = threadsUrl(raw, base);
    if (!url) return null;
    const match = /^\/@([A-Za-z0-9._]{1,30})\/?$/.exec(url.pathname);
    if (!match) return null;
    const username = match[1];
    return { username, profileUrl: `${ORIGIN}/@${username}` };
  }

  function normalizeCounts(raw) {
    if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
    if (typeof raw !== "string") return null;
    const value = raw.trim();
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value)) return null;
    const number = Number(value.replace(/,/g, ""));
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }

  function sourcePage(raw, base) {
    const url = threadsUrl(raw, base);
    if (!url) return null;
    for (const name of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(name) || /^(?:xmt|igsh|igshid|fbclid|gclid)$/i.test(name)) url.searchParams.delete(name);
    }
    url.searchParams.sort();
    return `${ORIGIN}${url.pathname}${url.search}${url.hash}`;
  }

  function mergeAccounts(existingArray, incomingArray, nowISO) {
    const accounts = new Map();
    const now = typeof nowISO === "string" ? nowISO : "";
    function add(raw, incoming) {
      if (!raw || typeof raw !== "object" || typeof raw.username !== "string" || !USERNAME.test(raw.username)) return;
      const key = raw.username.toLowerCase();
      const label = typeof raw.label === "string" ? raw.label.trim() : "";
      const previous = accounts.get(key);
      if (previous) {
        if (!previous.label && label) previous.label = label;
        if (incoming) previous.lastSeenAt = now;
        return;
      }
      accounts.set(key, {
        username: raw.username,
        profileUrl: `${ORIGIN}/@${raw.username}`,
        label,
        firstSeenAt: typeof raw.firstSeenAt === "string" && raw.firstSeenAt ? raw.firstSeenAt : now,
        lastSeenAt: incoming ? now : (typeof raw.lastSeenAt === "string" && raw.lastSeenAt ? raw.lastSeenAt : now)
      });
    }
    if (Array.isArray(existingArray)) existingArray.forEach((item) => add(item, false));
    if (Array.isArray(incomingArray)) incomingArray.forEach((item) => add(item, true));
    return Array.from(accounts.values());
  }

  function csvCell(value) {
    let text = value === null || value === undefined ? "" : String(value);
    // Prefix formula-like values before RFC 4180 quoting. Leading whitespace must
    // not allow spreadsheet applications to interpret a later formula marker.
    if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  const api = Object.freeze({ canonicalTarget, profileFromHref, normalizeCounts, sourcePage, mergeAccounts, csvCell });
  root.ThreadsProbeCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
