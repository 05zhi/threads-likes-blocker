'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../extension/request-probe-core.js');
const source = fs.readFileSync(path.join(__dirname, '../extension/request-probe.js'), 'utf8');
const url = 'https://www.threads.com/api/graphql/?secret=NEVER_EXPORT';
const body = () => new URLSearchParams({ fb_api_req_friendly_name: 'FixtureBlockMutation', doc_id: '123456', fb_dtsg: 'PRIVATE_CSRF', lsd: 'PRIVATE_LSD', variables: JSON.stringify({ input: { target_user_id: '98765', block_on_instagram: false, block_type: 'threads_only', password: 'PRIVATE_PASSWORD', token: 'PRIVATE_TOKEN', arbitrary: 'PRIVATE_CONTENT' } }) }).toString();
function fixture({ reject = false, delayedXHR = false } = {}) {
  const calls = [], timers = [], response = new Response(JSON.stringify({ data: { block: { user_id: '98765', blocking: true, session_token: 'PRIVATE_RESPONSE' } } }), { status: 200 });
  const promise = reject ? Promise.reject(new Error('network failure')) : Promise.resolve(response);
  promise.catch(() => {});
  function fetch(...args) { calls.push(args); return promise; }
  class XHR {
    constructor() { this.listeners = {}; this.status = 200; this.responseType = ''; this.responseText = '{"status":"ok","access_token":"PRIVATE_RESPONSE"}'; }
    open(...args) { this.openArgs = args; }
    setRequestHeader(...args) { (this.headers ||= []).push(args); }
    send(value) { this.sent = value; if (!delayedXHR) this.listeners.loadend?.(); return 'original-return'; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  const context = vm.createContext({ ThreadsRequestProbeCore: Core, fetch, XMLHttpRequest: XHR, URL, URLSearchParams, FormData, Headers, Request, location: { href: 'https://www.threads.com/@fixture' },
    setTimeout(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout(timer) { if (timer) timer.cleared = true; } });
  vm.runInContext(source, context);
  return { context, api: context.ThreadsRequestProbe, fetch, XHR, promise, response, calls, timers };
}
test('request descriptions omit credentials and arbitrary string content while preserving scope flags', () => {
  const result = Core.describeRequest({ url, method: 'POST', body: body() });
  const serialized = JSON.stringify(result);
  assert.equal(result.origin, 'https://www.threads.com'); assert.equal(result.path, '/api/graphql/');
  assert.equal(result.documentId, '123456'); assert.equal(result.action, 'block');
  assert.equal(serialized.includes('PRIVATE_'), false); assert.equal(serialized.includes('NEVER_EXPORT'), false);
  assert.ok(result.variables.some(row => row.numericId === '98765'));
  assert.ok(result.variables.some(row => row.path.at(-1) === 'block_on_instagram' && row.boolean === false));
  assert.ok(result.variables.some(row => row.enum === 'threads_only'));
});
test('unrelated requests are ignored and unblock is never presented as block', () => {
  for (const input of [{ url, method: 'GET', body: body() }, { url: 'https://evil.test/api/graphql', method: 'POST', body: body() }, { url, method: 'POST', body: 'fb_api_req_friendly_name=FeedQuery' }]) assert.equal(Core.describeRequest(input), null);
  assert.equal(Core.describeRequest({ url, method: 'POST', body: 'fb_api_req_friendly_name=FixtureUnblockMutation' }).action, 'unblock');
});
test('page-world reports are sanitized again and never mark requests or scope verified', () => {
  const report = Core.cleanReport({ directRequestVerified: true, scopeVerified: true, cookies: 'PRIVATE', records: [{ transport: 'fetch', request: { ...Core.describeRequest({ url, method: 'POST', body: body() }), authorization: 'PRIVATE' }, response: { status: 200, json: true, fields: [{ path: ['access_token'], type: 'string', enum: 'PRIVATE' }, { path: ['status'], type: 'string', enum: 'ok', value: 'PRIVATE' }] } }] });
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false); assert.equal(report.directRequestVerified, false); assert.equal(report.scopeVerified, false);
  assert.equal(report.records[0].response.fields.length, 1);
});
test('fetch observation preserves exact arguments, Promise and body, sends no extra request, and restores fetch', async () => {
  const f = fixture(), init = { method: 'POST', body: body(), headers: { Authorization: 'PRIVATE_AUTH' } };
  assert.equal(f.api.begin().active, true);
  assert.equal(f.context.fetch(url, init), f.promise);
  const response = await f.promise, report = await f.api.finish();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1], init); assert.equal(f.context.fetch, f.fetch);
  assert.equal(report.records.length, 1); assert.equal(report.records[0].response.status, 200);
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false); assert.equal((await response.json()).data.block.blocking, true);
});
test('a Request body is cloned for observation and its original is not consumed', async () => {
  const f = fixture(), request = new Request(url, { method: 'POST', body: body() }); f.api.begin();
  await f.context.fetch(request); const report = await f.api.finish();
  assert.equal(request.bodyUsed, false); assert.equal(report.records.length, 1); assert.equal(f.calls[0][0], request);
});
test('XHR observation preserves open/send/header behavior and restores all hooks', async () => {
  const f = fixture(), open = f.XHR.prototype.open, send = f.XHR.prototype.send, header = f.XHR.prototype.setRequestHeader; f.api.begin();
  const xhr = new f.XHR(); xhr.open('POST', url, true); xhr.setRequestHeader('Authorization', 'PRIVATE_AUTH'); xhr.setRequestHeader('x-fb-friendly-name', 'FixtureBlockMutation');
  const payload = new URLSearchParams({ variables: '{"target_user_id":"98765"}' });
  assert.equal(xhr.send(payload), 'original-return'); assert.equal(xhr.sent, payload);
  const report = await f.api.finish(); assert.equal(report.records.length, 1); assert.equal(report.records[0].transport, 'xhr');
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  assert.equal(f.XHR.prototype.open, open); assert.equal(f.XHR.prototype.send, send); assert.equal(f.XHR.prototype.setRequestHeader, header);
});
test('network errors remain errors and do not cause a replay', async () => {
  const f = fixture({ reject: true }); f.api.begin();
  await assert.rejects(f.context.fetch(url, { method: 'POST', body: body() }), /network failure/);
  const report = await f.api.finish(); assert.equal(f.calls.length, 1); assert.equal(report.records[0].response.status, null);
});
test('observation expires and cleans up without waiting for another user action', async () => {
  const f = fixture(); f.api.begin(); f.timers.find(timer => timer.ms === 90000).fn();
  assert.equal(f.context.fetch, f.fetch); const report = await f.api.finish(); assert.equal(report.expired, true);
});
test('candidate reports have bounded record and field counts', async () => {
  const f = fixture(); f.api.begin(); for (let i = 0; i < 12; i++) await f.context.fetch(url, { method: 'POST', body: body() });
  const report = await f.api.finish(); assert.equal(report.records.length, 8); assert.equal(f.calls.length, 12);
  assert.ok(Core.fields(Object.fromEntries(Array.from({ length: 300 }, (_, i) => ['field' + i, true]))).length <= 150);
});
test('a later website hook is not overwritten during probe cleanup', async () => {
  const f = fixture(); f.api.begin(); const later = () => Promise.resolve(); f.context.fetch = later;
  await f.api.finish(); assert.equal(f.context.fetch, later);
});

