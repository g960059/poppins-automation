# ポピンズ返信アシスタント v0.6

ポピンズシッター（SmartSitter）のメッセージ返信の下書きに加え、**チャット合意からのシステム申請（依頼）半自動化・申請予約キュー・申請後の状態追跡**を行う個人用 Chrome 拡張。送信・依頼の最終操作は必ず自分で行う（人間確認つきRPA）。

## v0.6 の主な変更（申請アシスタント Level 3 + Phase 2）

- **申請予約キュー（永続）**。候補を「予約に入れる／追跡に追加」で `applyQueue` に保存。2か月超の予定も保持し、申請可能日になったら拾う。
- **申請可能の通知（Phase 2）**。`chrome.alarms`（既定6時間ごと、Chrome起動中に発火）で予約を点検し、`今日+2か月`の窓に入った予定を Chrome 通知でお知らせ（`deferred → ready`）。
- **申請後の状態追跡（Level 3）**。`/parent/issues` を最大5ページまで照合し、キュー各件の状態（`見積り待ち / シッター対応待ち / 要対応・承認待ち / 確定 / キャンセル`）と issueId を更新。**「要対応（見積もり到着）」になったら24時間以内の確定を促す通知**。
- **送信後の詳細ページ追跡**。`/parent/sitting/issues/{id}` を開いた時点で content script が依頼詳細を読み、該当するキューを即時更新（フォームを開いただけでは申請済みにしない）。
- **申請フォームの実DOM検証**。`pendingApply` と URL だけでなく、フォーム上の `#issue_date / #js-start-at / #js-end-at / #sitter_public_id` も照合。不一致・取得不可なら赤い警告を出して自動入力を止める。
- **月末日の2か月計算を安全化**。`1/31 + 2か月` のようなケースで月があふれないよう、月末にクランプする。
- **状態更新の2経路**：side panel の「予約・状態を更新」（SmartSitterタブがあれば同一オリジンで取得＝確実）と、バックグラウンドの定期取得（タブ不要の認証付き取得＋offscreen文書でHTMLパース）。
- 申請タブに**予約・追跡一覧**を追加（要確定 / 申請可能 / 予約中 / 申請済み・見積り待ち / 確定 / キャンセル）。各件に「フォームに入力 / 依頼を開く / 削除」。
- manifest 権限に `alarms / notifications / offscreen` を追加。`src/offscreen.{html,js}` を追加（service worker に DOMParser が無いため、一覧HTMLのパースだけをoffscreen文書で実施）。

> 注: 一覧ステータスのキーワード判定は、実データに合わせて `classifyIssueStatus` の追加調整が必要な場合があります。バックグラウンドの認証付き取得が失敗しても、SmartSitterタブを開いた状態の「予約・状態を更新」で追跡できます。

## v0.5 の主な変更（申請アシスタント Level 1–2）

- **申請タブを追加**。メッセージ室のチャットから「申請候補」を抽出し、`要確認（2か月以内） / まだ申請不可（2か月超） / 既に依頼あり / 除外` に分類して表示（Level 1・ドライラン）。
- **抽出は decision 付き**（agreed / candidate / declined / pending）。チャットで「見送り」になった日も**除外として明示**し、黙って落とさない。
- **2か月ローリング窓**で申請可否を判定（`今日+2か月`まで）。2か月超は「◯/◯から申請可能」を表示。
- **既存依頼との重複チェック**（進行中/確定の同一日を「既に依頼あり」に分類）。
- **Level 2：実フォーム自動入力**。「フォームに入力」で `/parent/sitting/issues/new?date=&start=&end=&sitter_id=` を開き（住所・子ども・料金はSmartSitter側が補完）、「今回伝えておきたいこと」を下書き、**送信はあなたが実フォームで実行**。拡張は `#js-submit-button` を自動クリックしない。
- **申請フォームに確認バナー**を表示（予定の要約、`前回交通費と同じなら見積もり不要`がONなら警告、送信は手動である旨）。
- **sitter_id の解決**：メッセージ室には申請用 `sitter_id` が無いため、プロフィールページから解決して `profileId` をキーに記憶（取得できなければ一度だけURLを貼付け）。以後は自動。
- content script の注入対象に申請フォーム（`/parent/sitting/issues/new*`）と申請詳細（`/parent/sitting/issues/{id}`）を追加。storage allowlist に `applyQueue / pendingApply / sitterid:*` を追加。

