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