test('finish waits for an outstanding XHR response instead of losing it after optimistic UI success', async () => {
  const f = fixture({ delayedXHR: true }); f.api.begin(); const xhr = new f.XHR(); xhr.open('POST', url); xhr.send(body());
  let done = false; const finish = f.api.finish().then(r => { done = true; return r; });
  await Promise.resolve(); assert.equal(done, false); xhr.listeners.loadend();
  const report = await finish; assert.equal(report.records[0].response.status, 200); assert.equal(report.records[0].response.json, true);
});
test('server evidence is bound to the captured request and rejects swapped or ambiguous reports', () => {
  const request=Core.describeRequest({url:'https://www.threads.com/api/graphql',method:'POST',body:JSON.stringify({fb_api_req_friendly_name:'useTHUserBlockMutation',doc_id:'12345',variables:{user_id:'98765'}})});
  const capture={records:[{transport:'xhr',request,response:{status:null,json:false,fields:[]}}]};
  const good={records:[{transport:'fetch',request,response:{status:200,json:true,fields:Core.fields({data:{record:{user:{id:'98765',friendship_status:{blocking:true}}}}})}}]};
  assert.equal(Core.blockEvidence(good,capture).confirmed,true);
  for(const change of [r=>{r.records[0].request.documentId='54321';},r=>{r.records.push(r.records[0]);},r=>{r.records[0].response.fields.push({path:['data','record','user','id'],type:'string',numericId:'98765'});},r=>{r.records[0].request.variables[1].numericId='11111';}]) {
    const changed=structuredClone(good);change(changed);assert.equal(Core.blockEvidence(changed,capture).confirmed,false);
  }
});
