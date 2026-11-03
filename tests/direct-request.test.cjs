'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../extension/request-probe-core.js');
const code = fs.readFileSync(require('node:path').join(__dirname, '../extension/direct-request.js'), 'utf8');
const url = 'https://www.threads.com/api/graphql';
const variables = { user_id: '123456', container_module: 'fixture_profile', media_id: null, barcelona_source_quote_post_id: null, barcelona_source_reply_id: null, is_messaging_nua: null, consistent_thread_fbid: null };
const body = (changes = {}) => new URLSearchParams({ fb_api_req_friendly_name: 'useTHUserBlockMutation', doc_id: '12345', fb_dtsg: 'PRIVATE_TOKEN', variables: JSON.stringify(variables), ...changes }).toString();
function fixture(options = {}) {
  const calls = [], timers = [];
  const fetch = async (...args) => { calls.push(args); if (options.reject) throw new Error('offline'); return new Response(JSON.stringify(options.response || { data: { block: { status: 'ok' } } }), { status: options.status || 200 }); };
  class XHR { open(...args) { this.openArgs = args; } setRequestHeader(...args) { (this.headers ||= []).push(args); } send(value) { this.sent = value; return 'original'; } }
  const context = vm.createContext({ ThreadsRequestProbeCore: Core, URL, URLSearchParams, Headers, AbortController, fetch, XMLHttpRequest: XHR,
    location: { href: 'https://www.threads.com/@victim' }, document: { visibilityState: 'visible' },
    setTimeout(fn, ms) { const t = { fn, ms }; timers.push(t); return t; }, clearTimeout(t) { if (t) t.cleared = true; } });
  vm.runInContext(code, context);
  const api = context.ThreadsDirectRequest;
  function request(payload = body(), endpoint = url) { const xhr = new XHR(); xhr.open('POST', endpoint, true); xhr.setRequestHeader('content-type', 'application/x-www-form-urlencoded'); xhr.setRequestHeader('x-fb-lsd', 'PRIVATE_HEADER'); xhr.send(payload); return xhr; }
  return { api, context, calls, timers, XHR, fetch, request };
}
test('holds the website XHR and submits the exact body once without exporting credentials', async () => {
  const f = fixture(); f.api.arm({ username: 'victim' }); const payload = body(), xhr = f.request(payload);
  assert.equal(xhr.sent, undefined); assert.equal(f.calls.length, 0); assert.equal(f.api.status().captured, true);
  const result = await f.api.submit(); assert.equal(result.attempted, true); assert.equal(result.accepted, true);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], url); assert.equal(f.calls[0][1].body, payload);
  assert.equal(f.calls[0][1].headers.get('x-fb-lsd'), 'PRIVATE_HEADER'); assert.equal(f.calls[0][1].credentials, 'same-origin');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(result.report.records[0].response.status, 200);
  assert.equal((await f.api.submit()).attempted, false); assert.equal(f.calls.length, 1); f.api.dispose();
});
test('unsupported schema, operation and endpoint are never directly submitted', async () => {
  for (const [payload, endpoint] of [[body({ variables: JSON.stringify({ ...variables, block_on_instagram: true }) }), url], [body({ fb_api_req_friendly_name: 'OtherBlockMutation' }), url], [body(), url + '?other=1'], [body(), 'https://i.instagram.com/api/graphql']]) {
    const f = fixture(); f.api.arm({ username: 'victim' }); const xhr = f.request(payload, endpoint);
    assert.equal(xhr.sent, undefined); assert.equal(f.api.status().refused, true); assert.equal((await f.api.submit()).attempted, false); assert.equal(f.calls.length, 0); f.api.dispose();
  }
});
test('multiple candidate requests are suppressed and invalidate direct submission', async () => {
  const f = fixture(); f.api.arm({ username: 'victim' }); f.request(); f.request();
  assert.equal(f.api.status().refused, true); assert.equal((await f.api.submit()).attempted, false); assert.equal(f.calls.length, 0); f.api.dispose();
});
test('pause cleanup, hidden page, navigation and expiration prevent a held request from being sent', async () => {
  for (const change of [f => f.api.dispose(), f => { f.context.document.visibilityState = 'hidden'; }, f => { f.context.location.href = 'https://www.threads.com/@other'; }, f => f.timers.find(t => t.ms === 90000).fn()]) {
    const f = fixture(); f.api.arm({ username: 'victim' }); f.request(); change(f); assert.equal((await f.api.submit()).attempted, false); assert.equal(f.calls.length, 0); f.api.dispose();
  }
});
test('network errors, HTTP errors and GraphQL errors never retry or claim acceptance', async () => {
  for (const options of [{ reject: true }, { status: 429 }, { response: { errors: [{ message: 'PRIVATE_ERROR' }] } }]) {
    const f = fixture(options); f.api.arm({ username: 'victim' }); f.request(); const result = await f.api.submit();
    assert.equal(result.attempted, true); assert.equal(result.accepted, false); assert.equal((await f.api.submit()).attempted, false); assert.equal(f.calls.length, 1); assert.equal(JSON.stringify(result).includes('PRIVATE'), false); f.api.dispose();
  }
});
test('unrelated reads retain the website transport and cleanup restores hooks', () => {
  const f = fixture(), open = f.XHR.prototype.open, send = f.XHR.prototype.send;
  f.api.arm({ username: 'victim' }); const xhr = f.request('fb_api_req_friendly_name=ProfileQuery'); assert.equal(xhr.sent, 'fb_api_req_friendly_name=ProfileQuery');
  f.api.dispose(); assert.equal(f.context.fetch, f.fetch); assert.equal(f.XHR.prototype.open, open); assert.equal(f.XHR.prototype.send, send);
});
test('wrong profile binding fails before installing hooks', () => {
  const f = fixture(); assert.throws(() => f.api.arm({ username: 'other' }), /binding/); assert.equal(f.context.fetch, f.fetch);
});
test('held fetch is resolved by the single direct response without a second website send', async () => {
  const f = fixture(); f.api.arm({ username: 'victim' }); const pending = f.context.fetch(url, { method: 'POST', body: body() });
  assert.equal(f.calls.length, 0); const result = await f.api.submit(); assert.equal(result.accepted, true); assert.equal((await pending).status, 200); assert.equal(f.calls.length, 1); f.api.dispose();
});
