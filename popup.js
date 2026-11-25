/* X Quick Blocker — unified popup */
(function () {
  'use strict';

  const { DEFAULTS, seedDefaultFilters } = globalThis.XQB_CONFIG;

  function t(key, subs, fallback) {
    try {
      const m = chrome.i18n && chrome.i18n.getMessage(key, subs);
      if (m) return m;
    } catch (e) {}
    return fallback;
  }

  let cfg = Object.assign({}, DEFAULTS);
  let log = [];
  let pageState = { candidates: [], running: false, status: t('statusReady', null, 'Ready') };
  let activeXTabId = null;
  let activeTab = 'set';

  const elTitle = document.getElementById('xqbTitle');
  const elVer = document.getElementById('xqbVer');
  const elStatus = document.getElementById('xqbStatus');
  const elListCand = document.getElementById('listCand');
  const elListLog = document.getElementById('listLog');
  const elCandCount = document.getElementById('tabCandCount');
  const elConfirmBar = document.getElementById('confirmBar');
  const elConfirmMsg = document.getElementById('confirmMsg');
  const elBtnYes = document.getElementById('btnConfirmYes');
  const elBtnNo = document.getElementById('btnConfirmNo');
  const elBtnSelectAll = document.getElementById('btnSelectAll');
  const elBtnClear = document.getElementById('btnClearList');
  const elBtnRun = document.getElementById('btnRunBatch');
  const elBtnStop = document.getElementById('btnStopBatch');

  const bodies = {
    cand: document.getElementById('bodyCand'),
    kw: document.getElementById('bodyKw'),
    log: document.getElementById('bodyLog'),
    set: document.getElementById('bodySet'),
  };
  const tabBtns = {};
  document.querySelectorAll('.xqb-tab').forEach((btn) => {
    tabBtns[btn.dataset.tab] = btn;
    btn.addEventListener('click', () => selectTab(btn.dataset.tab));
  });

  function selectTab(id) {
    activeTab = id;
    const tip = document.getElementById('xqbPopupTip');
    if (tip) tip.style.display = 'none';
    for (const k of Object.keys(tabBtns)) {
      tabBtns[k].classList.toggle('xqb-tab-on', k === id);
      bodies[k].style.display = k === id ? 'flex' : 'none';
    }
  }

  function toast(msg, bad) {
    const el = document.createElement('div');
    el.className = 'xqb-toast' + (bad ? ' xqb-toast-bad' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('xqb-toast-show'), 10);
    setTimeout(() => {
      el.classList.remove('xqb-toast-show');
      setTimeout(() => el.remove(), 250);
    }, 2600);
  }

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'class') e.className = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  }

  function applyI18n() {
    elTitle.textContent = t('panelTitle', null, 'X Quick Blocker');
    try { elVer.textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {}
    document.getElementById('tabCandLabel').textContent = t('tabCandidates', null, 'Candidates');
    document.getElementById('tabKw').textContent = t('tabKeywords', null, 'Filters');
    document.getElementById('tabLog').textContent = t('tabLog', null, 'Log');
    document.getElementById('tabSet').textContent = t('tabSettings', null, 'Settings');
    elBtnSelectAll.textContent = t('btnSelectAll', null, 'Select all');
    elBtnClear.textContent = t('btnClearList', null, 'Clear');
    elBtnRun.textContent = t('btnBlockChecked', null, 'Block selected');
    elBtnStop.textContent = t('btnStop', null, 'Stop');
    elBtnYes.textContent = t('btnConfirm', null, 'Confirm');
    elBtnNo.textContent = t('btnCancel', null, 'Cancel');

    document.getElementById('lblKeywords').textContent = t('labelKeywords', null, 'Keywords (one per line, case-insensitive)');
    document.getElementById('lblRegexes').textContent = t('labelRegexes', null, 'Regex (one per line, JS syntax, no slashes)');
    document.getElementById('lblWhitelist').textContent = t('labelWhitelist', null, 'Allowlist handles (one per line, no @)');
    document.getElementById('kwKeywords').placeholder = t('phKeywords', null, 'crypto airdrop\ngiveaway\nDM me');
    document.getElementById('kwRegexes').placeholder = t('phRegexes', null, '^(?=.*airdrop)(?=.*DM).*$');
    document.getElementById('kwWhitelist').placeholder = t('phWhitelist', null, 'yourfriend');

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const m = t(el.dataset.i18n, null, '');
      if (m) el.textContent = m;
    });
    document.querySelectorAll('[data-tip-i18n]').forEach((el) => {
      const m = t(el.dataset.tipI18n, null, '');
      if (m) {
        el.dataset.tip = m;
        el.setAttribute('aria-label', m);
      }
    });
  }

  function bindInfoTips() {
    const tip = document.getElementById('xqbPopupTip');
    if (!tip) return;
    const show = (anchor) => {
      const text = anchor.dataset.tip;
      if (!text) return;
      tip.textContent = text;
      tip.style.display = 'block';
      const r = anchor.getBoundingClientRect();
      const b = tip.getBoundingClientRect();
      let left = r.left + r.width / 2 - b.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - b.width - 8));
      let top = r.top - b.height - 6;
      if (top < 8) top = r.bottom + 6;
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
    };
    const hide = () => { tip.style.display = 'none'; };
    document.querySelectorAll('.xqb-info-tip').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); show(btn); });
      btn.addEventListener('mouseenter', () => show(btn));
      btn.addEventListener('mouseleave', hide);
      btn.addEventListener('focus', () => show(btn));
      btn.addEventListener('blur', hide);
    });
  }

  function saveCfg() {
    chrome.storage.local.set({ xqb_config: cfg });
  }

  function syncInputsFromCfg() {
    document.querySelectorAll('[data-key]').forEach((el) => {
      const k = el.dataset.key;
      if (el.type === 'checkbox') el.checked = !!cfg[k];
      else if (el.tagName === 'TEXTAREA') el.value = (cfg[k] || []).join('\n');
      else el.value = cfg[k];
    });
  }

  function bindConfigInputs() {
    document.querySelectorAll('[data-key]').forEach((el) => {
      const k = el.dataset.key;
      if (el.type === 'checkbox') {
        el.addEventListener('change', () => {
          cfg[k] = el.checked;
          saveCfg();
        });
      } else if (el.tagName === 'TEXTAREA') {
        el.addEventListener('change', () => {
          cfg[k] = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
          saveCfg();
          const lbl = el.previousElementSibling ? el.previousElementSibling.textContent : k;
          toast(t('toastListSaved', [lbl, cfg[k].length], `${lbl} saved (${cfg[k].length} entries)`));
        });
      } else if (el.type === 'number') {
        el.addEventListener('change', () => {
          const min = Number(el.min) || 0;
          const max = Number(el.max) || 999999;
          const v = Math.max(min, Math.min(max, Number(el.value) || min));
          cfg[k] = v;
          el.value = v;
          saveCfg();
        });
      }
    });
  }

  function reasonText(r) {
    if (!r) return '';
    if (typeof r === 'object' && r.k === 'hit') return t('reasonHit', [r.v], `Matched “${r.v}”`);
    if (r === 'manual') return t('reasonManual', null, 'Manual');
    if (r === 'batch') return t('reasonBatch', null, 'Batch');
    return String(r);
  }

  function renderLog() {
    elListLog.textContent = '';
    if (!log.length) {
      elListLog.append(h('div', { class: 'xqb-empty' }, t('emptyLog', null, 'No entries')));
      return;
    }
    for (const l of log.slice(0, 100)) {
      elListLog.append(
        h('div', { class: 'xqb-row' },
          h('div', { class: 'xqb-row-main' },
            h('div', { class: 'xqb-row-top' },
              h('span', { class: l.ok ? 'xqb-ok' : 'xqb-bad' }, l.ok ? '✓' : '✗'),
              h('a', { class: 'xqb-handle', href: `https://x.com/${l.handle}`, target: '_blank', rel: 'noreferrer' }, `@${l.handle}`),
              h('span', { class: 'xqb-hit-tag' }, reasonText(l.reason))
            ),
            h('div', { class: 'xqb-snippet' }, (l.err ? l.err + '  ' : '') + new Date(l.t).toLocaleString())
          ),
          l.ok ? h('button', {
            type: 'button',
            class: 'xqb-mini',
            onclick: async (e) => {
              const btn = e.currentTarget;
              const conn = await findResponsiveXTab();
              const tabId = conn && conn.tabId;
              if (!tabId) {
                toast(t('errNoXTab', null, 'Please open an x.com tab first to unblock'), true);
                return;
              }
              btn.disabled = true;
              btn.textContent = '···';
              const res = await sendToTab(tabId, { type: 'xqb:unblock', handle: l.handle });
              if (res && res.ok) {
                btn.textContent = t('btnUnblocked', null, 'Unblocked');
              } else {
                btn.disabled = false;
                btn.textContent = t('btnFailedShort', null, 'Failed');
                toast((res && res.err) || t('btnFailedShort', null, 'Failed'), true);
              }
            },
          }, t('btnUnblock', null, 'Unblock')) : null
        )
      );
    }
  }

  function renderCandidates() {
    elListCand.textContent = '';
    const list = pageState.candidates || [];
    const n = list.length;
    elCandCount.textContent = n > 0 ? String(n) : '';
    elCandCount.style.display = n > 0 ? 'inline-block' : 'none';

    elBtnRun.disabled = !!pageState.running || !activeXTabId;
    elBtnSelectAll.disabled = !activeXTabId || !n;
    elBtnClear.disabled = !activeXTabId || !n;
    elBtnStop.style.display = pageState.running ? 'inline-flex' : 'none';
    elStatus.textContent = pageState.status || t('statusReady', null, 'Ready');

    if (!activeXTabId) {
      elListCand.append(h('div', { class: 'xqb-empty' }, t('emptyNeedXTab', null, 'Open an x.com tab to view page candidates')));
      return;
    }
    if (!n) {
      elListCand.append(h('div', { class: 'xqb-empty' }, cfg.scanEnabled ? t('emptyScanOn', null, 'No matches yet — keep scrolling') : t('emptyScanOff', null, 'Scanning is off (turn it on in Settings)')));
      return;
    }
    for (const c of list) {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = c.checked !== false;
      cb.addEventListener('change', async () => {
        c.checked = cb.checked;
        const res = await sendToTab(activeXTabId, { type: 'xqb:toggleCandidate', handle: c.handle, checked: cb.checked });
        if (res && res.ok && res.state) applyPageState(res.state);
      });
      elListCand.append(
        h('div', { class: 'xqb-row' },
          cb,
          h('div', { class: 'xqb-row-main' },
            h('div', { class: 'xqb-row-top' },
              h('a', { class: 'xqb-handle', href: `https://x.com/${c.handle}`, target: '_blank', rel: 'noreferrer' }, `@${c.handle}`),
              h('span', { class: 'xqb-hit-tag' }, c.hit || '')
            ),
            h('div', { class: 'xqb-snippet' }, c.snippet || '')
          ),
          h('button', {
            type: 'button',
            class: 'xqb-mini',
            onclick: async () => {
              const res = await sendToTab(activeXTabId, { type: 'xqb:ignoreCandidate', handle: c.handle });
              if (res && res.ok && res.state) applyPageState(res.state);
            },
          }, t('btnIgnore', null, 'Ignore'))
        )
      );
    }
  }

  function applyPageState(st) {
    if (!st) return;
    pageState = st;
    renderCandidates();
  }

  function isXUrl(url) {
    return typeof url === 'string' && /^https:\/\/(x|twitter)\.com\//.test(url);
  }

  async function findResponsiveXTab() {
    try {
      const seen = new Set();
      const candidatesTabs = [];
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      for (const t of activeTabs) {
        if (isXUrl(t.url) && !seen.has(t.id)) { seen.add(t.id); candidatesTabs.push(t); }
      }
      const xTabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
      for (const t of xTabs) {
        if (!seen.has(t.id)) { seen.add(t.id); candidatesTabs.push(t); }
      }
      for (const t of candidatesTabs) {
        const res = await sendToTab(t.id, { type: 'xqb:getState' });
        if (res && res.ok && res.state) return { tabId: t.id, state: res.state };
      }
    } catch (e) {}
    return null;
  }

  function sendToTab(tabId, msg) {
    return new Promise((resolve) => {
      if (!tabId) { resolve(null); return; }
      try {
        chrome.tabs.sendMessage(tabId, msg, (resp) => {
          if (chrome.runtime && chrome.runtime.lastError) { resolve(null); return; }
          resolve(resp || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  elBtnSelectAll.addEventListener('click', async () => {
    if (!activeXTabId) return;
    const res = await sendToTab(activeXTabId, { type: 'xqb:selectAll' });
    if (res && res.ok && res.state) applyPageState(res.state);
  });

  elBtnClear.addEventListener('click', async () => {
    if (!activeXTabId) return;
    elConfirmBar.style.display = 'none';
    const res = await sendToTab(activeXTabId, { type: 'xqb:clearCandidates' });
    if (res && res.ok && res.state) applyPageState(res.state);
  });

  elBtnRun.addEventListener('click', () => {
    const list = (pageState.candidates || []).filter((c) => c.checked !== false);
    if (!list.length) {
      toast(t('toastNoChecked', null, 'Nothing selected'));
      return;
    }
    elConfirmMsg.textContent = t('confirmBatch', [list.length, (cfg.minDelayMs / 1000).toFixed(1)], `Block ${list.length} accounts, about ${(cfg.minDelayMs / 1000).toFixed(1)}s apart. Continue?`);
    elConfirmBar.style.display = 'flex';
  });

  elBtnYes.addEventListener('click', async () => {
    elConfirmBar.style.display = 'none';
    if (!activeXTabId) return;
    const res = await sendToTab(activeXTabId, { type: 'xqb:runBatch' });
    if (res && res.ok && res.state) applyPageState(res.state);
  });

  elBtnNo.addEventListener('click', () => {
    elConfirmBar.style.display = 'none';
  });

  elBtnStop.addEventListener('click', async () => {
    if (!activeXTabId) return;
    const res = await sendToTab(activeXTabId, { type: 'xqb:stopBatch' });
    if (res && res.ok && res.state) applyPageState(res.state);
  });

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== 'xqb:stateUpdate' || !msg.state) return;
    if (sender && sender.tab && activeXTabId && sender.tab.id !== activeXTabId) return;
    applyPageState(msg.state);
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.xqb_config) {
      cfg = Object.assign({}, DEFAULTS, ch.xqb_config.newValue || {});
      syncInputsFromCfg();
      renderCandidates();
    }
    if (ch.xqb_log) {
      log = ch.xqb_log.newValue || [];
      renderLog();
    }
  });

  async function init() {
    applyI18n();
    bindInfoTips();
    bindConfigInputs();

    const stored = await new Promise((res) => chrome.storage.local.get(['xqb_config', 'xqb_log'], res));
    cfg = Object.assign({}, DEFAULTS, (stored && stored.xqb_config) || {});
    if (seedDefaultFilters(cfg)) saveCfg();
    log = (stored && stored.xqb_log) || [];

    syncInputsFromCfg();
    renderLog();

    const conn = await findResponsiveXTab();
    if (conn) {
      activeXTabId = conn.tabId;
      pageState = conn.state;
    } else {
      activeXTabId = null;
    }
    renderCandidates();
    selectTab(pageState.candidates && pageState.candidates.length > 0 ? 'cand' : 'set');
  }

  init();
})();
