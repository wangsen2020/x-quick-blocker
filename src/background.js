import { welcomeUrl, uninstallUrl } from './lib/site.js';

function siteDetails() {
  return {
    uiLang: chrome.i18n.getUILanguage(),
    version: chrome.runtime.getManifest().version,
  };
}

async function setUninstallUrl() {
  try {
    const { installedDate } = await chrome.storage.local.get('installedDate');
    await chrome.runtime.setUninstallURL(uninstallUrl({ ...siteDetails(), installed: installedDate }));
  } catch (e) {
    console.warn('Uninstall URL registration failed:', e);
  }
}

// Refresh on every worker start, including browser restarts.
setUninstallUrl();

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    try {
      const { installedDate } = await chrome.storage.local.get('installedDate');
      if (!installedDate) {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        await chrome.storage.local.set({ installedDate: date });
      }
      await chrome.tabs.create({ url: welcomeUrl(siteDetails()) });
    } catch (e) {
      console.warn('Install welcome page failed:', e);
    }
  }
  if (details.reason === 'install' || details.reason === 'update') await setUninstallUrl();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'xqb:badge' || !sender || !sender.tab || sender.tab.id == null) return;
  const tabId = sender.tab.id;
  const count = Number(msg.count) || 0;
  try {
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
    if (count > 0) chrome.action.setBadgeBackgroundColor({ color: '#f4212e', tabId });
  } catch (e) {}
});
