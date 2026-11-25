# Changelog

## 1.0.0

- Unify the injected floating panel and extension popup into a single `480×580` popup (`Candidates`, `Filters`, `Log`, `Settings`) with zero vertical scrolling.
- Remove the persistent floating wake-up icon (`.xqb-fab`) and floating panel (`.xqb-panel`) from `x.com` pages; show candidate counts on the toolbar extension icon badge instead.
- Streamline Settings and Filters labels with `#769287` info-tip (`?`) hover/focus tooltips.
- Add `src/lib/config.js` to share `DEFAULTS` and `seedDefaultFilters` between content script and popup, and add unit tests in `test/config.test.js`.
- Support responsive `x.com` tab fallback when multiple tabs are open, plus live config sync without page reload.

## 0.5.0

- Add localized install welcome and uninstall feedback URLs with pure URL helpers.
- Register uninstall URLs on worker startup and installation/update; preserve the local install date.
- Add a module service worker without new permissions.
- Add Node URL and lifecycle tests and syntax lint scripts.
- Localize the floating button tooltip in all eight languages and use X Blocker as the panel display name.
