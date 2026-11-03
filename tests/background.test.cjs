"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionDir = path.join(__dirname, "../extension");
const source = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");

function mockBackground({ failInjection = 0, probe = null, host = null, duplicateHosts = false, failReload = false, reloadStates = [], savedJob = null, reloadGate = null, injectedVersion = '0.4.2', failReloadIdentityReads = 0, runtimeVersion = '0.4.2' } = {}) {
  const events = [];
  let listener, messageListener, injectionCount = 0, currentTab, reloading = false, reloadIndex = 0, reloadAttempted = false;
  const context = vm.createContext({
    URL, crypto: require('node:crypto').webcrypto, setTimeout,
    document: { getElementById(id) { return id === 'threads-likes-probe-host' ? host : null; }, querySelectorAll(selector) { return selector === '#threads-likes-probe-host' && host ? (duplicateHosts ? [host, host] : [host]) : []; } },
    __threadsLikesProbe: probe,
    chrome: {
      storage: { local: { async get() { return savedJob ? { 'threadsBlocker.job.v1': savedJob } : {}; }, async set(value) { events.push({ type: 'save', value: JSON.parse(JSON.stringify(value)) }); } } },
      runtime: { id: 'fixture-extension', getManifest() { return { version: runtimeVersion }; }, onMessage: { addListener(fn) { messageListener = fn; } } },
      tabs: {
        onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        async get() {
          if (reloading) {
            const next = reloadStates[reloadIndex++] || { status: 'complete' };
            Object.assign(currentTab, next);
            if (next.status === 'complete' && next.freshDocument !== false) { context.__threadsLikesProbe = undefined; host = null; reloading = false; }
          }
          return { ...currentTab };
        },
        async reload(id) { events.push({ type: 'reload', id }); if (failReload) throw new Error('Mock reload failed'); if (reloadGate) await reloadGate; reloading = true; reloadAttempted = true; }
      },
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
          if (options.func && !options.args && reloadAttempted && failReloadIdentityReads > 0) { failReloadIdentityReads--; throw new Error('Frame context was destroyed during navigation'); }
          if (options.func) return [{ result: options.func(...(options.args || [])) }];
          if (options.files) {
            assert.equal(context.__threadsProbeTabId, options.target.tabId, "content injection requires its own tab identity to be installed first");
            context.__threadsLikesProbe = injectedVersion ? { version: injectedVersion, extensionId: 'fixture-extension' } : { show() {} };
            host = { dataset: injectedVersion ? { panelVersion: injectedVersion, extensionId: 'fixture-extension' } : {} }; duplicateHosts = false;
          }
          return [];
        }
      }
    }
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(extensionDir, file), 'utf8'), context, {filename:file}));
  vm.runInContext(source, context, { filename: "background.js" });
  assert.equal(typeof listener, "function");
  return { context, events, ready: vm.runInContext('ready', context), click: async tab => { currentTab = { status: 'complete', ...tab }; return listener(tab); }, message: (value, from) => new Promise(resolve => messageListener(value, from, resolve)) };
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
    assert.deepEqual(mock.events.map(event => event.type), ["inject", "inject", "inject", "inject", "badge"]);
    const [identity, bootstrap, scripts, verified, badge] = mock.events;
    assert.equal(identity.options.target.tabId, 81);
    assert.equal(bootstrap.options.target.tabId, 81);
    assert.equal(typeof bootstrap.options.func, "function");
    assert.deepEqual(Array.from(bootstrap.options.args), [81]);
    assert.equal(mock.context.__threadsProbeTabId, 81);
    assert.deepEqual(Array.from(scripts.options.files), ["core.js", "content.js"]);
    assert.equal(scripts.options.target.tabId, 81);
    assert.equal(verified.options.target.tabId, 81);
    assert.deepEqual(badge, { type: "badge", tabId: 81, text: "" });
  }
});