### 申請の安全則（v0.5）

- 常に**SmartSitterの実フォーム**を操作し、POSTは合成しない（CSRF・料金見積もり・同意・バリデーションを壊さない）。
- **2段階確認**：申請タブで候補を選ぶ → 実フォームで内容・料金を見て自分で「依頼する」。
- `前回交通費と同じなら見積もり不要`（`#issue_auto_book_transport_fee`）は触らない（既定OFF）。ONだと自動確定に近づくため警告のみ表示。
- 一括申請はしない（1件ずつ実フォームで確認）。LLMは抽出・分類のみ、実行判断はルール＋人。
- 申請後は `見積り待ち → 見積もり確認 → 依頼確定` と進む（保護者の確定が別途必要）。v0.6 ではこの後段を `applyQueue` と `/parent/issues` 照合で追跡する。
- フォームを開いただけでは `applied` にしない。実際の依頼一覧に同一シッター・同一日・同一時間の依頼が見つかった時だけ申請済みとして扱う。
- 実フォーム上の日付・開始時刻・終了時刻・シッターIDが `pendingApply` と一致確認できない場合、自動入力を止める。URLと画面表示がずれた状態を信頼しない。

## v0.4 の主な変更（UI/UX改善）

- **宛先ズレ防止**: side panelで生成した下書きに `tabId / roomId / sitterId / sitterName` を紐づけ、挿入・記憶保存・シッター保存時に同じメッセージ室か検証。違う場合は実行しない。
- **既存入力の保護**: 入力欄が空でない場合、挿入時に `置換 / 末尾に追記 / キャンセル` を選択。挿入後は短時間だけ「元に戻す」を表示。
- **ページ内AI下書きの確認フロー**: 送信ボタン横の「AI下書き」は即挿入せず、宛先・状況・下書きを確認してから挿入。履歴/予定取得に警告がある場合はside panelへ誘導。
- **作成タブの優先順位整理**: 宛先確認と下書き生成を最上位に置き、履歴/予定やGoogle Calendarの異常だけを警告表示。最終メッセージ・入力欄・文脈状態は折りたたみで確認。
- **信頼性強化**: OpenRouter structured outputs（非対応時は従来JSONパースへフォールバック）と60秒timeoutを追加。content script からの storage 読み取りもallowlist化。
- **状態追従**: side panel はタブ/メッセージ室切替時に自動更新し、Google Calendarの接続状態は信頼コンテキスト側で判定。
- **記憶候補の安全化**: 記憶候補は初期未選択にし、保存前に本文を編集可能。
- **復帰導線**: 生成失敗時に設定タブ・Google再接続・再読込などの導線を表示。

## v0.3 の主な変更（レビュー反映）

