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
    removeBlockedDom: true,      // 屏蔽成功后把该作者的推文/评论从当前页面移除
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
  let scanTimer = null;
  let fabPos = null;             // 悬浮球位置 {left, top}（px）；null = 用 CSS 默认角落

  /* ---------------- storage ---------------- */
  const store = chrome.storage.local;

  // 在 chrome://extensions 里重新加载/更新扩展后，旧页面里残留的内容脚本
  // 会失去扩展上下文，之后任何 chrome.* 调用都会抛 "Extension context invalidated"
  // （MV3 下表现为指向 store.set 那一行的未捕获 Promise rejection）。
  // 统一从这里进出：上下文没了就安静收摊，不再往控制台丢错。
  let ctxDead = false;
  function extAlive() {
    if (ctxDead) return false;
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }
  function teardown() {
    if (ctxDead) return;
    ctxDead = true;
    try { mo.disconnect(); } catch (e) {}
    try { clearTimeout(mo._t); } catch (e) {}
    try { clearInterval(scanTimer); } catch (e) {}
    try { clearTimeout(idmapTimer); } catch (e) {}
  }
  function storeSet(obj) {
    if (!extAlive()) return;
    try {
      store.set(obj, () => { if (chrome.runtime && chrome.runtime.lastError) teardown(); });
    } catch (e) { teardown(); }
  }
  function storeGet(keys, cb) {
    if (!extAlive()) { cb({}); return; }
    try {
      store.get(keys, (r) => {
        if (chrome.runtime && chrome.runtime.lastError) { teardown(); cb({}); return; }
        cb(r || {});
      });
    } catch (e) { teardown(); cb({}); }
  }

  // 页面本身（x.com）的 localStorage 镜像。chrome.storage.local 在「移除并重新
  // 添加扩展」时会被清空，词库/设置随之丢失；写一份到 x.com 的 localStorage 里，
  // 重装扩展也不受影响（内容脚本虽在隔离世界，localStorage 仍是页面同源那一份）。
  // 主存仍是 chrome.storage，localStorage 只作镜像与冷启动回填。
  const LS_PREFIX = 'xqb:';
  function lsGet(key) {
    try {
      const v = window.localStorage.getItem(LS_PREFIX + key);
      return v == null ? undefined : JSON.parse(v);
    } catch (e) { return undefined; }
  }
  function lsSet(key, val) {
    try { window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(val)); } catch (e) {}
  }

  function loadAll() {
    return new Promise((res) => {
      storeGet(['xqb_config', 'xqb_log', 'xqb_idmap', 'xqb_qid', 'xqb_feat', 'xqb_fab_pos'], (r) => {
        // 配置：chrome.storage 没有就回填 localStorage 里的镜像，并写回主存
        let savedCfg = r.xqb_config;
        if (!savedCfg) {
          const mirror = lsGet('xqb_config');
          if (mirror && typeof mirror === 'object') { savedCfg = mirror; storeSet({ xqb_config: mirror }); }
        }
        cfg = Object.assign({}, DEFAULTS, savedCfg || {});
        lsSet('xqb_config', cfg);   // 每次启动刷新镜像

        log = r.xqb_log || [];
        if (r.xqb_idmap) idMap = new Map(Object.entries(r.xqb_idmap));
        if (r.xqb_qid) qidMap = new Map(Object.entries(r.xqb_qid));
        if (r.xqb_feat) gqlFeatures = r.xqb_feat;

        let savedPos = r.xqb_fab_pos || lsGet('xqb_fab_pos');
        if (savedPos && typeof savedPos.left === 'number') {
          fabPos = savedPos;
          storeSet({ xqb_fab_pos: savedPos });
          lsSet('xqb_fab_pos', savedPos);
        }
        res();
      });
    });
  }
  const saveCfg = () => { storeSet({ xqb_config: cfg }); lsSet('xqb_config', cfg); };
  const saveQid = () => storeSet({ xqb_qid: Object.fromEntries(qidMap) });
  const saveFeat = () => storeSet({ xqb_feat: gqlFeatures });
  const saveLog = () => storeSet({ xqb_log: log.slice(0, cfg.logLimit) });
  let idmapTimer = null;
  function saveIdMap() {
    clearTimeout(idmapTimer);
    idmapTimer = setTimeout(() => {
      const entries = Array.from(idMap.entries()).slice(-3000);
      storeSet({ xqb_idmap: Object.fromEntries(entries) });
    }, 3000);
  }

  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (!extAlive()) return;
      if (area === 'local' && ch.xqb_config) {
        cfg = Object.assign({}, DEFAULTS, ch.xqb_config.newValue || {});
        lsSet('xqb_config', cfg);   // popup 改的也镜像一份
        syncPanelFromCfg();
      }
    });
  } catch (e) {}

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
    if (!qid) throw new Error(t('errNoQueryId', null, `Have not observed the UserByScreenName queryId yet`));
    const variables = { screen_name: handle, withSafetyModeUserFields: true };
    for (let attempt = 0; attempt < 4; attempt++) {
      const u = `${apiBase()}/i/api/graphql/${qid}/UserByScreenName` +
        `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
        `&features=${encodeURIComponent(JSON.stringify(gqlFeatures))}`;
      const res = await fetch(u, { headers: apiHeaders(), credentials: 'include' });
      if (res.status === 429) throw new RateLimited('UserByScreenName rate limited');
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
      throw new Error(t('errUbsnFailed', [emsg], `UserByScreenName failed: ${emsg}`));
    }
    throw new Error(t('errUbsnFeatures', null, `UserByScreenName feature negotiation failed`));
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
      if (res.status === 429) throw new RateLimited('users/show rate limited');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!j || !j.id_str) throw new Error(t('errNoIdStr', null, `Response had no id_str`));
      idMap.set(k, j.id_str); saveIdMap();
      return j.id_str;
    } catch (e) {
      if (e instanceof RateLimited) throw e;
      tried.push(`users/show: ${e.message}`);
    }
    const err = new Error(t('errNoUserId', [tried.join(' / ')], `Could not resolve user_id (${tried.join(' / ')})`));
    err.noUserId = true;
    throw err;
  }

  async function callBlock(path, handle) {
    if (!cookie('ct0')) throw new Error(t('errNoCt0', null, `Not signed in, or the ct0 cookie is missing`));
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
    if (res.status === 429) throw new RateLimited(t('errRateLimited', null, `Rate limited by the API (429)`));
    const txt = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(txt);
        if (j.errors && j.errors[0]) msg = `${j.errors[0].code || res.status}: ${j.errors[0].message}`;
      } catch (e) {
        // 不是 JSON（可能是 HTML 错误页）：带上片段，否则只剩状态码没法排查
        const snip = String(txt || '').replace(/\s+/g, ' ').slice(0, 120);
        if (snip) msg += ` — ${snip}`;
      }
      console.warn('[xqb] blocks endpoint failed', res.status, body, String(txt || '').slice(0, 300));
      throw new Error(msg);
    }
    return true;
  }

  const blockUser = (h) => callBlock('blocks/create.json', h);
  const unblockUser = (h) => callBlock('blocks/destroy.json', h);

  function friendly(err) {
    const m = String((err && err.message) || err);
    if (/user_id|UserByScreenName|queryId|404/.test(m)) {
      return m + t('hintVisitProfile', null, ` | Open any user profile once — the extension learns X's query parameters from that visit (once only, then it remembers)`);
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

  /* ---------------- i18n ---------------- */
  // chrome.i18n 按浏览器语言自动选 _locales 下的文案；取不到时回落到英文，
  // 保证在没有 i18n 环境（比如直接注入测试）时也不会显示空字符串。
  function t(key, subs, fallback) {
    try {
      const m = chrome.i18n && chrome.i18n.getMessage(key, subs);
      if (m) return m;
    } catch (e) {}
    return fallback;
  }

  /* ---------------- tooltip ---------------- */
  // 挂在 body 上用 fixed 定位，而不是按钮的伪元素：
  // X 的操作栏祖先有 overflow:hidden，伪元素 tooltip 会被裁掉。
  let tipEl = null;
  function hideTip() {
    if (tipEl) { tipEl.remove(); tipEl = null; }
  }
  function showTip(anchorEl, text) {
    hideTip();
    if (!text) return;
    tipEl = document.createElement('div');
    tipEl.className = 'xqb-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.textContent = text;
    document.body.appendChild(tipEl);
    const r = anchorEl.getBoundingClientRect();
    const b = tipEl.getBoundingClientRect();
    let left = r.left + r.width / 2 - b.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - b.width - 6));
    let top = r.top - b.height - 8;
    let below = false;
    if (top < 6) { top = r.bottom + 8; below = true; }   // 上方放不下就翻到下方
    tipEl.style.left = `${Math.round(left)}px`;
    tipEl.style.top = `${Math.round(top)}px`;
    tipEl.classList.toggle('xqb-tip-below', below);
    requestAnimationFrame(() => tipEl && tipEl.classList.add('xqb-tip-in'));
  }
  window.addEventListener('scroll', hideTip, true);

  // 斜杠人形：斜杠用 mask 在人形上切出缺口，而不是直接盖上去（直接盖会糊成一团）。
  // mask 定义只注入一次，所有按钮共用同一个 id——每个按钮各自定义会产生重复 id。
  const MASK_ID = 'xqb-slash-mask';
  function ensureDefs() {
    if (document.getElementById(MASK_ID)) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'xqb-defs');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML =
      `<defs><mask id="${MASK_ID}" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">` +
      '<rect x="0" y="0" width="24" height="24" fill="#fff"/>' +
      '<path d="M3.4 20.6 20.6 3.4" stroke="#000" stroke-width="3.2" stroke-linecap="round"/>' +
      '</mask></defs>';
    (document.body || document.documentElement).appendChild(svg);
  }

  const SVG = (inner) =>
    `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">${inner}</svg>`;

  const ICONS = {
    // 屏蔽：人形 + 斜杠，不含外圈圆
    block: SVG(
      `<g fill="currentColor" mask="url(#${MASK_ID})">` +
      '<circle cx="12" cy="7" r="4.3"/>' +
      '<path d="M12 12.6c-4.8 0-8.6 2.5-8.6 5.5V21h17.2v-2.9c0-3-3.8-5.5-8.6-5.5z"/>' +
      '</g>' +
      '<path d="M3.4 20.6 20.6 3.4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>'
    ),
    done: SVG('<path fill="currentColor" d="M9.55 17.6 4.4 12.45l1.414-1.414L9.55 14.77l8.636-8.636L19.6 7.55z"/>'),
    fail: SVG('<path fill="currentColor" d="M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-7h-2v5h2V9z"/>'),
    busy: SVG('<path fill="currentColor" class="xqb-spin" d="M12 2a10 10 0 1 0 10 10h-2.5A7.5 7.5 0 1 1 12 4.5V2z"/>'),
  };

  /* ---------------- inline block button ---------------- */
  function makeBtn(info) {
    ensureDefs();
    const b = document.createElement('button');
    b.className = 'xqb-btn';
    b.type = 'button';

    const tipBlock = t('btnBlockTip', [info.handle], `Block @${info.handle}`);
    // 只用自定义 tooltip，不设 title —— 两者都在会弹两层提示
    b.setAttribute('aria-label', tipBlock);
    b.dataset.tip = tipBlock;
    b.innerHTML = ICONS.block;

    const setState = (state, tip) => {
      b.classList.remove('xqb-done', 'xqb-fail', 'xqb-busy');
      if (state) b.classList.add(`xqb-${state}`);
      b.innerHTML = ICONS[state === 'done' ? 'done' : state === 'fail' ? 'fail' : state === 'busy' ? 'busy' : 'block'];
      b.dataset.tip = tip;
      b.setAttribute('aria-label', tip);
      if (tipEl) showTip(b, tip);   // 悬停中改状态时同步刷新
    };

    b.addEventListener('mouseenter', () => showTip(b, b.dataset.tip));
    b.addEventListener('mouseleave', hideTip);
    b.addEventListener('focus', () => showTip(b, b.dataset.tip));
    b.addEventListener('blur', hideTip);

    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (b.dataset.busy) return;
      b.dataset.busy = '1';
      setState('busy', t('btnWorking', null, 'Blocking…'));
      try {
        await blockUser(info.handle);
        setState('done', t('btnBlocked', null, 'Blocked'));
        hideTip();
        blockedThisSession.add(info.handle.toLowerCase());
        pushLog({ handle: info.handle, name: info.name, reason: 'manual', ok: true, url: info.url });
        candidates.delete(info.handle.toLowerCase());
        renderCandidates();
        updateBadge();
        if (cfg.removeBlockedDom) {
          const n = removeByHandle(info.handle);
          toast(n > 1 ? t('toastBlockedRemoved', [info.handle, n], `Blocked @${info.handle} — removed ${n} posts`) : t('toastBlocked', [info.handle], `Blocked @${info.handle}`));
        } else {
          toast(t('toastBlocked', [info.handle], `Blocked @${info.handle}`));
        }
      } catch (err) {
        setState('fail', `${t('btnFailed', null, 'Failed — click to retry')}：${friendly(err)}`);
        pushLog({ handle: info.handle, name: info.name, reason: 'manual', ok: false, err: friendly(err) });
        toast(t('toastBlockFailed', [info.handle, friendly(err)], `Failed to block @${info.handle}: ${friendly(err)}`), true);
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

  // 屏蔽成功后把该作者在当前页面上的所有推文/评论移除。
  // X 不会自己刷新已渲染的节点，评论区尤其明显——留在那里没法判断到底成没成。
  // 优先移除外层的 cellInnerDiv，否则会留下一个空壳占位。
  function removeByHandle(handle) {
    const key = String(handle || '').toLowerCase();
    if (!key) return 0;
    let n = 0;
    document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => {
      let hk = (a.dataset.xqbHandle || '').toLowerCase();
      if (!hk) {
        try { hk = (tweetInfo(a).handle || '').toLowerCase(); } catch (e) {}
      }
      if (hk !== key) return;
      const node = a.closest('[data-testid="cellInnerDiv"]') || a;
      node.remove();
      n++;
    });
    return n;
  }

  function scanAll() {
    // 已屏蔽的账号如果被 X 重新渲染回来（切 Tab、虚拟列表回收复用），再清一次
    if (cfg.removeBlockedDom && blockedThisSession.size) {
      for (const hk of blockedThisSession) removeByHandle(hk);
    }
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
    let done = 0, fail = 0, lastErr = '';
    setRunUI(true);
    // 整个循环包在 try/finally 里。原来没有 finally：循环体里任何一处抛错
    // （包括面板刷新）都会让 running 永久停在 true，之后再点按钮直接 return，
    // 表现就是「只成功一个，然后再也点不动」。
    try {
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (stopFlag) break;
        if (done + fail >= cfg.maxPerRun) { toast(t('toastMaxPerRun', [cfg.maxPerRun], `Reached the per-run cap of ${cfg.maxPerRun} — stopping`)); break; }

        let rlRetry = 0;
        for (;;) {
          if (stopFlag) break;
          try {
            await blockUser(c.handle);
            done++;
            backoff = 0;
            blockedThisSession.add(c.handle.toLowerCase());
            candidates.delete(c.handle.toLowerCase());
            if (cfg.removeBlockedDom) removeByHandle(c.handle);
            pushLog({ handle: c.handle, name: c.name, reason: c.hit ? { k: 'hit', v: c.hit } : 'batch', ok: true, url: c.url });
            break;
          } catch (err) {
            // 限流：重试「当前这个」，最多 3 次。原实现是 continue 到下一个，
            // 被限流的账号既没屏蔽也没计入失败，静默丢失。
            if (err instanceof RateLimited && rlRetry < 3) {
              rlRetry++;
              backoff = backoff ? Math.min(backoff * 2, 15 * 60_000) : 60_000;
              toast(t('toastRateLimited', [Math.round(backoff / 1000), c.handle], `Rate limited — retrying @${c.handle} in ${Math.round(backoff / 1000)}s`), true);
              setStatus(t('statusBackoff', [Math.round(backoff / 1000), rlRetry, c.handle], `Rate limited — waiting ${Math.round(backoff / 1000)}s (retry ${rlRetry} for @${c.handle})`));
              await sleep(backoff);
              continue;
            }
            fail++;
            lastErr = friendly(err);
            console.warn('[xqb] block failed', c.handle, err);
            pushLog({ handle: c.handle, name: c.name, reason: 'batch', ok: false, err: lastErr });
            break;
          }
        }

        // 面板刷新失败不能中断批量
        try {
          renderCandidates();
          updateBadge();
          setStatus(t('statusRunning', [done, fail, Math.max(0, list.length - done - fail)], `Running: ${done} done / ${fail} failed / ${Math.max(0, list.length - done - fail)} left`) +
            (lastErr ? t('statusLastFail', [lastErr], ` | last error: ${lastErr}`) : ''));
        } catch (e) {
          console.warn('[xqb] panel refresh error (batch continues)', e);
        }

        if (i < list.length - 1 && !stopFlag) {
          await sleep(cfg.minDelayMs + Math.random() * cfg.jitterMs);
        }
      }
    } finally {
      running = false;
      setRunUI(false);
      const tail = fail && lastErr ? t('statusLastFail', [lastErr], ` | last error: ${lastErr}`) : '';
      setStatus(t('statusDone', [done, fail], `Done: ${done} blocked, ${fail} failed`) + tail);
      toast(t('toastBatchEnd', [done, fail], `Batch finished: ${done} blocked, ${fail} failed`));
    }
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
  let panel, elCand, elLog, elStatus, elBadge, elRunBtn, elStopBtn, fabEl;

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
      elCand.append(h('div', { class: 'xqb-empty' }, cfg.scanEnabled ? t('emptyScanOn', null, `No matches yet — keep scrolling`) : t('emptyScanOff', null, `Scanning is off (turn it on in Settings)`)));
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
          h('button', { class: 'xqb-mini', onclick: () => { candidates.delete(c.handle.toLowerCase()); renderCandidates(); updateBadge(); } }, t('btnIgnore', null, `Ignore`))
        )
      );
    }
  }

  // 日志里的 reason 存的是稳定标识（'manual' / 'batch' / {k:'hit',v:词}），
  // 渲染时才本地化。历史日志里存的是中文字符串，原样显示，不做迁移。
  function reasonText(r) {
    if (!r) return '';
    if (typeof r === 'object' && r.k === 'hit') return t('reasonHit', [r.v], `Matched “${r.v}”`);
    if (r === 'manual') return t('reasonManual', null, `Manual`);
    if (r === 'batch') return t('reasonBatch', null, `Batch`);
    return String(r);
  }

  function renderLog() {
    if (!elLog) return;
    elLog.textContent = '';
    if (!log.length) { elLog.append(h('div', { class: 'xqb-empty' }, t('emptyLog', null, `No entries`))); return; }
    for (const l of log.slice(0, 100)) {
      elLog.append(
        h('div', { class: 'xqb-row' },
          h('div', { class: 'xqb-row-main' },
            h('div', { class: 'xqb-row-top' },
              h('span', { class: l.ok ? 'xqb-ok' : 'xqb-bad' }, l.ok ? '✓' : '✗'),
              h('a', { class: 'xqb-handle', href: `/${l.handle}`, target: '_blank' }, `@${l.handle}`),
              h('span', { class: 'xqb-hit-tag' }, reasonText(l.reason))
            ),
            h('div', { class: 'xqb-snippet' }, (l.err || '') + '  ' + new Date(l.t).toLocaleString())
          ),
          l.ok ? h('button', {
            class: 'xqb-mini',
            onclick: async (e) => {
              e.target.textContent = '···';
              try { await unblockUser(l.handle); e.target.textContent = t('btnUnblocked', null, `Unblocked`); }
              catch (err) { e.target.textContent = t('btnFailedShort', null, `Failed`); toast(String(err.message || err), true); }
            },
          }, t('btnUnblock', null, `Unblock`)) : null
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
      toast(t('toastListSaved', [labelText, cfg[key].length], `${labelText} saved (${cfg[key].length} entries)`));
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

  /* ---------------- 悬浮球：拖拽 + 位置持久化 ---------------- */
  function applyFabPos(el, pos) {
    el.style.left = `${Math.round(pos.left)}px`;
    el.style.top = `${Math.round(pos.top)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
  // 把当前位置夹回可视区内（窗口缩放、分辨率变化后不至于飞出屏幕）
  function clampFabPos(el) {
    const r = el.getBoundingClientRect();
    const maxX = Math.max(4, window.innerWidth - r.width - 4);
    const maxY = Math.max(4, window.innerHeight - r.height - 4);
    return {
      left: Math.min(Math.max(4, r.left), maxX),
      top: Math.min(Math.max(4, r.top), maxY),
    };
  }
  // 面板尺寸与 panel.css 里的 .xqb-panel 保持一致（固定宽高）
  const PANEL_W = 380;
  const PANEL_H = 560;
  function panelSize() {
    return { w: PANEL_W, h: Math.min(PANEL_H, window.innerHeight - 24) };
  }
  // 把面板夹进视窗内（整块可见，不会被顶出去）
  function clampPanelXY(left, top) {
    const { w, h } = panelSize();
    return {
      left: Math.max(8, Math.min(left, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - h - 8)),
    };
  }
  function setPanelXY(left, top) {
    const p = clampPanelXY(left, top);
    panel.style.left = `${Math.round(p.left)}px`;
    panel.style.top = `${Math.round(p.top)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }
  // 面板跟随悬浮球：优先开在球的上方、右缘对齐；上方放不下就翻到下方
  function positionPanel() {
    if (!panel || !fabEl) return;
    const r = fabEl.getBoundingClientRect();
    const { w, h } = panelSize();
    let top = r.top - h - 10;
    if (top < 8) top = r.bottom + 10;
    setPanelXY(r.right - w, top);
  }
  // 面板可用标题栏拖动（万一位置不理想能拽回来）
  function makePanelDraggable(handle) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target && e.target.closest && e.target.closest('.xqb-x'))) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      setPanelXY(ox + (e.clientX - sx), oy + (e.clientY - sy));
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
  // 拖动位移超过阈值算「拖拽」，否则算「点击」（切换面板）
  function makeFabDraggable(el, onClick) {
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      el.style.transition = 'none';
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) > 4) moved = true;
      if (moved) applyFabPos(el, { left: ox + dx, top: oy + dy });
    });
    const end = (e, allowClick) => {
      if (!dragging) return;
      dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch (_) {}
      el.style.transition = '';
      if (moved) {
        fabPos = clampFabPos(el);
        applyFabPos(el, fabPos);
        storeSet({ xqb_fab_pos: fabPos });
        lsSet('xqb_fab_pos', fabPos);
        if (panel && panel.classList.contains('xqb-open')) positionPanel();
      } else if (allowClick) {
        onClick();
      }
    };
    el.addEventListener('pointerup', (e) => end(e, true));
    el.addEventListener('pointercancel', (e) => end(e, false));
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
  }

  function buildPanel() {
    elBadge = h('span', { class: 'xqb-badge' });
    const fab = h('div', { class: 'xqb-fab', title: 'X Quick Blocker（拖动可移动位置）' }, '🛡', elBadge);
    fabEl = fab;

    elCand = h('div', { class: 'xqb-list' });
    elLog = h('div', { class: 'xqb-list' });
    elStatus = h('div', { class: 'xqb-status' }, t('statusReady', null, `Ready`));

    elRunBtn = h('button', {
      class: 'xqb-primary',
      onclick: () => {
        const list = Array.from(candidates.values()).filter((c) => c.checked !== false);
        if (!list.length) return toast(t('toastNoChecked', null, `Nothing selected`));
        if (!confirm(t('confirmBatch', [list.length, (cfg.minDelayMs / 1000).toFixed(1)], `Block ${list.length} accounts, about ${(cfg.minDelayMs / 1000).toFixed(1)}s apart. Continue?`))) return;
        runBatch(list);
      },
    }, t('btnBlockChecked', null, `Block selected`));
    elStopBtn = h('button', { class: 'xqb-ghost', onclick: () => { stopFlag = true; toast(t('toastStopRequested', null, `Stop requested`)); } }, t('btnStop', null, `Stop`));
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
      elCand,
      // 操作行固定在面板底部，不随列表滚动
      h('div', { class: 'xqb-actions' },
        h('button', { class: 'xqb-ghost', onclick: () => { candidates.forEach((c) => (c.checked = true)); renderCandidates(); } }, t('btnSelectAll', null, `Select all`)),
        h('button', { class: 'xqb-ghost', onclick: () => { candidates.clear(); renderCandidates(); updateBadge(); } }, t('btnClearList', null, `Clear`)),
        elRunBtn, elStopBtn
      )
    );

    const kwBody = h('div', { class: 'xqb-body' },
      listInput(t('labelKeywords', null, `Keywords (one per line, case-insensitive)`), 'keywords', t('phKeywords', null, `crypto airdrop
giveaway
DM me`)),
      listInput(t('labelRegexes', null, `Regex (one per line, JS syntax, no slashes)`), 'regexes', t('phRegexes', null, `^(?=.*airdrop)(?=.*DM).*$`)),
      listInput(t('labelWhitelist', null, `Allowlist handles (one per line, no @)`), 'whitelist', t('phWhitelist', null, `yourfriend`))
    );

    const setBody = h('div', { class: 'xqb-body' },
      toggle(t('optEnabled', null, `Enable extension`), 'enabled', () => scanAll()),
      toggle(t('optInlineButton', null, `Show block icon on posts`), 'showInlineButton', () => location.reload()),
      toggle(t('optScan', null, `Enable keyword scanning`), 'scanEnabled', () => { candidates.clear(); renderCandidates(); scanAll(); }),
      toggle(t('optAuto', null, `Fully automatic (block on match, no confirmation) ⚠️`), 'autoBlock'),
      toggle(t('optRemoveDom', null, `Remove their posts from the page after blocking`), 'removeBlockedDom'),
      h('div', { class: 'xqb-sub' }, t('secMatchScope', null, `Match against:`)),
      toggle(t('optMatchText', null, `Post text`), 'matchText'), toggle(t('optMatchName', null, `Display name`), 'matchName'),
      toggle(t('optMatchHandle', null, `Handle`), 'matchHandle'), toggle(t('optMatchBio', null, `Bio (when available)`), 'matchBio'),
      h('div', { class: 'xqb-sub' }, t('secThrottle', null, `Throttling:`)),
      numField(t('fieldDelay', null, `Delay ms`), 'minDelayMs', 300, 60000),
      numField(t('fieldJitter', null, `Jitter ms`), 'jitterMs', 0, 10000),
      numField(t('fieldMaxPerRun', null, `Max per run`), 'maxPerRun', 1, 500),
      h('div', { class: 'xqb-note' }, t('noteThrottle', null, `Going too fast can trigger X's rate limits or account checks. Keep the delay at 1.5s or more and the cap at 50 or fewer.`))
    );

    const logBody = h('div', { class: 'xqb-body' }, elLog);

    addTab('cand', t('tabCandidates', null, `Candidates`), candBody);
    addTab('kw', t('tabKeywords', null, `Filters`), kwBody);
    addTab('log', t('tabLog', null, `Log`), logBody);
    addTab('set', t('tabSettings', null, `Settings`), setBody);

    const head = h('div', { class: 'xqb-head' },
      h('span', {}, 'X Quick Blocker'),
      h('button', { class: 'xqb-x', onclick: () => panel.classList.remove('xqb-open') }, '×')
    );
    const content = h('div', { class: 'xqb-content' }, candBody, kwBody, logBody, setBody);
    panel = h('div', { class: 'xqb-panel' }, head, tabBar, content, elStatus);
    selectTab('cand');

    function togglePanel() {
      const open = panel.classList.toggle('xqb-open');
      if (open) positionPanel();
    }
    makeFabDraggable(fab, togglePanel);
    makePanelDraggable(head);
    document.body.append(fab, panel);

    if (fabPos) { applyFabPos(fab, fabPos); fabPos = clampFabPos(fab); applyFabPos(fab, fabPos); }
    window.addEventListener('resize', () => {
      if (fabPos) { fabPos = clampFabPos(fab); applyFabPos(fab, fabPos); }
      if (panel.classList.contains('xqb-open')) positionPanel();
    });

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
    scanTimer = setInterval(scanAll, 2000);
  });
})();
