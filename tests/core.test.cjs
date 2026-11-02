"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../extension/core.js");

test("source pages preserve semantic query and hash while removing tracking", () => {
  assert.equal(core.sourcePage('https://threads.net/search?utm_source=share&q=user1&xmt=token&sort=recent#results'), 'https://www.threads.com/search?q=user1&sort=recent#results');
  assert.notEqual(core.sourcePage('https://www.threads.com/search?q=one'), core.sourcePage('https://www.threads.com/search?q=two'));
  assert.equal(core.sourcePage('https://www.threads.com/search?sort=recent&q=user1'), core.sourcePage('https://threads.net/search?q=user1&sort=recent'));
  assert.equal(core.sourcePage('https://evil.example/search?q=one'), null);
  assert.equal(core.sourcePage('https://u:pw@threads.com/'), null);
});

test("exposes the same API in Node and a browser-like global", () => {
  assert.equal(globalThis.ThreadsProbeCore, core);
  const context = { URL };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../extension/core.js"), "utf8"), context);
  assert.equal(typeof context.ThreadsProbeCore.canonicalTarget, "function");
  assert.equal(Object.isFrozen(context.ThreadsProbeCore), true);
});

test("canonical target accepts only HTTPS Threads post URLs and removes tracking", () => {
  for (const host of ["threads.com", "www.threads.com", "threads.net", "www.threads.net"]) {
    assert.deepEqual(core.canonicalTarget(`https://${host}/@a.b_c/post/Ab-C_12?x=1#reply`), {
      url: "https://www.threads.com/@a.b_c/post/Ab-C_12", username: "a.b_c", postId: "Ab-C_12"
    });
  }
  assert.equal(core.canonicalTarget("/@alice/post/Ab1").postId, "Ab1");
  assert.equal(core.canonicalTarget("./post/Ab1", "https://threads.net/@alice/profile").username, "alice");
});

test("target rejects untrusted hosts, credentials, schemes, paths and malformed input", () => {
  for (const input of [
    "https://threads.com.evil.test/@a/post/Ab1", "https://evil.test/@a/post/Ab1",
    "https://threads.com@evil.test/@a/post/Ab1", "https://a:secret@threads.com/@a/post/Ab1",
    "http://threads.com/@a/post/Ab1", "javascript:alert(1)", "data:text/html,hello",
    "https://threads.com:8443/@a/post/Ab1", "https://threads.com/@a/post/Ab1/extra",
    "https://threads.com/@a/post/Ab1/", "https://threads.com/@a", "https://threads.com/@a/post/",
    "https://threads.com/@a%2Fb/post/Ab1", "https://threads.com/@a/post/%41",
    "https://threads.com/@a-b/post/Ab1", `https://threads.com/@${"a".repeat(31)}/post/Ab1`,
    "https://threads.com\n.evil.test/@a/post/Ab1", {}, null, 0
  ]) assert.equal(core.canonicalTarget(input), null, String(input));
});

test("profile URLs are canonical and reject non-profile paths and untrusted inputs", () => {
  assert.deepEqual(core.profileFromHref("/@User.Name_1/?a=b#x"), {
    username: "User.Name_1", profileUrl: "https://www.threads.com/@User.Name_1"
  });
  assert.equal(core.profileFromHref("https://threads.net/@alice").username, "alice");
  for (const input of ["/@alice/post/Ab1", "/@alice/followers", "/@", "/@a-b", "/@a%2eb", "/@a//",
    `/@${"a".repeat(31)}`, "http://threads.com/@a", "https://evil.test/@a", "https://a@threads.com/@a",
    "https://threads.com:8080/@a", "javascript:alert(1)", null]) {
    assert.equal(core.profileFromHref(input), null, String(input));
  }
});

test("counts accept exact safe nonnegative integers only", () => {
  for (const [input, output] of [[0, 0], [12, 12], ["0", 0], ["1234", 1234], ["1,234", 1234],
    ["12,345,678", 12345678], [" 42 ", 42], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) {
    assert.equal(core.normalizeCounts(input), output);
  }
  for (const input of ["1.2K", "1萬", "-1", -1, "1.0", 1.2, "1,23", "1234,567", "", " ",
    "1,234 likes", "1 234", "1e3", "0x10", Infinity, NaN, null, true, [], {}, "9007199254740992"]) {
    assert.equal(core.normalizeCounts(input), null, String(input));
  }
});

test("merge deduplicates case-insensitively, preserves labels and original first seen", () => {
  const previousTime = "2026-11-02T01:00:00.000Z";
  const now = "2026-11-02T02:00:00.000Z";
  const existing = [{ username: "Alice", profileUrl: "https://evil.test/@Alice", label: "Original",
    firstSeenAt: previousTime, lastSeenAt: previousTime }, { username: "BOB", label: "" }];
  const incoming = [{ username: "alice", label: "New" }, { username: "bob", label: "Bob" },
    { username: "charlie", label: " Charlie " }, { username: "CHARLIE", label: "Other" },
    { username: "bad/name" }, { username: "@bad" }, null];
  const snapshot = JSON.stringify([existing, incoming]);
  Object.freeze(existing[0]); Object.freeze(existing); Object.freeze(incoming);
  const result = core.mergeAccounts(existing, incoming, now);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], { username: "Alice", profileUrl: "https://www.threads.com/@Alice", label: "Original",
    firstSeenAt: previousTime, lastSeenAt: now });
  assert.equal(result[1].label, "Bob");
  assert.equal(result[2].label, "Charlie");
  assert.equal(result[2].firstSeenAt, now);
  assert.equal(result[2].lastSeenAt, now);
  assert.equal(JSON.stringify([existing, incoming]), snapshot);
  assert.notEqual(result[0], existing[0]);
});

test("merge preserves untouched last-seen times and handles empty arrays", () => {
  const record = { username: "alice", label: "A", firstSeenAt: "before", lastSeenAt: "yesterday" };
  assert.equal(core.mergeAccounts([record], [], "now")[0].lastSeenAt, "yesterday");
  assert.deepEqual(core.mergeAccounts(null, null, "now"), []);
  assert.equal(core.mergeAccounts([], [{ username: "a" }], "now")[0].label, "");
});

test("CSV fields quote delimiters and prevent spreadsheet formula injection", () => {
  assert.equal(core.csvCell('a,"b"\nc'), '"a,""b""\nc"');
  assert.equal(core.csvCell(null), '""');
  assert.equal(core.csvCell("normal"), '"normal"');
  for (const input of ["=SUM(A1:A2)", "+1+1", "-2+3", "@alice", "\tformula", "\rformula", "\nformula",
    "   =HYPERLINK(\"https://evil.test\")", "\uFEFF@formula"]) {
    assert.equal(core.csvCell(input).startsWith('"\''), true, input);
  }
});