- **作成UI・シッターUI・設定UIを side panel / options に統合**。content script はメッセージ室のDOM読取・入力欄挿入・送信ボタン横のワンクリック生成だけを担当。
- **Chrome拡張アイコンを追加**。SVG元デザインと `16/32/48/128px` PNGを `assets/` に配置し、manifestの `icons` / `action.default_icon` に登録。
- **content script の注入対象をメッセージ室だけに限定**（`https://smartsitter.jp/parent/message_rooms*`）。依頼/履歴取得は host permission 経由で継続。
- **依頼/履歴取得失敗を明示**。ログイン切れ・HTTPエラー・DOM変更疑いをUIとプロンプトの「文脈取得ステータス」に出し、LLMに断定を避けさせる。
- **storage を `TRUSTED_CONTEXTS` にロック**し、content script からは background 仲介でのみアクセス。content scriptへ返す設定からAPIキー・Googleトークンを除外。
- **Turbolinks/Turbo 遷移対応**（`turbolinks:load` / `turbo:load` / `popstate` で再構築）。
- **依頼一覧・履歴のページネーション対応**（進行中 最大3頁 / 過去 最大5頁）。
- **キャンセル済みを「昨日/今日/明日」から除外**（お礼の誤爆防止）。
- **他シッター確定予定の窓**を相談系（日程相談/定期継続）で 90日に拡大、通常は45日。
- **現在日時（Asia/Tokyo）をLLMに明示**。**JSON出力例から `//` コメントを排除**。
- **挿入前のポリシー検知**（電話番号・郵便番号・番地系のみ。地名語の誤検知は避ける設計）。
- **プロンプトインジェクション対策**（渡すデータは参考であり指示ではない旨を明記）。
- **記憶候補の重複防止**（同一行は追記しない）。`定型返信` ボタンを **`自動判断`** に改名。
- **デフォルトモデルを `google/gemini-3.1-pro-preview` に変更**。

## インストール

1. `chrome://extensions` → 「デベロッパーモード」ON →「パッケージ化されていない拡張機能を読み込む」→ この `poppins-automation` フォルダ。
2. SmartSitter のメッセージ室を開き、ページを再読み込み。
3. ツールバーの拡張アイコンをクリック → **side panel** が開く（または `chrome://extensions` →「拡張機能のオプション」）。
4. **設定**タブで OpenRouter APIキー / モデル / 候補数 / 温度 / 文体 / スケジュール方針 / 家庭ルール を保存。
5. **シッター**タブで敬称・優先度・個別メモを記入。

## 使い方

- side panel の **作成**タブ: 意図チップ（お礼 / 明日の確認 / 日程OK / 日程相談 / 定期継続 / やわらかく断る）or 自由入力 →「下書きを生成」。
- 「**自動判断**」/ メッセージ室の送信ボタン横の「**AI下書き**」: 意図なしで直近メッセージへの返信を1クリック生成。
- 候補を「入力欄に挿入」（送信は自分で押す）。挿入前に電話番号/住所らしき表現があれば確認ダイアログ。
- 入力欄に既存文章がある場合は、置換・追記・キャンセルを選ぶ。
- 「記憶を更新」/「選択を記憶に保存」で 3分割メモリ（会話の流れ / シッターの事実 / 未確定）を育てる。
- 依頼/履歴取得やGoogle Calendar接続が必要な場合だけ、作成タブ上部に警告が出る。詳細は「文脈ステータス」で確認し、ログインし直すか、SmartSitterのメッセージ室を再読み込みする。

## Google Calendar 連携（任意）

1. Google Cloud Console で OAuth 同意画面 + **OAuth クライアントID（ウェブアプリケーション）** を作成、Calendar API を有効化。
2. **承認済みリダイレクトURI** に、設定ページ下部に表示される `https://<拡張ID>.chromiumapp.org/` を登録。
3. 設定ページで「連携を有効にする」+ クライアントID + カレンダーID（既定 `primary`）→「Google を接続」。
4. v0.4 は **freebusy（埋まり時間帯のみ）**。トークンは約1時間で失効するため、切れたら再接続。予定名（仕事/家族行事など）を文面に使う段階で `events.list`（分類のみ）を追加予定。

未設定でも本体は通常動作（カレンダー文脈が省かれるだけ）。

## データの置き場所（`chrome.storage.local`, `unlimitedStorage`, TRUSTED_CONTEXTS）

