# X Quick Blocker

在 x.com 上：① 每条推文旁加一个「屏蔽」按钮，一键拉黑；② 按关键词/正则扫描时间线，命中的账号进候选列表，**你确认后**再节流批量屏蔽。

## 安装

1. 解压到一个固定目录（别放临时文件夹，Chrome 每次启动都要读它）
2. Chrome 打开 `chrome://extensions/`
3. 右上角打开「开发者模式」
4. 点「加载已解压的扩展程序」，选中这个目录
5. 打开 x.com（需已登录），页面右下角出现 🛡 按钮

## 用法

- **一键屏蔽**：每条推文操作栏最右边多了个红色「屏蔽」按钮，点一下直接拉黑作者。
- **关键词扫描**：点 🛡 → 设置 → 打开「关键词扫描」；到「词库」页填关键词（一行一个）、正则、白名单。往下刷时间线，命中的推文左侧会有红条，账号进「候选」列表。
- **批量执行**：在「候选」页取消不想屏蔽的，点「屏蔽已勾选」，确认后按设定间隔逐个执行，中途可「停止」。
- **日志/撤销**：「日志」页有每次屏蔽记录，点「解除」可取消屏蔽（误伤的救命按钮）。
- 「全自动」开关默认关闭。打开后命中即屏蔽、不弹确认——误伤风险高，建议先用半自动跑几天，把词库调准了再考虑。

## 技术实现

- MV3，两段 content script：
  - `src/inject.js` 跑在 MAIN world，**只读**地 hook `fetch`/`XHR`，做两件事：抓 X 网页自己用的 `authorization` 头（避免硬编码 bearer 过期），以及从时间线 GraphQL 响应里抽 `screen_name → rest_id` 映射。
  - `src/content.js` 跑在 ISOLATED world，负责 UI、匹配、调接口。
- 屏蔽走 X 网页版自己的内部接口 `POST /i/api/1.1/blocks/create.json`（`user_id=...`），带页面 cookie + `x-csrf-token: ct0`；解除走 `blocks/destroy.json`。
- **user_id 的解析链**（页面 DOM 里只有 `@handle`，没有数字 id）：
  1. hook 从时间线 GraphQL 响应里抓到的 `screen_name → rest_id` 缓存（大多数情况走这条，零额外请求）
  2. `GET /i/api/graphql/<queryId>/UserByScreenName` —— queryId 由 hook 从观察到的请求 URL 里学习（X 每次发版都会变，不能硬编码）；`features` 参数缺哪些，X 会在报错里列出来，代码据此自动补全并重试
  3. 老的 `1.1/users/show.json`（多数账号上已经 404，只作兜底）
  4. 都拿不到时，直接用 `screen_name=` 调 blocks 接口
- 首次装好后建议**随便点开一个用户主页一次**，让插件学到 `UserByScreenName` 的 queryId（存本地，之后一直有效）。
- 不需要 X API key、不需要付费 API tier，也不上传任何数据到第三方；词库、日志、id 缓存全在 `chrome.storage.local`。

## 风险与注意

- **v0.1.0 会报「解析 user_id 失败 (404)」**：`1.1/users/show.json` 已被 X 下掉，0.1.2 起改走 GraphQL 并修了早期映射丢失的问题。
- **这是私有接口，不是公开 API**，X 改版可能随时失效（届时改 `src/content.js` 里的 endpoint / header 即可）。
- **批量操作有风控风险**：屏蔽接口有频次限制，短时间大量调用会 429，极端情况下账号可能被要求验证或临时限制。默认间隔 1.5s + 随机抖动、单次上限 50，触发 429 会自动指数退避——不建议把间隔调到 1s 以下。
- 自动化账号操作在 X 的自动化规则下属灰区，自用、低频、针对骚扰内容风险较低，大规模跑要自己权衡。
- 关键词误伤很常见（引用批评某个词的人也会命中）。建议：先用「昵称+用户名」匹配比只匹配正文准；正文匹配尽量用正则加条件（如同时含「空投」和「私信」）。

## 目录

```
manifest.json
popup.html / popup.js     浏览器工具栏的快捷开关
src/inject.js             MAIN world hook（抓 token / user id）
src/content.js            主逻辑 + 面板 UI
src/panel.css             样式
icons/
```
