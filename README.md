# 🐾 cocomi-worker

**COCOMI LINE receiver Worker (v2.6)** — LINE webhook を受け付けて `cocomi-postman` リポにファイルを配達する Cloudflare Worker のソースコードバックアップリポジトリ。

---

## ⚠️ このリポジトリの位置づけ

**このリポは「バックアップ用」です。** 実際に稼働しているコードは Cloudflare ダッシュボード上で直接管理されており、このリポジトリからの自動デプロイは**行われていません**。

- **原本**: Cloudflareダッシュボード（dash.cloudflare.com → Workers → cocomi-worker）
- **バックアップ先**: このリポジトリ（手動同期）
- **稼働URL**: https://cocomi-worker.k-akiyaman.workers.dev

バックアップの目的は、誤操作・誤削除時の復旧、および変更履歴の可視化です。

---

## 🎯 役割

cocomi-worker は COCOMI エコシステムにおける **LINE からの全入力の受付窓口**です。
LINEメッセージを解析して、`cocomi-postman` リポの適切な場所にファイルを push します。

### 処理フロー

```
👤 アキヤ → 💬 LINE → 📡 webhook → ☁️ cocomi-worker (v2.6)
                                      ├─ parseInstruction / resolveDestination
                                      ├─ createMissionContent（missionタグ注入）
                                      └─ pushToGitHub (GITHUB_TOKEN使用)
                                          ↓
                                       📦 akiyamanx/cocomi-postman
                                          missions/{project}/ または
                                          capsules/ または
                                          ideas/ に配置
                                          ↓ (60秒以内)
                                       📱 Termux postman.sh 自動モード
                                          ↓
                                       💬 LINE通知「成功！」
```

---

## 🛠 v2.6 の機能一覧

| コマンド | 機能 |
|---|---|
| 📃 `プロジェクト名: 指示内容` | テキスト指示を missions/ に push |
| 📁 `.mdファイル送信` | ファイル配達（種別自動判定） |
| 💊 カプセルファイル送信 | `capsules/daily/master/plans/` に自動振り分け |
| 💡 アイデアファイル送信 | `ideas/` に自動振り分け（サブフォルダ判定あり） |
| 🔧 開発メモファイル送信 | `dev-capsules/` に自動振り分け |
| 🎯 `<!-- dest: パス -->` | 配置先カスタマイズ（最優先） |
| 🛡️ `<!-- mission: project -->` | プロジェクト指定 |
| 📂 `フォルダ一覧` | cocomi-postman の全構造表示 |
| 🔍 `フォルダ ○○` | 指定フォルダの中身確認（Flex Message） |
| 📖 `読む ○○` | ファイル内容をLINEに表示 |
| ❓ `ヘルプ` / `ヘルプ 指示` | コマンド一覧 / 指示の送り方ガイド |
| 📊 `状態` | バージョン確認 |

### 対応プロジェクト（ホワイトリスト）

- `genba-pro` — 現場くん GenbaProSetsubikuN
- `culo-chan` — CULOchanGyomuPro
- `maintenance-map` — メンテナンスマップ
- `cocomi-postman` — COCOMI Postman 本体
- `cocomi-family` — COCOMIファミリー系

---

## 🔄 バージョン履歴

| バージョン | 変更内容 |
|---|---|
| v1.0 | LINE Webhook受信 → テキスト指示 → GitHub push → LINE返信 |
| v1.1 | LINEファイル受信・種別自動判定・capsules/missions/ 振り分け |
| v1.2 | sanitizeForFilename 強化 |
| v1.3 | `<!-- dest: パス -->` ルーティング追加 |
| v1.4 | フォルダ一覧・フォルダ中身確認コマンド追加 |
| v1.5 | 全コマンドの表記揺れ対応（スペース/全角/別名） |
| v1.6 | destタグ最優先ルーティング |
| **v2.0** | 🛡️ **安全バリデーション** — プロジェクト名必須化＆missionタグ自動注入 |
| v2.1 | リッチメニュー対応・ヘルプ/読むコマンド追加 |
| v2.2 | Flex Message対応（タップ可能なボタン付きカード） |
| v2.3 | ファイル名降順ソート・「もっと見る」ページネーション |
| **v2.4** | 日付抽出ソート・ボタン表示名短縮 |
| v2.5 | スマート振り分け・missionタグ自動注入・M-リネーム |
| **v2.6** | 🆕 **キーワード振り分け強化** — アイデア/メモ/計画書対応＋ideasサブフォルダ自動判定＋inboxガイド |

---

## ⚙️ 設定情報（Cloudflare）

