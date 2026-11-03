(function (root) {
  'use strict';
  const HOSTS = new Set(['www.threads.com', 'threads.com', 'www.threads.net', 'threads.net', 'www.instagram.com', 'i.instagram.com']);
  const SECRET = /token|csrf|cookie|authorization|password|secret|session|fb_dtsg|jazoest|^lsd$|^__user$/i;
  const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,79}$|^\d{1,5}$/;
  const isReportableKey = key => typeof key === 'string' && KEY.test(key) && !SECRET.test(key);
  const ENUMS = new Set(['ok', 'success', 'fail', 'error', 'blocked', 'unblocked', 'block', 'unblock', 'threads', 'instagram', 'both', 'all', 'none', 'threads_only', 'instagram_and_threads', 'text_app']);
  const TYPES = new Set(['object', 'array', 'string', 'number', 'boolean', 'null']);
  const idPath = path => path.slice(-2).some(key => /(?:^id$|_ids?$|^pk$)/i.test(key));
  const codeKey = key => /^(?:code|error_code|status_code|block_type|block_scope|blocking_type)$/.test(key);
  function parseJSON(value) {
    if (typeof value !== 'string' || value.length > 1048576) return null;
    try { return JSON.parse(value.replace(/^for\s*\(;;\);\s*/, '')); } catch { return null; }
  }
  function fields(value) {
    const output = [];
    function walk(node, path) {
      if (output.length >= 150 || path.length > 8) return;
      const type = node === null ? 'null' : Array.isArray(node) ? 'array' : typeof node;
      if (!TYPES.has(type)) return;
      const row = { path, type }, key = path.at(-1) || '';
      if (type === 'boolean') row.boolean = node;
      if (idPath(path) && /^(?:\d{1,30})$/.test(String(node))) row.numericId = String(node);
      if (codeKey(key) && Number.isSafeInteger(node)) row.code = node;
      if (type === 'string' && ENUMS.has(node.toLowerCase())) row.enum = node.toLowerCase();
      output.push(row);
      if (type === 'object' || type === 'array') for (const [name, child] of Object.entries(node).slice(0, 80)) {
        if (isReportableKey(name)) walk(child, [...path, name]);
      }
    }
    walk(value, []); return output;
  }
  function endpoint(raw, base) {
    try {
      const url = new URL(raw, base);
      if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.port) return null;
      // Only API paths. Never retain query parameters, fragments or profile URLs.
      if (!/^\/(?:api|graphql)(?:\/|$)/.test(url.pathname) || !/^\/[A-Za-z0-9_./-]{1,240}$/.test(url.pathname)) return null;
      return { origin: url.origin, path: url.pathname };
    } catch { return null; }
  }
  function operation(value) { return typeof value === 'string' && /^[A-Za-z0-9_]{1,150}$/.test(value) && /block/i.test(value) ? value : null; }
  function describeRequest({ url, base, method, body, operationHeader }) {
    const site = endpoint(url, base);
    if (!site || String(method).toUpperCase() !== 'POST') return null;
    if (typeof body === 'string' && body.length > 1048576) return null;
    let data = {};
    if (typeof body === 'string') data = parseJSON(body) || Object.fromEntries(new URLSearchParams(body));
    else if (body && typeof body === 'object') data = body;
    const name = operation(data.fb_api_req_friendly_name || data.operationName || operationHeader);
    if (!name && !/\/(?:block|unblock)\//i.test(site.path)) return null;
    const variables = typeof data.variables === 'string' ? parseJSON(data.variables) : data.variables;
    return {
      ...site, method: 'POST', operation: name, documentId: /^\d{1,30}$/.test(String(data.doc_id || '')) ? String(data.doc_id) : null,
      action: /unblock/i.test(name || site.path) ? 'unblock' : 'block',
      bodyKeys: Object.keys(data).filter(key => KEY.test(key) && !SECRET.test(key)).slice(0, 50),
      variables: fields(variables ?? data), credentialsOmitted: true
    };
  }
  function safeFields(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, 150).filter(row => row && Array.isArray(row.path) && row.path.length <= 8 && row.path.every(key => typeof key === 'string' && KEY.test(key) && !SECRET.test(key)) && TYPES.has(row.type)).map(row => {
      const clean = { path: row.path, type: row.type }, key = row.path.at(-1) || '';
      if (row.type === 'boolean' && typeof row.boolean === 'boolean') clean.boolean = row.boolean;
      if (idPath(row.path) && /^\d{1,30}$/.test(String(row.numericId || ''))) clean.numericId = String(row.numericId);
      if (codeKey(key) && Number.isSafeInteger(row.code)) clean.code = row.code;
      if (row.type === 'string' && ENUMS.has(row.enum)) clean.enum = row.enum;
      return clean;
    });
  }
  function cleanReport(report) {
    const records = [];
    for (const record of (Array.isArray(report?.records) ? report.records : []).slice(0, 8)) {
      const request = record?.request, site = request && endpoint(`${request.origin}${request.path}`);
      if (!site || !['fetch', 'xhr'].includes(record.transport) || !['block', 'unblock'].includes(request.action)) continue;
      records.push({
        transport: record.transport,
        request: { ...site, method: 'POST', operation: operation(request.operation), documentId: /^\d{1,30}$/.test(String(request.documentId || '')) ? String(request.documentId) : null, action: request.action,
          bodyKeys: (Array.isArray(request.bodyKeys) ? request.bodyKeys : []).filter(key => typeof key === 'string' && KEY.test(key) && !SECRET.test(key)).slice(0, 50), variables: safeFields(request.variables), credentialsOmitted: true },
        response: { status: Number.isInteger(record.response?.status) && record.response.status >= 0 && record.response.status <= 599 ? record.response.status : null,
          json: record.response?.json === true, fields: safeFields(record.response?.fields) }
      });
    }
    return { schemaVersion: 1, mode: 'observe-only', directRequestVerified: false, scopeVerified: false, credentialsOmitted: true,
      expired: report?.expired === true, records };
  }
  function blockEvidence(report, capture) {
    const sent = cleanReport(report).records, original = cleanReport(capture).records;
    const read = (rows, path, property) => {
      const matches = rows.filter(row => JSON.stringify(row.path) === JSON.stringify(path));
      return matches.length === 1 ? matches[0][property] : undefined;
    };
    const entry = sent.length === 1 ? sent[0] : null, prepared = original.length === 1 ? original[0] : null;
    const requestUserId = entry && read(entry.request.variables, ['user_id'], 'numericId');
    const responseUserId = entry && read(entry.response.fields, ['data','record','user','id'], 'numericId');
    const serverBlocking = entry && read(entry.response.fields, ['data','record','user','friendship_status','blocking'], 'boolean');
    const originalId = prepared && read(prepared.request.variables, ['user_id'], 'numericId');
    const hasErrors = entry?.response.fields.some(row => row.path[0] === 'errors' && (row.path.length > 1 || !['array','null'].includes(row.type)));
    const sameRequest = entry && prepared && ['origin','path','operation','documentId','action'].every(key => entry.request[key] === prepared.request[key]);
    const confirmed = !!(sameRequest && entry.request.origin === 'https://www.threads.com' && /^\/api\/graphql\/?$/.test(entry.request.path) &&
      entry.request.operation === 'useTHUserBlockMutation' && entry.request.action === 'block' && entry.request.documentId &&
      requestUserId && requestUserId === originalId && requestUserId === responseUserId && serverBlocking === true &&
      entry.response.status === 200 && entry.response.json && !hasErrors);
    return { confirmed, httpStatus: entry?.response.status ?? null, requestUserId: requestUserId || null, responseUserId: responseUserId || null, serverBlocking: serverBlocking === true };
  }
  const api = Object.freeze({ parseJSON, fields, describeRequest, cleanReport, isReportableKey, blockEvidence });
  root.ThreadsRequestProbeCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
