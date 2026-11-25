/* X Quick Blocker — shared config defaults & seed logic (classic script + ES/CJS safe) */
(function (root) {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    showInlineButton: true,
    scanEnabled: false,
    autoBlock: false,
    keywords: [],
    regexes: [],
    whitelist: [],
    matchText: true,
    matchName: true,
    matchHandle: true,
    matchBio: true,
    minDelayMs: 1500,
    jitterMs: 800,
    maxPerRun: 50,
    removeBlockedDom: true,
    detectObfuscated: true,
    logLimit: 500,
    defaultsSeedVersion: 0,
  };

  const DEFAULT_SEED_VERSION = 2;
  const DEFAULT_KEYWORDS = [
    '没人比我', '我福不黑', '不信你看', '同城上门', '比我好看',
    '不进入生活', '不入生活', '只入身体', '处男无偿', '我玩的开',
    '比我骚', '没我好看', '果然太涩', '太涩了',
  ];

  function loosePattern(phrase) {
    return Array.from(phrase)
      .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.{0,3}?');
  }
  const DEFAULT_REGEXES = DEFAULT_KEYWORDS.map(loosePattern);

  function seedDefaultFilters(cfg) {
    if (!cfg || typeof cfg !== 'object') return false;
    if ((cfg.defaultsSeedVersion || 0) >= DEFAULT_SEED_VERSION) return false;
    const kwSet = new Set(cfg.keywords || []);
    const reSet = new Set(cfg.regexes || []);
    let changed = false;
    for (const k of DEFAULT_KEYWORDS) if (!kwSet.has(k)) { kwSet.add(k); changed = true; }
    for (const r of DEFAULT_REGEXES) if (!reSet.has(r)) { reSet.add(r); changed = true; }
    cfg.keywords = Array.from(kwSet);
    cfg.regexes = Array.from(reSet);
    cfg.defaultsSeedVersion = DEFAULT_SEED_VERSION;
    return changed;
  }

  root.XQB_CONFIG = {
    DEFAULTS,
    DEFAULT_SEED_VERSION,
    DEFAULT_KEYWORDS,
    DEFAULT_REGEXES,
    loosePattern,
    seedDefaultFilters,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