### Domains & Routes

| 項目 | 値 |
|---|---|
| Type | workers.dev |
| URL | `cocomi-worker.k-akiyaman.workers.dev` |
| Preview URLs | Inactive |

### Secrets（Cloudflareダッシュボードで管理）

| Name | 用途 |
|---|---|
| `GITHUB_TOKEN` | cocomi-postman リポへの push 用（GH_PAT とは別物） |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API 送信用 |
| `LINE_CHANNEL_SECRET` | LINE webhook 署名検証用 |
| `LINE_USER_ID` | LINE 送信先ユーザーID |

### Runtime

| 項目 | 値 |
|---|---|
| Placement | Default |
| Compatibility date | 2026-02-22 |
| Compatibility flags | なし |
| Observability | Enabled（Logs 100% sampling） |

### Trigger Events

なし（fetch ハンドラのみ使用）

### Bindings

なし（D1/KV/R2/Vectorize/Durable Objects/Service Bindings 不使用）

---

## 🚀 手動デプロイ手順（現在はこの方法のみ）

1. このリポの `worker.js` の内容をコピー
2. https://dash.cloudflare.com → Workers & Pages → cocomi-worker
3. 右上の「Edit Code」をクリック
4. 既存コードを全選択して削除
5. コピーしたコードを貼り付け
6. 右上の「Deploy」ボタンをクリック
7. Deploy成功のトーストを確認

### ⚠️ デプロイ前チェック

- [ ] バージョンコメントが最新になっているか
- [ ] VALID_PROJECTS のプロジェクト一覧が正しいか
- [ ] GITHUB_OWNER / GITHUB_REPO が正しいか（通常 `akiyamanx` / `cocomi-postman`）
- [ ] LINEで「状態」コマンドを送って返信が来るか
- [ ] LINEで「フォルダ一覧」コマンドを送って返信が来るか

---

## 🔮 将来の移行計画

現在はダッシュボード直接管理だが、将来的には GitHub Actions 自動デプロイへの移行を予定：

1. `wrangler.toml` にデプロイ設定を追加（Secrets は別管理）
2. `.github/workflows/deploy.yml` を作成（wrangler-action@v3 使用）
3. GitHub Secrets に `CF_API_TOKEN` を追加
4. 最初のpushで自動デプロイ動作確認
5. ダッシュボードの「Edit Code」を封印（プロダクション安全化）

---

## 📚 関連リポジトリ

| リポ | 役割 |
|---|---|
| [cocomi-postman](https://github.com/akiyamanx/cocomi-postman) | cocomi-worker の push先。中央ハブ。 |
| [cocomi-mcp-server](https://github.com/akiyamanx/cocomi-mcp-server) | クロちゃんの MCP ツール（別系統） |
| [cocomi-api-relay](https://github.com/akiyamanx/cocomi-api-relay) | 三姉妹API中継（別系統） |
| [cocomi-capsules](https://github.com/akiyamanx/cocomi-capsules) | クロちゃんのドキュメント保管庫 |

---

## 💡 既知の問題

### 1. ヘルスチェックのバージョン表示が v2.5 のまま

`worker.js` のメインハンドラ内の GET レスポンスが、実装は v2.6 なのに表示だけ v2.5 になっている。機能には影響なし。**後日修正予定**。

```javascript
// 修正前
return new Response('🐾 COCOMI Worker is alive! v2.5\n...', {...});

// 修正後（予定）
return new Response('🐾 COCOMI Worker is alive! v2.6\n...', {...});
```

### 2. `resolveDestination` 関数にデフォルト return が欠けている

コメント上は「⑥ デフォルト inbox/」となっているが、最終フォールバックの return 文が実装されていない。すべての条件にマッチしないファイルを受け取ると undefined が返る可能性がある。**後日修正予定**。

---

## 🌸 このバックアップについて

このバックアップは 2026-04-09 の **Plan C** で作成されました。

COCOMIエコシステム全体地図（`cocomi-capsules/architecture/`）の作成過程で、「cocomi-worker だけソース管理されていない」という既知課題が発見され、誤操作時の復旧を可能にするためにリポジトリ化しました。

アキヤがスマホで Cloudflare ダッシュボードから手動でコードを取得し、クロちゃん（COCOMIファミリーの次女）が MCP 経由で push する、という「語りコード（KatariCode）」スタイルで実施されました。

---

**作成**: クロちゃん🔮 & アキヤ / 2026-04-09
**バージョン**: バックアップ v1.0
**関連ドキュメント**: `cocomi-capsules/architecture/02_cloudflare-workers.md`
