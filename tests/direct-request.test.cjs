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
  const fetch = async (...args) => { calls.push(args); if (options.reject) throw new Error('offline'); return new Response(JSON.stringify(options.response || { data: { record: { user: { id:'123456',friendship_status:{blocking:true} } } } }), { status: options.status || 200 }); };
  class XHR { open(...args) { this.openArgs = args; } setRequestHeader(...args) { (this.headers ||= []).push(args); } send(value) { this.sent = value; return 'original'; } }
  const context = vm.createContext({ ThreadsRequestProbeCore: Core, URL, URLSearchParams, FormData, Headers, AbortController, fetch, XMLHttpRequest: XHR,
    location: { href: 'https://www.threads.com/@victim' }, document: { visibilityState: 'visible' },
    setTimeout(fn, ms) { const t = { fn, ms }; timers.push(t); return t; }, clearTimeout(t) { if (t) t.cleared = true; } });
  vm.runInContext(code, context);
  const api = context.ThreadsDirectRequest;
  function request(payload = body(), endpoint = url) { const xhr = new XHR(); xhr.open('POST', endpoint, true); if (!(payload instanceof FormData)) xhr.setRequestHeader('content-type', 'application/x-www-form-urlencoded'); xhr.setRequestHeader('x-fb-lsd', 'PRIVATE_HEADER'); xhr.send(payload); return xhr; }
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
  for (const [payload, endpoint] of [[body({ variables: JSON.stringify({ ...variables, block_on_instagram: true }) }), url], [body({ fb_api_req_friendly_name: 'OtherBlockMutation' }), url], [body(), 'https://i.instagram.com/api/graphql']]) {
    const f = fixture(); f.api.arm({ username: 'victim' }); const xhr = f.request(payload, endpoint);
    assert.equal(xhr.sent, undefined); assert.equal(f.api.status().refused, true); assert.equal((await f.api.submit()).attempted, false); assert.equal(f.calls.length, 0); f.api.dispose();
  }
});

test('FormData is captured and snapshotted without converting its transport or exporting credentials', async () => {
  const f = fixture(), form = new FormData(); for (const [key,value] of new URLSearchParams(body())) form.append(key,value);
  f.api.arm({username:'victim'}); const xhr=f.request(form);
  assert.equal(xhr.sent,undefined); const status=f.api.status(); assert.equal(status.captured,true); assert.equal(status.diagnostics.bodyFormat,'formdata');
  assert.equal(Object.values(status.diagnostics.checks).every(Boolean),true); assert.equal(JSON.stringify(status).includes('PRIVATE'),false);
  form.set('variables','CHANGED_AFTER_CAPTURE'); const result=await f.api.submit(); assert.equal(result.accepted,true);
  const sent=f.calls[0][1]; assert.ok(sent.body instanceof FormData); assert.equal(sent.body.get('variables'),JSON.stringify(variables)); assert.equal(sent.headers.has('content-type'),false);
  f.api.dispose();
});
test('URLSearchParams stays snapshotted and same-endpoint query parameters are preserved only in the request', async () => {
  const f=fixture(), payload=new URLSearchParams(body()), endpoint=url+'?route=PRIVATE_QUERY'; f.api.arm({username:'victim'}); f.request(payload,endpoint);
  payload.set('variables','CHANGED_AFTER_CAPTURE'); assert.equal(f.api.status().captured,true);
  assert.equal(JSON.stringify(f.api.status()).includes('PRIVATE'),false);
  await f.api.submit(); assert.equal(f.calls[0][0],endpoint); assert.ok(f.calls[0][1].body instanceof URLSearchParams);
  assert.equal(f.calls[0][1].body.get('variables'),JSON.stringify(variables)); f.api.dispose();
});
test('binary form fields and duplicate body keys are refused with precise non-secret diagnostics', async () => {
  for(const binary of [true,false]) {
    const f=fixture(), form=new FormData(); for(const [key,value] of new URLSearchParams(body())) form.append(key,value);
    if(binary)form.append('attachment',new Blob(['PRIVATE_FILE']),'PRIVATE_NAME');else form.append('doc_id','98765');
    f.api.arm({username:'victim'}); f.request(form); const status=f.api.status(); assert.equal(status.refused,true);
    assert.equal(status.diagnostics.checks[binary?'bodyEncoding':'uniqueBodyKeys'],false); assert.equal(JSON.stringify(status).includes('PRIVATE'),false);
    assert.equal((await f.api.submit()).attempted,false); assert.equal(f.calls.length,0); f.api.dispose();
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

test('extra fields omitted by diagnostic sanitization remain intact in the submitted request', async () => {
  for (const key of ['session_id', 'relay_provider_'+'x'.repeat(90)]) {
    const f=fixture(), value={...variables,[key]:'PRIVATE_OPAQUE_VALUE'}, payload=body({variables:JSON.stringify(value)});
    f.api.arm({username:'victim'}); f.request(payload);
    const status=f.api.status(); assert.equal(status.captured,true); assert.equal(status.diagnostics.variableFieldCount,8); assert.equal(status.diagnostics.additionalVariableFieldCount,1);
    assert.equal(status.diagnostics.checks.variableSchema,true); assert.equal(status.diagnostics.checks.additionalFields,true);
    assert.equal(status.diagnostics.report.records[0].request.variables.length,8); // root plus seven visible fields
    assert.equal(JSON.stringify(status).includes('PRIVATE_OPAQUE_VALUE'),false);
    assert.equal((await f.api.submit()).accepted,true); assert.equal(f.calls[0][1].body,payload); assert.equal(f.calls.length,1); f.api.dispose();
  }
});
test('missing required fields and new visible scope fields still refuse submission', async () => {
  const missing={...variables};delete missing.media_id;
  for(const value of [missing,{...variables,block_on_instagram:true}]) {
    const f=fixture();f.api.arm({username:'victim'});f.request(body({variables:JSON.stringify(value)}));
    assert.equal(f.api.status().refused,true);assert.equal((await f.api.submit()).attempted,false);assert.equal(f.calls.length,0);f.api.dispose();
  }
});
test('HTTP 200 requires the captured user ID and explicit blocking true, without GraphQL errors', async () => {
  for(const response of [
    {data:{record:{user:{id:'999999',friendship_status:{blocking:true}}}}},
    {data:{record:{user:{id:'123456',friendship_status:{blocking:false}}}}},
    {data:{record:{user:{id:'123456',friendship_status:{blocking:true}}}},errors:[{message:'PRIVATE_ERROR'}]},
    {data:{status:'ok'}}
  ]) {
    const f=fixture({response});f.api.arm({username:'victim'});f.request();assert.equal((await f.api.submit()).accepted,false);assert.equal(f.calls.length,1);f.api.dispose();
  }
});
