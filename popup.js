// 文案本地化：HTML 里写英文兜底，chrome.i18n 有对应 message 就替换。
// 这样即使语言包缺失也不会出现空白标签。
document.querySelectorAll('[data-i18n]').forEach((el) => {
  const m = chrome.i18n.getMessage(el.dataset.i18n);
  if (m) el.textContent = m;
});

const KEYS = ['enabled', 'showInlineButton', 'scanEnabled', 'autoBlock'];
chrome.storage.local.get('xqb_config', (r) => {
  const c = r.xqb_config || { enabled: true, showInlineButton: true };
  KEYS.forEach((k) => {
    const el = document.getElementById(k);
    el.checked = !!c[k];
    el.addEventListener('change', () => {
      chrome.storage.local.get('xqb_config', (r2) => {
        const cfg = r2.xqb_config || {};
        cfg[k] = el.checked;
        chrome.storage.local.set({ xqb_config: cfg });
      });
    });
  });
});
