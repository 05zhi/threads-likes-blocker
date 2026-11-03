/* Single-account feasibility test. Hold one website-generated mutation, then
 * submit that exact request once after a separate background authorization.
 * Raw request material lives only in this closure and is never returned. */
(function (root) {
  'use strict';
  if (root.ThreadsDirectRequest?.version === 3) return;
  let state = null;
  const Core = root.ThreadsRequestProbeCore;
  function arm({ username }) {
    if (state && !state.closed) throw new Error('Direct verification already active');
    const page = new URL(root.location.href);
    if (page.origin !== 'https://www.threads.com' || page.pathname.toLowerCase() !== '/@' + String(username).toLowerCase() || !/^[A-Za-z0-9._]{1,30}$/.test(username)) throw new Error('Profile binding mismatch');
    const originalFetch = root.fetch, proto = root.XMLHttpRequest.prototype;
    const open = proto.open, send = proto.send, setHeader = proto.setRequestHeader;
    const metadata = new WeakMap();
    const s = state = { href: page.href, closed: false, attempted: false, candidate: null, count: 0, refused: false, held: [], records: [], checks: {}, bodyFormat: 'unknown', candidates: [] };
    const bound = () => root.location.href === s.href && root.document.visibilityState === 'visible';
    function capture(url, method, body, headers, transport) {
      let format = 'unsupported', data = null, snapshot = body, validBody = false;
      if (typeof body === 'string' && body.length <= 1048576) { format = 'urlencoded'; data = new root.URLSearchParams(body); validBody = true; }
      else if (body instanceof root.URLSearchParams) { format = 'urlsearchparams'; data = new root.URLSearchParams(body); snapshot = new root.URLSearchParams(body); validBody = true; }
      else if (root.FormData && body instanceof root.FormData) {
        format = 'formdata'; data = new root.URLSearchParams(); snapshot = new root.FormData(); validBody = true; let size = 0;
        for (const [key, value] of body.entries()) {
          if (typeof value !== 'string') { validBody = false; continue; }
          size += key.length + value.length; if (size > 1048576) { validBody = false; break; }
          data.append(key, value); snapshot.append(key, value);
        }
      }
      const description = Core.describeRequest({ url, base: s.href, method, body: data ? Object.fromEntries(data) : body, operationHeader: headers.get('x-fb-friendly-name') });
      if (description?.action !== 'block') return false;
      s.count++;
      s.bodyFormat = format;
      if (s.candidates.length < 8) s.candidates.push({ transport, request: description, response: { status: null, json: false, fields: [] } });
      const variables = data && Core.parseJSON(data.get('variables'));
      const actualURL = new URL(url, s.href);
      const keys = ['user_id', 'container_module', 'media_id', 'barcelona_source_quote_post_id', 'barcelona_source_reply_id', 'is_messaging_nua', 'consistent_thread_fbid'];
      const variableKeys = variables && typeof variables === 'object' && !Array.isArray(variables) ? Object.keys(variables) : [];
      const extraKeys = variableKeys.filter(key => !keys.includes(key));
      s.variableFieldCount = variableKeys.length;
      s.additionalVariableFieldCount = extraKeys.length;
      // The diagnostic export deliberately omits sensitive/long field names.
      // Preserve those website-generated fields verbatim in the held payload;
      // never equate a seven-field sanitized view with a seven-field wire body.
      // A new visible operation/scope field still needs separate examination.
      s.checks = { active: !s.closed, profileBinding: bound(), singleCandidate: s.count === 1,
        operation: description.operation === 'useTHUserBlockMutation', documentId: !!description.documentId,
        endpoint: actualURL.origin === page.origin && /^\/api\/graphql\/?$/.test(actualURL.pathname) && !actualURL.hash,
        bodyEncoding: validBody, uniqueBodyKeys: !!data && new Set(data.keys()).size === [...data.keys()].length,
        variableSchema: !!variables && !Array.isArray(variables) && keys.every(key => Object.hasOwn(variables, key)),
        additionalFields: extraKeys.every(key => !Core.isReportableKey(key)),
        targetId: !!variables && /^\d{1,30}$/.test(variables.user_id),
        container: !!variables && typeof variables.container_module === 'string' && variables.container_module.length <= 120,
        optionalContext: !!variables && keys.slice(2).every(key => variables[key] === null) };
      const eligible = Object.values(s.checks).every(value => value === true);
      if (!eligible) { s.refused = true; s.candidate = null; }
      else s.candidate = { url: actualURL.href, body: snapshot, headers: new root.Headers(headers), description };
      // Suppress even a malformed/duplicate block candidate; never pass through
      // and then replay an operation that may already have reached the server.
      return true;
    }
    function wrappedOpen(method, url, ...rest) { metadata.set(this, { method, url, headers: new root.Headers() }); return open.call(this, method, url, ...rest); }
    function wrappedHeader(name, value) { metadata.get(this)?.headers.append(name, value); return setHeader.call(this, name, value); }
    function wrappedSend(body) {
      const m = metadata.get(this);
      if (m && capture(m.url, m.method, body, m.headers, 'xhr')) return undefined;
      return send.call(this, body);
    }
    function wrappedFetch(input, init) {
      // The observed live transport is XHR. Never claim capture of an unread
      // Request stream; an unsupported transport yields no direct submission.
      const method = init?.method || input?.method || 'GET';
      const body = init?.body;
      const headers = new root.Headers(init?.headers || input?.headers);
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
      if (capture(url, method, body, headers, 'fetch')) {
        const promise = new Promise((resolve, reject) => s.held.push({ resolve, reject }));
        promise.catch(() => {}); return promise;
      }
      return originalFetch.apply(this, arguments);
    }
    s.restore = () => {
      if (root.fetch === wrappedFetch) root.fetch = originalFetch;
      if (proto.open === wrappedOpen) proto.open = open;
      if (proto.send === wrappedSend) proto.send = send;
      if (proto.setRequestHeader === wrappedHeader) proto.setRequestHeader = setHeader;
    };
    s.bound = bound; s.fetch = originalFetch;
    try { root.fetch = wrappedFetch; proto.open = wrappedOpen; proto.send = wrappedSend; proto.setRequestHeader = wrappedHeader; }
    catch (error) { dispose(); throw error; }
    s.timer = root.setTimeout(dispose, 90000);
    return { active: true };
  }
  function status() { return { captured: !!state?.candidate && !state.closed && !state.refused, refused: state?.refused === true, attempted: state?.attempted === true,
    diagnostics: { bodyFormat: state?.bodyFormat || 'unknown', candidateCount: state?.count || 0, variableFieldCount: state?.variableFieldCount || 0,
      additionalVariableFieldCount: state?.additionalVariableFieldCount || 0, checks: state?.checks || {}, report: Core.cleanReport({ records: state?.candidates || [] }) } }; }
  async function submit() {
    const s = state;
    if (!s || s.closed || s.attempted || s.refused || !s.candidate || !s.bound()) return { attempted: false, report: Core.cleanReport(null) };
    s.attempted = true;
    const candidate = s.candidate; s.candidate = null;
    const controller = new root.AbortController();
    const timer = root.setTimeout(() => controller.abort(), 20000);
    const record = { transport: 'fetch', request: candidate.description, response: { status: null, json: false, fields: [] } };
    s.records.push(record);
    let accepted = false;
    try {
      const response = await s.fetch.call(root, candidate.url, { method: 'POST', body: candidate.body, headers: candidate.headers, credentials: 'same-origin', redirect: 'error', signal: controller.signal });
      const json = Core.parseJSON(await response.clone().text());
      record.response = { status: response.status, json: !!json, fields: json ? Core.fields(json) : [] };
      accepted = response.status === 200 && !!json?.data && !json.errors;
      for (const pending of s.held.splice(0)) pending.resolve(response.clone());
    } catch { for (const pending of s.held.splice(0)) pending.reject(new Error('Direct request outcome unknown')); }
    finally { root.clearTimeout(timer); candidate.body = null; candidate.headers = null; }
    return { attempted: true, accepted, report: Core.cleanReport(s) };
  }
  function dispose() {
    if (!state) return;
    const previous = state; state = null;
    previous.closed = true; previous.candidate = null; previous.restore?.(); root.clearTimeout(previous.timer);
    for (const pending of previous.held.splice(0)) pending.reject(new Error('Direct request test ended'));
  }
  root.ThreadsDirectRequest = Object.freeze({ version: 3, arm, status, submit, dispose });
})(globalThis);
