/* X Quick Blocker — content script (isolated world) */
(function () {
  'use strict';

  const FALLBACK_BEARER =
    'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const { DEFAULTS, seedDefaultFilters } = globalThis.XQB_CONFIG;
  // 垃圾评论的主流绕过手法是往每个汉字之间插零宽字符（ZWNJ/ZWJ/WORD JOINER…），
  // 页面上一个像素都看不出来，但 innerText 里 "比我好看" 会变成十几个字符，
  // 纯关键词和宽松正则全部落空。匹配前统一抹掉这些不可见字符。
  // 覆盖：软连字符、组合字形连接符、Arabic letter mark、蒙文元音分隔符、
  //       零宽/方向控制、字节序标记、变体选择符、Unicode 标签字符。
  const INVISIBLE_RE =
    /[­͏؜᠎​-‏‪-‮⁠-⁤⁪-⁯︀-️﻿]|[\u{e0000}-\u{e007f}]/gu;
  // 只保留文字和数字：把空格、标点、emoji 也一并去掉，这样 "骚🐞🤯比" 这种
  // 用表情拉开字距的写法也能被纯关键词命中。换行保留，避免昵称/正文/@ 串成一句
  // 造成跨字段误命中。
  const PUNCT_RE = /[^\p{L}\p{N}\n]/gu;

  // 兜底规则用的「可疑隐形字符」——注意比 INVISIBLE_RE 窄，刻意剔掉了三类
  // 在正常文本里合法出现的隐形字符，否则会把普通 emoji 当成垃圾：
  //   U+200D ZWJ        —— 👨‍👩‍👧 这类组合 emoji 的连接符，3 可见 + 2 连接 = 40%，会误判
  //   U+FE00–FE0F       —— emoji 变体选择符（❤️ 的那个 FE0F）
  //   U+E0020–U+E007F   —— 旗帜/子区域标签字符
  // 剔掉这三类后，实测那批垃圾评论仍有 53%~60% 是可疑字符（光靠 ZWNJ 和
  // WORD JOINER 就够了），而正常推文是 0%，中间隔着极宽的安全带。
  const SUSPICIOUS_RE = /[­͏؜᠎​‌‎‏‪-‮⁠-⁤⁪-⁯﻿]/g;
  const OBF_RATIO = 0.3;   // 可疑字符占比阈值
  const OBF_MIN = 6;       // 可疑字符绝对个数下限，避免极短文本被比例放大误判

  // 返回 0~1 的占比；不够触发条件就返回 0
  function obfuscationRatio(text) {
    const s = String(text == null ? '' : text);
    if (s.length < 8) return 0;
    const n = (s.match(SUSPICIOUS_RE) || []).length;
    if (n < OBF_MIN) return 0;
    const r = n / s.length;
    return r >= OBF_RATIO ? r : 0;
  }

  // NFKC 顺手把全角、带圈、上下标之类的花式写法折回普通字符
  function normText(s) {
    let out = String(s == null ? '' : s).replace(INVISIBLE_RE, '');
    try { out = out.normalize('NFKC'); } catch (e) {}
    return out;
  }

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
  let lastStatus = '';

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
      storeGet(['xqb_config', 'xqb_log', 'xqb_idmap', 'xqb_qid', 'xqb_feat'], (r) => {
        // 配置：chrome.storage 没有就回填 localStorage 里的镜像，并写回主存
        let savedCfg = r.xqb_config;
        if (!savedCfg) {
          const mirror = lsGet('xqb_config');
          if (mirror && typeof mirror === 'object') { savedCfg = mirror; storeSet({ xqb_config: mirror }); }
        }
        cfg = Object.assign({}, DEFAULTS, savedCfg || {});
        if (seedDefaultFilters(cfg)) saveCfg();
        lsSet('xqb_config', cfg);   // 每次启动刷新镜像

        log = r.xqb_log || [];
        if (r.xqb_idmap) idMap = new Map(Object.entries(r.xqb_idmap));
        if (r.xqb_qid) qidMap = new Map(Object.entries(r.xqb_qid));
        if (r.xqb_feat) gqlFeatures = r.xqb_feat;
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

  function rescanAllTweets(clearCand) {
    if (clearCand) {
      candidates.clear();
      updateBadge();
    }
    if (!cfg.enabled || !cfg.showInlineButton) {
      document.querySelectorAll('article[data-testid="tweet"] .xqb-btn-wrap').forEach((w) => w.remove());
    }
    document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => {
      a.dataset.xqb = '';
      a.classList.remove('xqb-hit');
    });
    scanAll();
    notifyPopup();
  }

  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (!extAlive()) return;
      if (area === 'local' && ch.xqb_config) {
        const prev = cfg;
        cfg = Object.assign({}, DEFAULTS, ch.xqb_config.newValue || {});
        lsSet('xqb_config', cfg);
        const scanOff = !cfg.enabled || !cfg.scanEnabled;
        const filterChanged =
          prev.enabled !== cfg.enabled ||
          prev.showInlineButton !== cfg.showInlineButton ||
          prev.scanEnabled !== cfg.scanEnabled ||
          prev.detectObfuscated !== cfg.detectObfuscated ||
          prev.matchText !== cfg.matchText ||
          prev.matchName !== cfg.matchName ||
          prev.matchHandle !== cfg.matchHandle ||
          prev.matchBio !== cfg.matchBio ||
          JSON.stringify(prev.keywords) !== JSON.stringify(cfg.keywords) ||
          JSON.stringify(prev.regexes) !== JSON.stringify(cfg.regexes) ||
          JSON.stringify(prev.whitelist) !== JSON.stringify(cfg.whitelist);
        if (filterChanged) rescanAllTweets(scanOff || prev.detectObfuscated !== cfg.detectObfuscated);
        if (cfg.enabled && cfg.scanEnabled && cfg.autoBlock && !prev.autoBlock && candidates.size && !running) {
          queueAuto();
        }
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
    const norm = normText(hay);                    // 去不可见字符 + NFKC
    const tight = norm.replace(PUNCT_RE, '');      // 再去空格/标点/emoji

    // 原文也留着一份：用户自己写的关键词/正则可能就是冲着标点或全角形态去的
    const kwHays = Array.from(new Set([hay, norm, tight])).map((s) => s.toLowerCase());
    const reHays = Array.from(new Set([hay, norm, tight]));

    for (const kw of cfg.keywords || []) {
      const k = String(kw).trim();
      if (!k) continue;
      // 关键词本身同样归一化，否则用户从垃圾评论里复制粘贴来的词自带零宽字符
      const cands = Array.from(new Set([k, normText(k), normText(k).replace(PUNCT_RE, '')]))
        .filter(Boolean)
        .map((s) => s.toLowerCase());
      if (kwHays.some((h) => cands.some((c) => h.includes(c)))) return { kind: 'kw', hit: k };
    }
    for (const re of compiledRegexes()) {
      for (const h of reHays) {
        const m = h.match(re);
        if (m) return { kind: 're', hit: `/${re.source}/ → ${m[0].slice(0, 30)}` };
      }
    }

    // 兜底：正文里塞了大量隐形字符本身就是垃圾特征，不依赖词库，换套新话术也拦得住。
    // 放在最后——能命中具体关键词时优先报那个词，日志里更好查。
    if (cfg.detectObfuscated && cfg.matchText) {
      const r = obfuscationRatio(info.text);
      if (r) {
        const pct = Math.round(r * 100);
        return { kind: 'obf', hit: t('hitObfuscated', [String(pct)], `Hidden-character obfuscation (${pct}%)`) };
      }
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
    tipEl.id = 'xqb-tip';
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

  // 禁止符（圆环 + 人像 + 斜杠），与扩展 logo 一致。整体单色 currentColor，
  // 以便融入 X 操作栏并沿用 hover/busy/fail 的变色。斜杠用 mask 在人像上切出
  // 缺口，否则同色会糊成一团。mask 定义只注入一次，所有按钮共用一个 id。
  const MASK_ID = 'xqb-slash-mask';
  function ensureDefs() {
    if (document.getElementById(MASK_ID)) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'xqb-defs');
    // 内联样式天然压过作者样式，不需要 !important
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML =
      `<defs><mask id="${MASK_ID}" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">` +
      '<rect x="0" y="0" width="24" height="24" fill="#fff"/>' +
      '<path d="M5 19 19 5" stroke="#000" stroke-width="3.8" stroke-linecap="round"/>' +
      '</mask></defs>';
    (document.body || document.documentElement).appendChild(svg);
  }

  const SVG = (inner) =>
    `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">${inner}</svg>`;

  const ICONS = {
    // 屏蔽：圆环 + 人像 + 斜杠（禁止符），与扩展图标同款
    block: SVG(
      `<g fill="currentColor" mask="url(#${MASK_ID})">` +
      '<circle cx="12" cy="9.1" r="3"/>' +
      '<path d="M12 12.6c-3.5 0-6 2.1-6 4.8 0 .25.05.5.12.7h11.76c.07-.2.12-.45.12-.7 0-2.7-2.5-4.8-6-4.8z"/>' +
      '</g>' +
      '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2.2"/>' +
      '<path d="M5 19 19 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/>'
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
        updateBadge();
        notifyPopup();
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
          updateBadge();
          notifyPopup();
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

        // 通知 popup 刷新不能中断批量
        try {
          updateBadge();
          setStatus(t('statusRunning', [done, fail, Math.max(0, list.length - done - fail)], `Running: ${done} done / ${fail} failed / ${Math.max(0, list.length - done - fail)} left`) +
            (lastErr ? t('statusLastFail', [lastErr], ` | last error: ${lastErr}`) : ''));
        } catch (e) {
          console.warn('[xqb] status refresh error (batch continues)', e);
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

  /* ---------------- popup bridge & page toast ---------------- */
  function toast(msg, bad) {
    const t = document.createElement('div');
    t.className = 'xqb-toast' + (bad ? ' xqb-toast-bad' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('xqb-show'), 10);
    setTimeout(() => { t.classList.remove('xqb-show'); setTimeout(() => t.remove(), 300); }, 3200);
  }

  function getStatePayload() {
    return {
      candidates: Array.from(candidates.values()),
      running,
      status: lastStatus || t('statusReady', null, 'Ready'),
    };
  }

  function notifyPopup() {
    if (!extAlive()) return;
    try {
      chrome.runtime.sendMessage({ type: 'xqb:stateUpdate', state: getStatePayload() }, () => {
        // popup 未打开时没有接收方，读取 lastError 避免未捕获提示
        void (chrome.runtime && chrome.runtime.lastError);
      });
    } catch (e) {}
  }

  function setStatus(s) {
    lastStatus = s;
    notifyPopup();
  }

  function setRunUI() {
    notifyPopup();
  }

  function updateBadge() {
    if (!extAlive()) return;
    try {
      chrome.runtime.sendMessage({ type: 'xqb:badge', count: candidates.size }, () => {
        void (chrome.runtime && chrome.runtime.lastError);
      });
    } catch (e) {}
  }

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!extAlive() || !msg || typeof msg.type !== 'string') return;
      if (msg.type === 'xqb:getState') {
        sendResponse({ ok: true, state: getStatePayload() });
        return;
      }
      if (msg.type === 'xqb:toggleCandidate') {
        const c = candidates.get(String(msg.handle || '').toLowerCase());
        if (c) c.checked = !!msg.checked;
        sendResponse({ ok: true, state: getStatePayload() });
        return;
      }
      if (msg.type === 'xqb:selectAll') {
        candidates.forEach((c) => { c.checked = true; });
        sendResponse({ ok: true, state: getStatePayload() });
        return;
      }
      if (msg.type === 'xqb:clearCandidates') {
        candidates.clear();
        updateBadge();
        sendResponse({ ok: true, state: getStatePayload() });
        return;
      }
      if (msg.type === 'xqb:ignoreCandidate') {
        candidates.delete(String(msg.handle || '').toLowerCase());
        updateBadge();
        sendResponse({ ok: true, state: getStatePayload() });
        return;
      }
      if (msg.type === 'xqb:runBatch') {
        const list = Array.from(candidates.values()).filter((c) => c.checked !== false);
        if (list.length && !running) runBatch(list);
        sendResponse({ ok: true, state: getStatePayload() });
        return;
      }
      if (msg.type === 'xqb:stopBatch') {
        stopFlag = true;
        toast(t('toastStopRequested', null, 'Stop requested'));
        sendResponse({ ok: true, state: getStatePayload() });
        return;
      }
      if (msg.type === 'xqb:unblock') {
        unblockUser(msg.handle)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, err: friendly(err) }));
        return true;
      }
    });
  } catch (e) {}

  /* ---------------- boot ---------------- */
  loadAll().then(() => {
    // 回放 document_idle 之前 hook 已经抓到的映射
    try { window.postMessage({ __xqbReq: 'flush' }, location.origin); } catch (e) {}
    setTimeout(() => { try { window.postMessage({ __xqbReq: 'flush' }, location.origin); } catch (e) {} }, 2500);
    lastStatus = t('statusReady', null, 'Ready');
    detectSelf();
    scanAll();
    updateBadge();
    mo.observe(document.body, { childList: true, subtree: true });
    scanTimer = setInterval(scanAll, 2000);
  });
})();