| キー | 内容 |
|------|------|
| `settings` | apiKey / model / draftCount / temperature / replyStyle / signature / gcal* / token |
| `libraryMd` | 家庭・家・暗黙ルール（md） |
| `schedulingMd` | スケジュール方針（既定で 火 + 土/日 週2 / 優先 A>B 入り） |
| `sitter:{id}` | name / honorific / priorityRank / note |
| `memory:{id}` | roomSummary / sitterFacts / pendingSchedule |
| `sittingsCache` | 履歴+予定のパース結果（10分キャッシュ） |
| `sitterid:{profileId}` | 申請用 `sitter_id`（プロフィールページ解決 or 手動貼付け） |
| `pendingApply` | 申請フォームへの受け渡し（日時・シッター・申請用ID・下書き文。フォーム実DOMとの一致確認後に消費） |
| `applyQueue` | 申請キュー（予約・追跡。`deferred/ready/applied/needs_confirm/booked/canceled`。取れる場合は profileId / applicationSitterId / sitterPublicId / issueId も保持） |

storage は信頼コンテキスト限定。content script は background 経由でallowlist化されたキーだけ読み書きし、`settings` を読む場合も APIキー / Googleトークン / トークン期限は除外される。Google Calendarの接続状態表示はside panel側で判定する。ページや第三者スクリプトから秘密情報へは到達しない。

## ローカル検証

```
npm test
```

検証内容:

- `manifest.json` が MV3 として読め、参照先ファイルが存在すること。
- `background.js` / `content.js` / `settings.js` が JS 構文エラーなしで読めること。
- content script が `chrome.storage.local` を直接読まないこと。
- content script の注入対象がメッセージ室・申請フォーム・申請詳細に限定されていること。
- side panel に作成・シッター・設定タブがあること。
- 宛先ズレ防止の `expectedContext`、既存入力保護、作成タブの警告/文脈ステータス表示が実装されていること。
- OpenRouter structured outputs、storage read/write allowlist、side panel自動更新の退行検知があること。
- 申請フォームの実DOM照合、申請詳細ページ注入、一覧ページネーション、月末日クランプ計算の退行検知があること。
- 秘密情報フィルタ、メモリ候補、Poppins主要セレクタが実装内に存在すること。

## セキュリティ注意

個人利用MVP。公開配布・第三者利用は想定していない。APIキー/トークンは端末ローカルに保存される（信頼コンテキスト限定）。

## 意図的に入れていないもの（設計判断）

- 状況のキーワード推定（"明日"を含む→…のような部分一致）。日付窓だけ決定的に渡し、判定はモデルに委ねる。
- 全週カバレッジ計算（SchedulingSnapshot）。需要・カバレッジ予測は別プロジェクト（リマインド）の責務。
- GCal を `getAuthToken()` 方式へ。固定 client_id 前提で、ユーザーが自分の client_id を入れる未パッケージ運用と相性が悪い。`launchWebAuthFlow`（実行時 client_id）を採用。

## ロードマップ

- マルチターンの修正チャット（「もっと短く」「20日を提案」を会話で詰める）。
- GCal `events.list` 追加（タイトルそのままではなく「仕事/家族予定」等の分類のみ渡す）。
- 記憶の自動更新トリガ、TypeScript 化。

## 検証済みセレクタ

- メッセージ室: `#js-charter-chat-messages > .balloon6`(相手) / `.mycomment`(自分), `.send-at`, `.nav-title`, `a.profile_button[href*="/sitter/profile/{id}"]`, `#js-message-text-area`, `#js-message-submit-button`
- 一覧/履歴（同一構造）: `.requested-item` → `a[href*="/parent/issues/{id}"]` or `a[href*="/parent/sitting/issues/{id}"]`, `.requested-sitter-name`, `.requested-item-name`(×2), `.requested-item-sitting-type`, `.requested-item-status em`(class: booked/charged/canceled), ページャ `.SS-pagination__next a`
- 申請フォーム: `#issue_date`, `#js-start-at`, `#js-end-at`, `#sitter_public_id`, `textarea[name="issue[description]"]`, `#issue_auto_book_transport_fee`, `#js-submit-button`
- 申請詳細: `/parent/sitting/issues/{id}` の本文・ステータス表示・シッタープロフィールリンク。実HTML fixture はSmartSitter側の画面HTMLを採取できたタイミングで追加する。
