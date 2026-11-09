# 專案規則

共用規則見 `D:\Codex\Projects\AGENTS.md`（Claude 與 Codex 共用，含自動 commit 與 push），先讀它。本檔只寫此專案特有的規則；衝突時以本檔為準。計畫與交接放在 `docs/plans/`。

## 專案概要

Chrome 擴充功能：收集 Threads 貼文或留言的按讚帳號，經使用者確認名單後封鎖。擴充功能本體在 `extension/`，測試在 `tests/`，打包腳本為 `scripts/package.py`。push 到 `05zhi/threads-likes-blocker` 的目前分支。

## 開始前閱讀

- `README.md`

## 驗證方式

- `npm test`（Node 22 以上）
- 涉及頁面操作時另跑 `npm run test:browser`、`npm run test:profiles`

## 專案特有限制

- 封鎖只能在使用者確認名單後執行；不得新增未經確認就封鎖的流程。
- 使用者匯出的名單、驗證紀錄、瀏覽器設定檔與 `evidence/`、`work/` 不提交（見 `.gitignore`）。
- 測試用 fixture 不放真實帳號資料。
