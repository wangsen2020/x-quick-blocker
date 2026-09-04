/* X Quick Blocker — content script (isolated world) */
(function () {
  'use strict';

  const FALLBACK_BEARER =
    'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const DEFAULTS = {
    enabled: true,
    showInlineButton: true,
    scanEnabled: false,          // 关键词扫描开关
    autoBlock: false,            // false = 半自动：命中先进候选列表，人工确认后执行
    keywords: [],                // 普通关键词（不区分大小写）
    regexes: [],                 // 正则，字符串形式
    whitelist: [],               // 永不屏蔽的 handle（不带 @）
    matchText: true,
    matchName: true,
    matchHandle: true,
    matchBio: true,              // 依赖 hook 抓到的资料，抓不到就跳过
    minDelayMs: 1500,            // 每次屏蔽之间的间隔
    jitterMs: 800,
    maxPerRun: 50,               // 单次批量上限
    logLimit: 500,
  };

  let cfg = Object.assign({}, DEFAULTS);
  let log = [];
  let idMap = new Map();          // screen_name(lower) -> user_id
  let bioMap = new Map();         // screen_name(lower) -> {name, desc}
  let qidMap = new Map();         // operationName -> queryId（从请求 URL 观察到的）
  let gqlFeatures = {};           // UserByScreenName 需要的 features 开关（按报错自动补全）
  let capturedAuth = '';
  let clientLang = 'zh-cn';
  let selfHandle = '';
  const candidates = new Map();   // handle(lower) -> candidate
  const blockedThisSession = new Set();
  let running = false;
  let stopFlag = false;

  /* ---------------- storage ---------------- */
  const store = chrome.storage.local;

  function loadAll() {
    return new Promise((res) => {
      store.get(['xqb_config', 'xqb_log', 'xqb_idmap', 'xqb_qid', 'xqb_feat'], (r) => {
        cfg = Object.assign({}, DEFAULTS, r.xqb_config || {});
        log = r.xqb_log || [];
        if (r.xqb_idmap) idMap = new Map(Object.entries(r.xqb_idmap));
        if (r.xqb_qid) qidMap = new Map(Object.entries(r.xqb_qid));
        if (r.xqb_feat) gqlFeatures = r.xqb_feat;
        res();
      });
    });
  }
  const saveCfg = () => store.set({ xqb_config: cfg });
  const saveQid = () => store.set({ xqb_qid: Object.fromEntries(qidMap) });
  const saveFeat = () => store.set({ xqb_feat: gqlFeatures });
  const saveLog = () => store.set({ xqb_log: log.slice(0, cfg.logLimit) });
  let idmapTimer = null;
  function saveIdMap() {
    clearTimeout(idmapTimer);
    idmapTimer = setTimeout(() => {
      const entries = Array.from(idMap.entries()).slice(-3000);
      store.set({ xqb_idmap: Object.fromEntries(entries) });
    }, 3000);
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.xqb_config) {
      cfg = Object.assign({}, DEFAULTS, ch.xqb_config.newValue || {});
      syncPanelFromCfg();
    }
  });

  /* ---------------- page hook messages ---------------- */
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__xqb !== true) return;
    const d = ev.data;
    if (d.type === 'auth' && d.auth) {
      capturedAuth = d.auth;
      if (d.lang) clientLang = d.lang;
    } else if (d.type === 'gql' && d.op && d.qid) {
      if (qidMap.get(d.op) !== d.qid) { qidMap.set(d.op, d.qid); saveQid(); }
    } else if (d.type === 'users' && Array.isArray(d.users)) {
      for (const u of d.users) {
        const k = u.sn.toLowerCase();
        if (!idMap.has(k)) idMap.set(k, u.id);
        if (u.name || u.desc) bioMap.set(k, { name: u.name, desc: u.desc });
      }
      saveIdMap();
    }
  });

  /* ---------------- api ---------------- */
  function cookie(name) {
    const m = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[2]) : '';
  }

  function apiHeaders() {
    return {
      authorization: capturedAuth || FALLBACK_BEARER,
      'x-csrf-token': cookie('ct0'),
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': clientLang || 'zh-cn',
      'content-type': 'application/x-www-form-urlencoded',
    };
  }

  const apiBase = () => (location.hostname.includes('twitter.com') ? 'https://twitter.com' : 'https://x.com');

  class RateLimited extends Error {}

  // GraphQL UserByScreenName：queryId 由 hook 从请求 URL 观察得到；
  // features 参数缺哪个 X 会在报错里列出来，据此自动补全并重试。
  async function gqlUserId(handle) {
    const qid = qidMap.get('UserByScreenName');
    if (!qid) throw new Error('尚未观察到 UserByScreenName 的 queryId');
    const variables = { screen_name: handle, withSafetyModeUserFields: true };
    for (let attempt = 0; attempt < 4; attempt++) {
      const u = `${apiBase()}/i/api/graphql/${qid}/UserByScreenName` +
        `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
        `&features=${encodeURIComponent(JSON.stringify(gqlFeatures))}`;
      const res = await fetch(u, { headers: apiHeaders(), credentials: 'include' });
      if (res.status === 429) throw new RateLimited('UserByScreenName 触发限流');
      const txt = await res.text();
      let j = null;
      try { j = JSON.parse(txt); } catch (e) {}
      const missing = [];
      for (const err of (j && j.errors) || []) {
        const m = /features cannot be null:\s*([^\n."]+)/i.exec(err.message || '');
        if (m) m[1].split(/[,\s]+/).filter(Boolean).forEach((f) => missing.push(f));
      }
      if (missing.length) {
        let added = false;
        for (const f of missing) if (!(f in gqlFeatures)) { gqlFeatures[f] = true; added = true; }
        if (added) { saveFeat(); continue; }
      }
      const u1 = j && j.data && j.data.user;
      const id = u1 && ((u1.result && u1.result.rest_id) || u1.rest_id);
      if (id) return String(id);
      const emsg = (j && j.errors && j.errors[0] && j.errors[0].message) || `HTTP ${res.status}`;
      throw new Error(`UserByScreenName 失败：${emsg}`);
    }
    throw new Error('UserByScreenName features 协商失败');
  }

  async function resolveUserId(handle) {
    const k = handle.toLowerCase();
    if (idMap.has(k)) return idMap.get(k);

    const tried = [];
    // 1) GraphQL（当前唯一稳定可用的查询路径）
    try {
      const id = await gqlUserId(handle);
      idMap.set(k, id); saveIdMap();
      return id;
    } catch (e) {
      if (e instanceof RateLimited) throw e;
      tried.push(`GraphQL: ${e.message}`);
    }
    // 2) 老的 1.1 接口（多数账号上已 404，留作兜底）
    try {
      const url = `${apiBase()}/i/api/1.1/users/show.json?screen_name=${encodeURIComponent(handle)}`;
      const res = await fetch(url, { headers: apiHeaders(), credentials: 'include' });
      if (res.status === 429) throw new RateLimited('users/show 触发限流');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!j || !j.id_str) throw new Error('响应无 id_str');
      idMap.set(k, j.id_str); saveIdMap();
      return j.id_str;
    } catch (e) {
      if (e instanceof RateLimited) throw e;
      tried.push(`users/show: ${e.message}`);
    }
    const err = new Error(`拿不到 user_id（${tried.join(' / ')}）`);
    err.noUserId = true;
    throw err;
  }

  async function callBlock(path, handle) {
    if (!cookie('ct0')) throw new Error('未登录或找不到 ct0 cookie');
    let body;
    try {
      body = `user_id=${encodeURIComponent(await resolveUserId(handle))}`;
    } catch (e) {
      if (e instanceof RateLimited) throw e;
      if (!e.noUserId) throw e;
      // 最后兜底：v1.1 的 blocks 接口也接受 screen_name
      body = `screen_name=${encodeURIComponent(handle)}`;
    }
    const res = await fetch(`${apiBase()}/i/api/1.1/${path}`, {
      method: 'POST',
      headers: apiHeaders(),
      credentials: 'include',
      body,
    });
    if (res.status === 429) throw new RateLimited('触发接口限流（429）');
    const txt = await res.text();
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        const j = JSON.parse(txt);
        if (j.errors && j.errors[0]) msg = `${j.errors[0].code || res.status}: ${j.errors[0].message}`;
      } catch (e) {}
      throw new Error(msg);
    }
    return true;
  }

  const blockUser = (h) => callBlock('blocks/create.json', h);
  const unblockUser = (h) => callBlock('blocks/destroy.json', h);

  function friendly(err) {
    const m = String((err && err.message) || err);
    if (/user_id|UserByScreenName|queryId|404/.test(m)) {
      return m + '｜先随便点开一个用户主页一次，插件就能学到查询参数（只需一次，之后会记住）';
    }
    return m;
  }

  function pushLog(entry) {
    log.unshift(Object.assign({ t: Date.now() }, entry));
    log = log.slice(0, cfg.logLimit);
    saveLog();
    renderLog();
  }

  /* ---------------- tweet parsing ---------------- */
  function detectSelf() {
    if (selfHandle) return selfHandle;
    const el = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    const m = el && el.innerText && el.innerText.match(/@([A-Za-z0-9_]{1,20})/);
    if (m) selfHandle = m[1].toLowerCase();
    return selfHandle;
  }

  function tweetInfo(article) {
    const nameBlock = article.querySelector('[data-testid="User-Name"]');
    let handle = '';
    let name = '';
    if (nameBlock) {
      const a = Array.from(nameBlock.querySelectorAll('a[href]')).find((x) =>
        /^\/[A-Za-z0-9_]{1,20}$/.test(new URL(x.href, location.origin).pathname)
      );
      if (a) handle = new URL(a.href, location.origin).pathname.slice(1);
      const spans = nameBlock.querySelectorAll('span');
      if (spans.length) name = (spans[0].textContent || '').trim();
    }
    if (!handle) {
      const m = (article.innerText || '').match(/@([A-Za-z0-9_]{1,20})/);
      if (m) handle = m[1];
    }
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const text = textEl ? textEl.innerText : '';
    const linkEl = article.querySelector('a[href*="/status/"]');
    const url = linkEl ? new URL(linkEl.href, location.origin).href : '';
    return { handle, name, text, url };
  }

  /* ---------------- matching ---------------- */
  function compiledRegexes() {
    const out = [];
    for (const r of cfg.regexes || []) {
      try { out.push(new RegExp(r, 'i')); } catch (e) {}
    }
    return out;
  }

  function matchTweet(info) {
    if (!info.handle) return null;
    const h = info.handle.toLowerCase();
    if (h === detectSelf()) return null;
    if ((cfg.whitelist || []).some((w) => w.replace(/^@/, '').toLowerCase() === h)) return null;

    const parts = [];
    if (cfg.matchText && info.text) parts.push(info.text);
    if (cfg.matchName && info.name) parts.push(info.name);
    if (cfg.matchHandle) parts.push(info.handle);
    if (cfg.matchBio && bioMap.has(h)) parts.push(bioMap.get(h).desc || '');
    const hay = parts.join('\n');
    const low = hay.toLowerCase();

    for (const kw of cfg.keywords || []) {
      const k = String(kw).trim();
      if (!k) continue;
      if (low.includes(k.toLowerCase())) return { kind: 'kw', hit: k };
    }
    for (const re of compiledRegexes()) {
      const m = hay.match(re);
      if (m) return { kind: 're', hit: `/${re.source}/ → ${m[0].slice(0, 30)}` };
    }
    return null;
  }

  /* ---------------- inline block button ---------------- */
  function makeBtn(info) {
    const b = document.createElement('button');
    b.className = 'xqb-btn';
    b.type = 'button';
    b.title = `屏蔽 @${info.handle}`;
    b.textContent = '屏蔽';
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (b.dataset.busy) return;
      b.dataset.busy = '1';
      b.textContent = '···';
      try {
        await blockUser(info.handle);
        b.textContent = '已屏蔽';
        b.classList.add('xqb-done');
        blockedThisSession.add(info.handle.toLowerCase());
        pushLog({ handle: info.handle, name: info.name, reason: '手动', ok: true, url: info.url });
        toast(`已屏蔽 @${info.handle}`);
      } catch (err) {
        b.textContent = '失败';
        b.classList.add('xqb-fail');
        pushLog({ handle: info.handle, name: info.name, reason: '手动', ok: false, err: friendly(err) });
        toast(`屏蔽 @${info.handle} 失败：${friendly(err)}`, true);
      } finally {
        delete b.dataset.busy;
      }
    });
    return b;
  }

  function decorate(article) {
    if (article.dataset.xqb === '1') return;
    const info = tweetInfo(article);
    if (!info.handle) return;
    article.dataset.xqb = '1';
    article.dataset.xqbHandle = info.handle;

    if (cfg.enabled && cfg.showInlineButton && info.handle.toLowerCase() !== detectSelf()) {
      const group = article.querySelector('div[role="group"]');
      if (group && !group.querySelector('.xqb-btn')) {
        const wrap = document.createElement('div');
        wrap.className = 'xqb-btn-wrap';
        wrap.appendChild(makeBtn(info));
        group.appendChild(wrap);
      }
    }

    if (cfg.enabled && cfg.scanEnabled) {
      const hit = matchTweet(info);
      if (hit) {
        article.classList.add('xqb-hit');
        const key = info.handle.toLowerCase();
        if (!candidates.has(key) && !blockedThisSession.has(key)) {
          candidates.set(key, {
            handle: info.handle, name: info.name, url: info.url,
            snippet: (info.text || '').slice(0, 120), hit: hit.hit, checked: true,
          });
          renderCandidates();
          updateBadge();
          if (cfg.autoBlock) queueAuto();
        }
      }
    }
  }

  function scanAll() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach(decorate);
  }

  const mo = new MutationObserver(() => {
    clearTimeout(mo._t);
    mo._t = setTimeout(scanAll, 250);
  });

  /* ---------------- batch executor ---------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runBatch(list) {
    if (running) return;
    running = true;
    stopFlag = false;
    let backoff = 0;
    let done = 0, fail = 0;
    setRunUI(true);
    for (const c of list) {
      if (stopFlag) break;
      if (done + fail >= cfg.maxPerRun) { toast(`已达单次上限 ${cfg.maxPerRun}，停止`); break; }
      try {
        await blockUser(c.handle);
        done++;
        blockedThisSession.add(c.handle.toLowerCase());
        candidates.delete(c.handle.toLowerCase());
        pushLog({ handle: c.handle, name: c.name, reason: c.hit ? `命中「${c.hit}」` : '批量', ok: true, url: c.url });
        backoff = 0;
      } catch (err) {
        if (err instanceof RateLimited) {
          backoff = backoff ? Math.min(backoff * 2, 15 * 60_000) : 60_000;
          toast(`触发限流，暂停 ${Math.round(backoff / 1000)}s 后继续`, true);
          setStatus(`限流退避中… ${Math.round(backoff / 1000)}s`);
          await sleep(backoff);
          if (stopFlag) break;
          continue;
        }
        fail++;
        pushLog({ handle: c.handle, name: c.name, reason: '批量', ok: false, err: friendly(err) });
      }
      renderCandidates();
      updateBadge();
      setStatus(`进行中：成功 ${done} / 失败 ${fail} / 剩 ${Math.max(0, list.length - done - fail)}`);
      await sleep(cfg.minDelayMs + Math.random() * cfg.jitterMs);
    }
    running = false;
    setRunUI(false);
    setStatus(`完成：成功 ${done}，失败 ${fail}`);
    toast(`批量结束：成功 ${done}，失败 ${fail}`);
  }

  let autoTimer = null;
  function queueAuto() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      if (!cfg.autoBlock || running) return;
      runBatch(Array.from(candidates.values()));
    }, 1200);
  }

  /* ---------------- UI ---------------- */
  let panel, elCand, elLog, elStatus, elBadge, elRunBtn, elStopBtn;

  function toast(msg, bad) {
    const t = document.createElement('div');
    t.className = 'xqb-toast' + (bad ? ' xqb-toast-bad' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('xqb-show'), 10);
    setTimeout(() => { t.classList.remove('xqb-show'); setTimeout(() => t.remove(), 300); }, 3200);
  }

  const setStatus = (s) => { if (elStatus) elStatus.textContent = s; };
  function setRunUI(on) {
    if (elRunBtn) elRunBtn.disabled = on;
    if (elStopBtn) elStopBtn.style.display = on ? '' : 'none';
  }
  function updateBadge() {
    if (elBadge) {
      const n = candidates.size;
      elBadge.textContent = n ? String(n) : '';
      elBadge.style.display = n ? '' : 'none';
    }
  }

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'class') e.className = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'html') e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  }

  function renderCandidates() {
    if (!elCand) return;
    elCand.textContent = '';
    if (!candidates.size) {
      elCand.append(h('div', { class: 'xqb-empty' }, cfg.scanEnabled ? '暂无命中，继续往下刷即可' : '扫描未开启（设置里打开）'));
      return;
    }
    for (const c of candidates.values()) {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = c.checked !== false;
      cb.addEventListener('change', () => { c.checked = cb.checked; });
      elCand.append(
        h('div', { class: 'xqb-row' },
          cb,
          h('div', { class: 'xqb-row-main' },
            h('div', { class: 'xqb-row-top' },
              h('a', { class: 'xqb-handle', href: `/${c.handle}`, target: '_blank' }, `@${c.handle}`),
              h('span', { class: 'xqb-hit-tag' }, c.hit || '')
            ),
            h('div', { class: 'xqb-snippet' }, c.snippet || '')
          ),
          h('button', { class: 'xqb-mini', onclick: () => { candidates.delete(c.handle.toLowerCase()); renderCandidates(); updateBadge(); } }, '忽略')
        )
      );
    }
  }

  function renderLog() {
    if (!elLog) return;
    elLog.textContent = '';
    if (!log.length) { elLog.append(h('div', { class: 'xqb-empty' }, '暂无记录')); return; }
    for (const l of log.slice(0, 100)) {
      elLog.append(
        h('div', { class: 'xqb-row' },
          h('div', { class: 'xqb-row-main' },
            h('div', { class: 'xqb-row-top' },
              h('span', { class: l.ok ? 'xqb-ok' : 'xqb-bad' }, l.ok ? '✓' : '✗'),
              h('a', { class: 'xqb-handle', href: `/${l.handle}`, target: '_blank' }, `@${l.handle}`),
              h('span', { class: 'xqb-hit-tag' }, l.reason || '')
            ),
            h('div', { class: 'xqb-snippet' }, (l.err || '') + '  ' + new Date(l.t).toLocaleString())
          ),
          l.ok ? h('button', {
            class: 'xqb-mini',
            onclick: async (e) => {
              e.target.textContent = '···';
              try { await unblockUser(l.handle); e.target.textContent = '已解除'; }
              catch (err) { e.target.textContent = '失败'; toast(String(err.message || err), true); }
            },
          }, '解除') : null
        )
      );
    }
  }

  function listInput(labelText, key, placeholder) {
    const ta = h('textarea', { class: 'xqb-ta', placeholder, rows: '4' });
    ta.value = (cfg[key] || []).join('\n');
    ta.addEventListener('change', () => {
      cfg[key] = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
      saveCfg();
      toast(`${labelText} 已保存（${cfg[key].length} 条）`);
      document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => { a.dataset.xqb = ''; a.classList.remove('xqb-hit'); });
      scanAll();
    });
    ta.dataset.key = key;
    return h('div', { class: 'xqb-field' }, h('label', {}, labelText), ta);
  }

  function toggle(labelText, key, onChange) {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !!cfg[key];
    cb.dataset.key = key;
    cb.addEventListener('change', () => { cfg[key] = cb.checked; saveCfg(); if (onChange) onChange(); });
    return h('label', { class: 'xqb-toggle' }, cb, labelText);
  }

  function numField(labelText, key, min, max) {
    const i = h('input', { type: 'number', class: 'xqb-num', min: String(min), max: String(max) });
    i.value = cfg[key];
    i.dataset.key = key;
    i.addEventListener('change', () => {
      const v = Math.max(min, Math.min(max, Number(i.value) || min));
      cfg[key] = v; i.value = v; saveCfg();
    });
    return h('label', { class: 'xqb-toggle' }, labelText, i);
  }

  function syncPanelFromCfg() {
    if (!panel) return;
    panel.querySelectorAll('[data-key]').forEach((el) => {
      const k = el.dataset.key;
      if (el.type === 'checkbox') el.checked = !!cfg[k];
      else if (el.tagName === 'TEXTAREA') el.value = (cfg[k] || []).join('\n');
      else el.value = cfg[k];
    });
  }

  function buildPanel() {
    elBadge = h('span', { class: 'xqb-badge' });
    const fab = h('div', { class: 'xqb-fab', title: 'X Quick Blocker' }, '🛡', elBadge);

    elCand = h('div', { class: 'xqb-list' });
    elLog = h('div', { class: 'xqb-list' });
    elStatus = h('div', { class: 'xqb-status' }, '就绪');

    elRunBtn = h('button', {
      class: 'xqb-primary',
      onclick: () => {
        const list = Array.from(candidates.values()).filter((c) => c.checked !== false);
        if (!list.length) return toast('没有勾选的候选');
        if (!confirm(`将屏蔽 ${list.length} 个账号，每个间隔约 ${(cfg.minDelayMs / 1000).toFixed(1)}s。确认？`)) return;
        runBatch(list);
      },
    }, '屏蔽已勾选');
    elStopBtn = h('button', { class: 'xqb-ghost', onclick: () => { stopFlag = true; toast('已请求停止'); } }, '停止');
    elStopBtn.style.display = 'none';

    const tabs = {};
    const bodies = {};
    const tabBar = h('div', { class: 'xqb-tabs' });
    function addTab(id, label, body) {
      const b = h('button', { class: 'xqb-tab', onclick: () => selectTab(id) }, label);
      tabs[id] = b; bodies[id] = body; tabBar.append(b);
    }
    function selectTab(id) {
      for (const k in tabs) {
        tabs[k].classList.toggle('xqb-tab-on', k === id);
        bodies[k].style.display = k === id ? '' : 'none';
      }
    }

    const candBody = h('div', { class: 'xqb-body' },
      h('div', { class: 'xqb-actions' },
        h('button', { class: 'xqb-ghost', onclick: () => { candidates.forEach((c) => (c.checked = true)); renderCandidates(); } }, '全选'),
        h('button', { class: 'xqb-ghost', onclick: () => { candidates.clear(); renderCandidates(); updateBadge(); } }, '清空'),
        elRunBtn, elStopBtn
      ),
      elCand
    );

    const kwBody = h('div', { class: 'xqb-body' },
      listInput('关键词（一行一个，不区分大小写）', 'keywords', 'crypto airdrop\n代开\n加V'),
      listInput('正则（一行一个，JS 语法，不含斜杠）', 'regexes', '^(?=.*空投)(?=.*私信).*$'),
      listInput('白名单 handle（一行一个，不带 @）', 'whitelist', 'yourfriend')
    );

    const setBody = h('div', { class: 'xqb-body' },
      toggle('启用插件', 'enabled', () => scanAll()),
      toggle('推文旁显示「屏蔽」按钮', 'showInlineButton', () => location.reload()),
      toggle('开启关键词扫描', 'scanEnabled', () => { candidates.clear(); renderCandidates(); scanAll(); }),
      toggle('全自动（命中即屏蔽，不弹确认）⚠️', 'autoBlock'),
      h('div', { class: 'xqb-sub' }, '匹配范围：'),
      toggle('正文', 'matchText'), toggle('昵称', 'matchName'),
      toggle('用户名', 'matchHandle'), toggle('简介（能抓到时）', 'matchBio'),
      h('div', { class: 'xqb-sub' }, '节流：'),
      numField('间隔 ms', 'minDelayMs', 300, 60000),
      numField('抖动 ms', 'jitterMs', 0, 10000),
      numField('单次上限', 'maxPerRun', 1, 500),
      h('div', { class: 'xqb-note' }, '批量操作过快可能触发 X 的限流甚至风控，建议间隔 ≥1.5s、单次 ≤50。')
    );

    const logBody = h('div', { class: 'xqb-body' }, elLog);

    addTab('cand', '候选', candBody);
    addTab('kw', '词库', kwBody);
    addTab('log', '日志', logBody);
    addTab('set', '设置', setBody);

    panel = h('div', { class: 'xqb-panel' },
      h('div', { class: 'xqb-head' },
        h('span', {}, 'X Quick Blocker'),
        h('button', { class: 'xqb-x', onclick: () => panel.classList.remove('xqb-open') }, '×')
      ),
      tabBar, candBody, kwBody, logBody, setBody, elStatus
    );
    selectTab('cand');

    fab.addEventListener('click', () => panel.classList.toggle('xqb-open'));
    document.body.append(fab, panel);
    renderCandidates();
    renderLog();
    updateBadge();
  }

  /* ---------------- boot ---------------- */
  loadAll().then(() => {
    // 回放 document_idle 之前 hook 已经抓到的映射
    try { window.postMessage({ __xqbReq: 'flush' }, location.origin); } catch (e) {}
    setTimeout(() => { try { window.postMessage({ __xqbReq: 'flush' }, location.origin); } catch (e) {} }, 2500);
    buildPanel();
    detectSelf();
    scanAll();
    mo.observe(document.body, { childList: true, subtree: true });
    setInterval(scanAll, 2000);
  });
})();
