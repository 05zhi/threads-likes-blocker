/* Observe one explicitly selected UI block. Never constructs or replays a request. */
(function (root) {
  'use strict';
  if (root.ThreadsRequestProbe?.version === 1) return;
  const Core = root.ThreadsRequestProbeCore;
  let session = null;
  function begin() {
    if (session && !session.closed) throw new Error('A request probe is already active');
    const state = { records: [], pending: new Set(), closed: false, expired: false };
    const originalFetch = root.fetch, proto = root.XMLHttpRequest?.prototype;
    const originalOpen = proto?.open, originalSend = proto?.send, originalHeader = proto?.setRequestHeader, xhrDetails = new WeakMap();
    function track(promise) {
      state.pending.add(promise);
      promise.finally(() => state.pending.delete(promise)).catch(() => {});
    }
    function record(request, transport) {
      if (!request || state.closed || state.records.length >= 8) return null;
      const item = { transport, request, response: { status: null, json: false, fields: [] } };
      state.records.push(item); return item;
    }
    function response(item, status, body) {
      if (!item || state.closed) return;
      const json = typeof body === 'string' ? Core.parseJSON(body) : body;
      item.response = { status, json: json !== null && typeof json === 'object', fields: json !== null && typeof json === 'object' ? Core.fields(json) : [] };
    }
    async function observeFetch(input, init, promise) {
      try {
        const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
        const method = init?.method || input?.method || 'GET';
        if (String(method).toUpperCase() !== 'POST') return;
        let body = init?.body;
        if (body === undefined && input?.text) body = await input.text();
        if (root.URLSearchParams && body instanceof root.URLSearchParams) body = body.toString();
        if (root.FormData && body instanceof root.FormData) body = Object.fromEntries([...body.entries()].filter(([, value]) => typeof value === 'string'));
        const operationHeader = new root.Headers(init?.headers || input?.headers).get('x-fb-friendly-name');
        const item = record(Core.describeRequest({ url, base: root.location.href, method, body, operationHeader }), 'fetch');
        if (!item) return;
        const result = await promise;
        if (state.closed) return;
        const length = Number(result.headers.get('content-length'));
        if (length > 1048576) { response(item, result.status, null); return; }
        response(item, result.status, await result.clone().text());
      } catch { /* Observation never changes the website request or its result. */ }
    }
    function wrappedFetch(...args) {
      // Clone a Request before the website consumes its body; only this clone is inspected.
      let observedInput = args[0];
      try { if (observedInput?.clone) observedInput = observedInput.clone(); } catch { observedInput = null; }
      const promise = originalFetch.apply(this, args);
      track(observeFetch(observedInput, args[1], promise));
      return promise;
    }
    function wrappedOpen(method, url, ...rest) {
      xhrDetails.set(this, { method, url });
      return originalOpen.call(this, method, url, ...rest);
    }
    function wrappedSend(body) {
      try {
        const metadata = xhrDetails.get(this);
        let observedBody = body instanceof root.URLSearchParams ? body.toString() : body;
        if (root.FormData && body instanceof root.FormData) observedBody = Object.fromEntries([...body.entries()].filter(([, value]) => typeof value === 'string'));
        const item = metadata && record(Core.describeRequest({ ...metadata, base: root.location.href, body: observedBody }), 'xhr');
        if (item) track(new Promise(resolve => this.addEventListener('loadend', () => {
          try { response(item, this.status, this.responseType === 'json' ? this.response : !this.responseType || this.responseType === 'text' ? this.responseText : null); } catch {}
          finally { resolve(); }
        }, { once: true })));
      } catch {}
      return originalSend.call(this, body);
    }
    function wrappedHeader(name, value) {
      const metadata = xhrDetails.get(this);
      if (metadata && String(name).toLowerCase() === 'x-fb-friendly-name') metadata.operationHeader = String(value);
      return originalHeader.call(this, name, value);
    }
    function restore() {
      if (root.fetch === wrappedFetch) root.fetch = originalFetch;
      if (proto?.open === wrappedOpen) proto.open = originalOpen;
      if (proto?.send === wrappedSend) proto.send = originalSend;
      if (proto?.setRequestHeader === wrappedHeader) proto.setRequestHeader = originalHeader;
    }
    state.restore = restore;
    try {
      if (typeof originalFetch === 'function') root.fetch = wrappedFetch;
      if (proto) { proto.open = wrappedOpen; proto.send = wrappedSend; if (originalHeader) proto.setRequestHeader = wrappedHeader; }
    } catch (error) { restore(); throw error; }
    state.timer = root.setTimeout(() => { state.expired = true; state.closed = true; restore(); }, 90000);
    session = state; return { active: true, mode: 'observe-only' };
  }
  async function finish() {
    if (!session) return Core.cleanReport(null);
    const state = session;
    state.restore(); root.clearTimeout(state.timer);
    let timer;
    try { await Promise.race([Promise.allSettled([...state.pending]), new Promise(resolve => { timer = root.setTimeout(resolve, 12000); })]); }
    finally { root.clearTimeout(timer); state.closed = true; }
    const report = Core.cleanReport(state); state.records = [];
    return report;
  }
  root.ThreadsRequestProbe = Object.freeze({ version: 1, begin, finish });
})(globalThis);
