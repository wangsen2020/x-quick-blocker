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