test("a mixed background and runtime build refuses toolbar injection before opening or reloading a panel", async () => {
  const mock = mockBackground({ runtimeVersion: '0.3.0' });
  await mock.click({ id: 86, url: 'https://www.threads.com/@alice/post/A' });
  assert.equal(mock.events.some(event => ['inject','reload','save'].includes(event.type)), false);
  assert.equal(mock.events.at(-2).text, '!');assert.match(mock.events.at(-1).title, /背景程式版本 0\.4\.2 與套件版本 0\.3\.0/);
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

test("identity or bootstrap injection failure prevents content injection and shows the failure", async () => {
  for (const failInjection of [1, 2]) {
    const mock = mockBackground({ failInjection });
    await mock.click({ id: 84, url: "https://www.threads.com/@alice/post/A" });
    assert.equal(mock.events.some(event => event.options?.files), false);
    assert.equal(mock.context.__threadsProbeTabId, undefined);
    assert.equal(mock.events.at(-2).text, "!");
    assert.match(mock.events.at(-1).title, /Mock injection failed/);
  }
});

test("bundled script injection failure is reported and never clears the error badge", async () => {
  const mock = mockBackground({ failInjection: 3 });
  await mock.click({ id: 85, url: "https://www.threads.com/@alice/post/A" });
  assert.deepEqual(mock.events.map(event => event.type), ["inject", "inject", "inject", "badge", "title"]);
  assert.equal(mock.context.__threadsProbeTabId, 85);
  assert.equal(mock.events[3].text, "!");
  assert.match(mock.events[4].title, /Mock injection failed/);
});

test("a compatible panel is reused without reloading or writing a job", async () => {
  const mock = mockBackground({ probe: { version: '0.4.2', extensionId: 'fixture-extension' }, host: { dataset: { panelVersion: '0.4.2', extensionId: 'fixture-extension' } } });
  await mock.click({ id: 91, url: 'https://www.threads.com/@alice/post/A' });
  assert.equal(mock.events.some(event => ['reload', 'save'].includes(event.type)), false);
  assert.deepEqual(Array.from(mock.events.find(event => event.options?.files).options.files), ['core.js', 'content.js']);
});

test("legacy, missing-host and other-copy panels get one cold reload before new injection", async () => {
  for (const panel of [
    { probe: { show() {} }, host: { dataset: {} } },
    { probe: { version: '0.4.0', extensionId: 'fixture-extension' }, host: { dataset: { panelVersion: '0.4.0', extensionId: 'fixture-extension' } } },
    { probe: { version: '0.4.2', extensionId: 'fixture-extension' }, host: null },
    { probe: null, host: { dataset: { panelVersion: '0.4.2', extensionId: 'another-extension' } } },
    { probe: { version: '0.4.2', extensionId: 'another-extension' }, host: { dataset: { panelVersion: '0.4.2', extensionId: 'another-extension' } } },
    { probe: { version: '0.4.2', extensionId: 'fixture-extension' }, host: { dataset: { panelVersion: '0.3.0', extensionId: 'another-extension' } } },
    { probe: { version: '0.4.2', extensionId: 'fixture-extension' }, host: { dataset: { panelVersion: '0.4.2', extensionId: 'fixture-extension' } }, duplicateHosts: true }
  ]) {
    const mock = mockBackground(panel);
    await mock.click({ id: 92, url: 'https://www.threads.com/@alice/post/A' });
    assert.equal(mock.events.filter(event => event.type === 'reload').length, 1);
    assert.ok(mock.events.findIndex(event => event.type === 'reload') < mock.events.findIndex(event => event.options?.files));
    assert.equal(mock.events.at(-1).text, '');
  }
});

test("the old complete document cannot satisfy reload readiness", async () => {
  const mock = mockBackground({ probe: { show() {} }, host: { dataset: {} }, reloadStates: [{ status: 'complete', freshDocument: false }, { status: 'loading' }, { status: 'complete' }] });
  await mock.click({ id: 93, url: 'https://www.threads.com/@alice/post/A' });
  assert.equal(mock.events.filter(event => event.type === 'reload').length, 1);
  assert.equal(mock.events.filter(event => event.options?.func && !event.options.args).length, 4, 'initial, old document, fresh document, post-injection identities');
  assert.equal(mock.events.at(-1).text, '');
});

test("mixed-package content fails post-injection validation without a second reload", async () => {
  for (const injectedVersion of ['0.3.0', null]) {
    const mock = mockBackground({ probe: { show() {} }, host: { dataset: {} }, injectedVersion });
    await mock.click({ id: 97, url: 'https://www.threads.com/@alice/post/A' });
    assert.equal(mock.events.filter(event => event.type === 'reload').length, 1);
    assert.equal(mock.events.filter(event => event.options?.files).length, 1);
    assert.equal(mock.events.at(-2).text, '!');
    assert.match(mock.events.at(-1).title, /面板與套件版本或來源不一致/);
    assert.equal(mock.events.some(event => event.type === 'badge' && event.text === ''), false);
  }
});

test("a transient identity-read failure during reload waits for a fresh document", async () => {
  const mock = mockBackground({ probe: { show() {} }, host: { dataset: {} }, failReloadIdentityReads: 1 });
  await mock.click({ id: 98, url: 'https://www.threads.com/@alice/post/A' });
  assert.equal(mock.events.filter(event => event.type === 'reload').length, 1);
  assert.equal(mock.events.filter(event => event.options?.files).length, 1);
  const filesIndex = mock.events.findIndex(event => event.options?.files);
  assert.equal(mock.events.slice(0, filesIndex).filter(event => event.options?.func && !event.options.args).length, 3, 'initial, interrupted, successful fresh-document reads before injection');
  assert.equal(mock.events.at(-1).text, '');
});

test("panel upgrade pauses its source job and saves before reloading", async () => {
  const Jobs = require('../extension/job.js');
  const task = Jobs.createJob({ accounts: [{ username: 'victim', profileUrl: 'https://www.threads.com/@victim' }], actorUsername: 'owner', target: { url: 'https://www.threads.com/@alice/post/A', kind: 'post' }, sourceTabId: 94 }, new Date().toISOString());
  const mock = mockBackground({ probe: { show() {} }, host: { dataset: {} }, savedJob: task });
  await mock.ready; mock.events.length = 0;
  vm.runInContext("job.status = 'running'", mock.context);
  await mock.click({ id: 94, url: 'https://www.threads.com/@alice/post/A' });
  const saved = mock.events.find(event => event.type === 'save');
  assert.equal(saved.value['threadsBlocker.job.v1'].status, 'paused');
  assert.match(saved.value['threadsBlocker.job.v1'].reason, /工具版本已更新/);
  assert.ok(mock.events.indexOf(saved) < mock.events.findIndex(event => event.type === 'reload'));
  assert.equal(mock.events.some(event => event.options?.args?.[0]?.phase), false);
});

test("old panels cannot start or resume a job while their source is upgrading", async () => {
  let releaseReload;
  const reloadGate = new Promise(resolve => { releaseReload = resolve; });
  const mock = mockBackground({ probe: { show() {} }, host: { dataset: {} }, reloadGate });
  const tab = { id: 96, url: 'https://www.threads.com/@alice/post/A' };
  const opening = mock.click(tab);
  while (!mock.events.some(event => event.type === 'reload')) await new Promise(resolve => setImmediate(resolve));
  try {
    for (const type of ['BLOCK_START', 'BLOCK_RESUME']) {
      const response = await mock.message({ type, confirmed: true }, { tab });
      assert.equal(response.ok, false); assert.match(response.error, /正在更新/);
    }
    assert.equal(vm.runInContext('job', mock.context), null);
  } finally { releaseReload(); await opening; }
});

test("reload failures and navigation to a different source never inject the new panel", async () => {
  for (const options of [
    { failReload: true },
    { reloadStates: [{ status: 'complete', url: 'https://www.threads.com/@alice/post/B' }] },
    { reloadStates: [{ status: 'loading', url: 'https://example.com/' }] },
    { reloadStates: [{ status: 'complete', url: 'https://www.threads.com/search?q=changed' }] }
  ]) {
    const mock = mockBackground({ probe: { show() {} }, host: { dataset: {} }, ...options });
    await mock.click({ id: 95, url: 'https://www.threads.com/@alice/post/A' });
    assert.equal(mock.events.filter(event => event.type === 'reload').length, 1);
    assert.equal(mock.events.some(event => event.options?.files), false);
    assert.equal(mock.events.at(-2).text, '!');
  }
});

test("missing tab id on an error does not attempt badge or title writes", async () => {
  const mock = mockBackground();
  await mock.click({ url: "malformed" });
  assert.deepEqual(mock.events, []);
});
