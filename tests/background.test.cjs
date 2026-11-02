"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionDir = path.join(__dirname, "../extension");
const source = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");

function mockBackground({ failInjection = 0 } = {}) {
  const events = [];
  let listener, injectionCount = 0;
  const context = vm.createContext({
    URL, crypto: require('node:crypto').webcrypto, setTimeout,
    chrome: {
      storage: { local: { async get() { return {}; }, async set() {} } },
      runtime: { onMessage: { addListener() {} } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
      action: {
        onClicked: { addListener(callback) { listener = callback; } },
        async setBadgeText(options) { events.push({ type: "badge", ...options }); },
        async setTitle(options) { events.push({ type: "title", ...options }); }
      },
      scripting: {
        async executeScript(options) {
          injectionCount++;
          events.push({ type: "inject", options });
          if (injectionCount === failInjection) throw new Error("Mock injection failed");
          if (options.func) options.func(...options.args);
          if (options.files) assert.equal(context.__threadsProbeTabId, options.target.tabId,
            "content injection requires its own tab identity to be installed first");
          return [];
        }
      }
    }
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(extensionDir, file), 'utf8'), context, {filename:file}));
  vm.runInContext(source, context, { filename: "background.js" });
  assert.equal(typeof listener, "function");
  return { context, events, click: listener };
}

test("manifest limits APIs and host access to the Threads blocking workflow", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "scripting", "storage"]);
  assert.deepEqual([...manifest.host_permissions].sort(), ['https://threads.com/*','https://threads.net/*','https://www.threads.com/*','https://www.threads.net/*']);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined, "the probe must require toolbar activation");
  assert.equal(manifest.action.default_popup, undefined);
  assert.deepEqual(manifest.background, { service_worker: "background.js" });
});

test("valid HTTPS Threads origins inject tab identity before bundled scripts", async () => {
  for (const host of ["threads.com", "www.threads.com", "threads.net", "www.threads.net"]) {
    const mock = mockBackground();
    await mock.click({ id: 81, url: `https://${host}/@alice/post/Example_1` });
    assert.deepEqual(mock.events.map(event => event.type), ["inject", "inject", "badge"]);
    const [bootstrap, scripts, badge] = mock.events;
    assert.equal(bootstrap.options.target.tabId, 81);
    assert.equal(typeof bootstrap.options.func, "function");
    assert.deepEqual(Array.from(bootstrap.options.args), [81]);
    assert.equal(mock.context.__threadsProbeTabId, 81);
    assert.deepEqual(Array.from(scripts.options.files), ["core.js", "content.js"]);
    assert.equal(scripts.options.target.tabId, 81);
    assert.deepEqual(badge, { type: "badge", tabId: 81, text: "" });
  }
});

test("other sites, lookalike hosts, HTTP and browser pages never inject", async () => {
  for (const url of [
    "https://example.com/", "https://threads.com.evil.example/@alice/post/A",
    "https://threads.com@evil.example/@alice/post/A", "http://threads.com/@alice/post/A",
    "https://name:secret@threads.com/@alice/post/A", "https://threads.com:444/@alice/post/A",
    "chrome://extensions/", "file:///C:/example.html", "javascript:alert(1)"
  ]) {
    const mock = mockBackground();
    await mock.click({ id: 82, url });
    assert.deepEqual(mock.events.map(event => event.type), ["badge", "title"], url);
    assert.equal(mock.events[0].text, "WEB", url);
    assert.match(mock.events[1].title, /Threads/, url);
  }
});

test("malformed or missing tab URL reports an error without injecting", async () => {
  for (const url of [undefined, "", "this is not a URL"]) {
    const mock = mockBackground();
    await mock.click({ id: 83, url });
    assert.deepEqual(mock.events.map(event => event.type), ["badge", "title"]);
    assert.equal(mock.events[0].text, "!");
    assert.match(mock.events[1].title, /無法開啟工具/);
  }
});

test("bootstrap injection failure prevents content injection and shows the failure", async () => {
  const mock = mockBackground({ failInjection: 1 });
  await mock.click({ id: 84, url: "https://www.threads.com/@alice/post/A" });
  assert.deepEqual(mock.events.map(event => event.type), ["inject", "badge", "title"]);
  assert.equal(mock.context.__threadsProbeTabId, undefined);
  assert.equal(mock.events[1].text, "!");
  assert.match(mock.events[2].title, /Mock injection failed/);
});

test("bundled script injection failure is reported and never clears the error badge", async () => {
  const mock = mockBackground({ failInjection: 2 });
  await mock.click({ id: 85, url: "https://www.threads.com/@alice/post/A" });
  assert.deepEqual(mock.events.map(event => event.type), ["inject", "inject", "badge", "title"]);
  assert.equal(mock.context.__threadsProbeTabId, 85);
  assert.equal(mock.events[2].text, "!");
  assert.match(mock.events[3].title, /Mock injection failed/);
});

test("missing tab id on an error does not attempt badge or title writes", async () => {
  const mock = mockBackground();
  await mock.click({ url: "malformed" });
  assert.deepEqual(mock.events, []);
});
