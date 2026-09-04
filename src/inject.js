/*
 * MAIN world hook.
 * 目的：
 *  1) 抓取 X 网页自身请求里用的 authorization / x-client-transaction-id 等头，避免硬编码 bearer 失效
 *  2) 从时间线的 GraphQL 响应里抽出 screen_name -> rest_id 映射，屏蔽时不必再多打一次 users/show
 * 只读不改：不修改任何请求/响应内容。
 */
(function () {
  'use strict';
  const TAG = '__xqb__';
  if (window[TAG]) return;
  window[TAG] = true;

  const buf = [];
  const post = (payload) => {
    try {
      buf.push(payload);
      if (buf.length > 400) buf.splice(0, buf.length - 400);
      window.postMessage(Object.assign({ __xqb: true }, payload), location.origin);
    } catch (e) {}
  };

  // 内容脚本在 document_idle 才注册监听，早期消息会丢；它就绪后会请求一次回放
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__xqbReq !== 'flush') return;
    for (const payload of buf.slice(-400)) {
      try { window.postMessage(Object.assign({ __xqb: true }, payload), location.origin); } catch (e) {}
    }
  });

  // 从请求 URL 里记下 operationName -> queryId（GraphQL 的 queryId 会随版本变，只能观察）
  const seenOps = new Set();
  function grabQueryId(url) {
    const m = /\/i\/api\/graphql\/([\w-]{6,})\/([A-Za-z0-9_]+)/.exec(String(url || ''));
    if (!m) return;
    const key = m[2] + ':' + m[1];
    if (seenOps.has(key)) return;
    seenOps.add(key);
    post({ type: 'gql', op: m[2], qid: m[1] });
  }

  let authSent = '';
  function grabHeaders(headers) {
    if (!headers) return;
    let auth = '', lang = '';
    try {
      if (typeof headers.get === 'function') {
        auth = headers.get('authorization') || '';
        lang = headers.get('x-twitter-client-language') || '';
      } else if (Array.isArray(headers)) {
        for (const [k, v] of headers) {
          if (String(k).toLowerCase() === 'authorization') auth = v;
          if (String(k).toLowerCase() === 'x-twitter-client-language') lang = v;
        }
      } else if (typeof headers === 'object') {
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === 'authorization') auth = headers[k];
          if (k.toLowerCase() === 'x-twitter-client-language') lang = headers[k];
        }
      }
    } catch (e) { return; }
    if (auth && /^Bearer /i.test(auth) && auth !== authSent) {
      authSent = auth;
      post({ type: 'auth', auth, lang });
    }
  }

  // 递归找 {rest_id, legacy:{screen_name}} / {rest_id, core:{screen_name}} 这类用户对象
  function harvestUsers(obj, out, depth) {
    if (!obj || depth > 12 || out.length > 400) return;
    if (Array.isArray(obj)) {
      for (const it of obj) harvestUsers(it, out, depth + 1);
      return;
    }
    if (typeof obj !== 'object') return;
    const id = obj.rest_id || obj.id_str;
    const sn = (obj.legacy && obj.legacy.screen_name) || (obj.core && obj.core.screen_name) || obj.screen_name;
    if (id && sn && typeof sn === 'string') {
      const name = (obj.legacy && obj.legacy.name) || (obj.core && obj.core.name) || obj.name || '';
      const desc = (obj.legacy && obj.legacy.description) || obj.description || '';
      out.push({ id: String(id), sn, name: String(name || ''), desc: String(desc || '') });
    }
    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === 'object') harvestUsers(v, out, depth + 1);
    }
  }

  function scanBody(text) {
    if (!text || text.length > 4_000_000) return;
    let json;
    try { json = JSON.parse(text); } catch (e) { return; }
    const out = [];
    harvestUsers(json, out, 0);
    if (out.length) post({ type: 'users', users: out });
  }

  const isApi = (url) => typeof url === 'string' &&
    (url.includes('/i/api/') || url.includes('api.x.com') || url.includes('api.twitter.com'));

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (init && init.headers) grabHeaders(init.headers);
      else if (input && input.headers) grabHeaders(input.headers);
    } catch (e) {}
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    grabQueryId(url);
    const p = origFetch.apply(this, arguments);
    if (isApi(url)) {
      p.then((res) => {
        try {
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('json')) res.clone().text().then(scanBody).catch(() => {});
        } catch (e) {}
      }).catch(() => {});
    }
    return p;
  };

  const XHR = window.XMLHttpRequest;
  const open = XHR.prototype.open;
  const setRH = XHR.prototype.setRequestHeader;
  const send = XHR.prototype.send;
  XHR.prototype.open = function (m, u) { this.__xqbUrl = u; grabQueryId(u); return open.apply(this, arguments); };
  XHR.prototype.setRequestHeader = function (k, v) {
    try {
      if (String(k).toLowerCase() === 'authorization' && /^Bearer /i.test(v) && v !== authSent) {
        authSent = v; post({ type: 'auth', auth: v, lang: '' });
      }
    } catch (e) {}
    return setRH.apply(this, arguments);
  };
  XHR.prototype.send = function () {
    try {
      if (isApi(this.__xqbUrl || '')) {
        this.addEventListener('load', () => {
          try { if (typeof this.responseText === 'string') scanBody(this.responseText); } catch (e) {}
        });
      }
    } catch (e) {}
    return send.apply(this, arguments);
  };
})();
