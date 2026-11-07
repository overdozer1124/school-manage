# 認可・テナント分離 設計案（レビュー指摘 M-1／M-5）

作成: 2026-11-06 / 改訂: 2026-11-07（判断事項 D-1〜D-7 を荒木の回答で確定。連携の決定で共通基盤の範囲が広がった：§7）/ 状態: 設計確定（未実装）
対象: 試作のレビュー対応記録（[school-schedule `docs/REVIEW-RESPONSE.md`](https://github.com/overdozer1124/school-schedule/blob/main/docs/REVIEW-RESPONSE.md)）の M-1（サーバー側の認証・認可・公開範囲フィルタ）と M-5（school_id／学校・年度テーブル）
前提とする正本: `docs/schedule/DESIGN.md` v0.6（§2 原則3・6、§4 冒頭、§4.1、§9、§10）
照合した school-timetable: `overdozer1124/school-timetable` の `2026-06-02-v5-only-branch`（ba73531）

---

## 0. 確定した判断（2026-11-07、荒木の回答）

| # | 判断事項 | 決定 |
|---|---|---|
| D-7 | school-timetable との関係 | **別アプリとして作り、同じ学校 ID で強く連携する**（§1.2） |
| D-1 | テナント分離の方式 | **行に school_id**。学校 ID の形式は school-timetable に合わせる（文字列＋slug） |
| D-1' | 学校・利用者・ログイン・契約の正本 | **共通基盤を切り出す**。時間割と行事予定の両方がそれを参照する |
| D-2 | ログイン方式 | **Google＋パスワード**（school-timetable の現状のまま）。所属は管理者が承認する |
| D-3 | 保護者・児童生徒への公開 | **公開 URL＋PDF 配布**。保護者・児童生徒にアカウントは配らない |
| D-4 | 役割 | **製品ごとに役割を持つ**。名前は両製品で Admin／Editor／Viewer に揃える |
| D-5 | 休暇の分類 | **管理者と本人だけに見せる** |
| D-6 | 一般教職員による出張・研修・休暇の入力 | **許す。ただし行事担当が確認する**（確認までは「仮」） |

荒木の回答（D-7、原文）：

> 私の最初の考えは時間割アプリで行事予定も使えたらいいのではないかという考えでした。おそらく時間割アプリに行事予定管理機能がついていると使い勝手が良くなるという人は多いと思います。しかし、行事予定管理アプリだけ必要という人からすると、それを使うためだけに親アプリである時間割アプリを使う人はいないのではないかと考えました。そのため、時間割アプリと行事予定管理アプリを独立させ、別々のアプリとして作るほうがいいのではないかと思いました。しかし、強力な連携機能は絶対に必要になります。例えば、行事予定で出張に登録した先生を時間割アプリにもリアルタイムに反映させたり、行事を時間割に反映させたりすることで時間割運用を効率化するなど連携することでこれまで別々に管理していた行事と時間割の一元化が可能になると考えているからです。この連携には同じ学校IDでの管理は絶対に必要だと考えています。

---

## 1. 前提

### 1.1 このリポジトリの現状（コードで確認）

| 項目 | 現状 |
|---|---|
| 実行基盤 | `@hatch/space-sdk` の `defineAction`。DB は `ctx.db()`（drizzle + libsql／SQLite）。`ctx` に利用者の情報は渡っていない |
| テナント | 無い。`settings` が `id=1` の1行だけの表で、学校名・年度（既定 2026）を持つ |
| 学校・年度テーブル | `schools`／`school_years`／`terms` は無い（DESIGN §4.1 にはある） |
| entitlement | `product_entitlements.school_name`（学校名の文字列）で学校を表している |
| 業務テーブル | 24個。どれも school_id を持たない |
| 利用者・権限 | 無い。全員が48個のアクションすべてで全件を読み書きできる |
| 公開範囲 | クライアント側だけ（試作の `client/src/audience.ts`）。当番パネルは絞り込み前のデータを受け取る（REVIEW-RESPONSE の申し送り） |

### 1.2 school-timetable（v5）の作り（照合結果）

| 項目 | school-timetable の作り | 根拠 |
|---|---|---|
| DB | Postgres（drizzle の `pgTable`） | `drizzle/src/schema.ts` |
| 学校 | `schools.school_id` は **text の主キー**。URL 用の `slug` を持つ（全校で一意） | `drizzle/src/schema.ts` 7–16行 |
| テナント分離 | 業務テーブルは `school_id` を持ち、主キーが (school_id, x_id) の複合キー。絞り込みは `withSchoolId()` | `drizzle/src/schema.ts`、`server/src/utils/tenantIsolation.ts` |
| 利用者 | `users` の主キーは (school_id, user_id)。学校ごとに1行で、`google_id`・`password_hash`・`teacher_id`（教員との紐付け）・`membership_approved_at`（所属承認） | `drizzle/src/schema.ts` 42–59行 |
| ログイン | Google OAuth とパスワード（bcrypt）、JWT。所属が未承認の JWT は無効 | `server/src/utils/auth.ts` |
| 役割 | SuperAdmin／Admin／Editor／Viewer。tRPC の `createRoleProcedure` で判定し、Viewer の変更操作は許可リスト方式 | `server/src/trpc.ts` |
| 公開閲覧 | `school_settings.public_view_token`（管理者が発行・無効化）。未ログインは `__public__` 利用者になり、**許可した query だけ**を通す（allowlist） | `server/src/index.ts`、`server/src/publicViewQueryPolicy.ts` |
| URL | `school-manage.jp/{slug}/timetable`。`/{slug}/schedule` を行事用に予約 | `docs/v5-planning/29-school-manage-url-routing-plan.md` |

**食い違いの整理**：school-timetable の `docs/event-management-system-design.md` は「行事管理は時間割と同じ SPA・同じ DB・同じ認証のサブアプリ」としている。D-7 の決定（別アプリ＋同じ学校 ID で連携）でこの案は採らないことになるので、同文書は「不採用（2026-11-07 の判断で置き換え）」と明記して更新する必要がある。school-timetable リポジトリの運用（CLAUDE.md）に従い、その更新は先方で Task として起票する。

---

## 2. 全体構成

```
school-manage.jp
 ├─ 共通基盤（新設）        … 学校・利用者・ログイン・所属承認・製品ごとの役割・契約・公開トークン
 │    ├─ /login, /{slug}/          ← 入口
 │    └─ 認証 API（JWT 発行・検証）
 ├─ 時間割  /{slug}/timetable  … 自前の DB（Postgres）。学校 ID と利用者は共通基盤を参照
 └─ 行事予定 /{slug}/schedule  … 自前の DB。学校 ID と利用者は共通基盤を参照
                                   ↕ 連携（同じ school_id・教員 ID で、出張・行事を時間割へ反映）
```

- **片方だけ契約した学校でも成り立つ**：共通基盤はどちらの製品にも属さない。行事予定だけの学校は「共通基盤＋行事予定」で動き、時間割のサーバーには依存しない（DESIGN §10.0・§10.1）。
- **共通基盤は school-timetable の既存部品から切り出す**：`schools`・`users`・ログイン（Google OAuth＋パスワード、JWT）・所属承認・公開トークンはすでに時間割側にあるので、作り直さずに移す。移す作業は時間割側の工程になる（§6）。
- **DB は製品ごとに分ける**：行事予定の業務データは行事予定の DB に置く。学校をまたいだ集計や契約は共通基盤の責務なので、各製品の DB は「1校の業務データ」だけに集中できる。

---

## 3. M-5：テナント分離（行事予定アプリ側）

### 3.1 school_id

- 全24業務テーブルに `school_id TEXT NOT NULL` を持たせる。値は**共通基盤の `schools.school_id` そのもの**で、時間割側と同じ値になる。連携はこの一致を前提にする。
- 行事予定の DB に `schools` の正本は置かない。表示用に学校名と slug をキャッシュする `school_cache`（school_id PK, name, slug, synced_at）だけを持つ。
- 子テーブル（`item_options`・`targets`・`event_assignees` など）にも `school_id` を持たせる。目的は2つある。
  - 「必ず school_id で絞る」を例外のない規則にする。
  - 親子が同じ学校であることを複合外部キーで保証する（§3.3②）。
- 主キーは、時間割に倣って (school_id, id) の複合にするか、現行の整数 id のまま UNIQUE(school_id, id) を足すかを実装で選ぶ。どちらでも §3.3 の守りは成り立つ。移行の手間が小さい後者を推奨する。

### 3.2 学校ごとの設定・年度

| テーブル | 主要カラム | 備考 |
|---|---|---|
| `school_settings` | school_id PK, preset_applied, leave_types_json, absence_categories_json, link_mode, *_source | 現在の `settings` の1行を置き換える。R-1(a)（不在種別を設定にする）もここに入れる |
| `school_years` | id, school_id, year, starts_on, ends_on, term_system, is_current | `settings.school_year`（既定 2026）を置き換える（N-3）。年度を時間割と共有するかは連携設計で決める（§7） |
| `terms` | id, school_id, school_year_id, name, starts_on, ends_on, sort | 長期休業の期間判定にも使える |

年度は業務データの各行には持たせない。どの年度かは日付と `school_years` から導ける。

一意制約は学校単位にする：`day_records` は UNIQUE(school_id, date)、`item_definitions` は UNIQUE(school_id, key)、`target_groups.key`・`period_patterns.code`・`view_definitions.name` も (school_id, …)、`item_options` は UNIQUE(item_definition_id, code)。

`product_entitlements` と `master_links` の扱い：
- `product_entitlements` は共通基盤へ移す。行事予定の DB からは削除する。
- `master_links` は行事予定側に残し、`school_id` を付ける。

### 3.3 書き忘れを防ぐ仕組み

SQLite には行単位のアクセス制御（RLS）が無い。そこで、正しく書くのが簡単で、誤って書くのが難しい形にする。

① **DB の入口を `tenantDb(auth)` に限定する**
- アクションのハンドラは `ctx.db()` を直接使わず、`secureAction`（§4.3）が渡す `tdb` だけを使う。
- `tdb` は select／update／delete に `school_id = auth.schoolId` を必ず付け、insert では `school_id` を自動で埋める。時間割の `withSchoolId()` と同じ考え方を、付け忘れられない形にしたもの。
- 生の DB 接続を使ってよいのは共通基盤との同期などを行う専用モジュールだけにし、リントで検査する。

② **学校をまたぐ参照を作れないようにする**
- 親テーブルに UNIQUE(school_id, id) を張る。子から FOREIGN KEY (school_id, parent_id) REFERENCES parent(school_id, id) で参照する。
- SQLite の外部キーが有効か（`PRAGMA foreign_keys`）は実行基盤次第なので、アプリ側でも確認する。リクエストに含まれる参照 ID（locationId、personId、targetIds、itemDefinitionId、dutyDefinitionId、assignmentId、viewDefinitionId など）が、その学校のものかを書き込み前に `assertOwned` で確かめる。

③ **テストで担保する**
- 分離テスト：2校分のデータを用意し、B校の利用者で全アクションを呼ぶ。A校の ID を指定した読み取り・更新・削除がすべて失敗することを確かめる。PR #1 の結合テスト（libsql の一時 DB＋マイグレーション）の仕組みを使い、CI で常に回す。

### 3.4 移行（SQLite）

> **2026-11-07 追記**：本実装は VPS 上の Postgres で作り直し、試作は凍結することになった（DESIGN-INTEGRATION §7-2・7-7）。そのため、以下の SQLite での段階移行は**行わない**。本実装の Postgres スキーマは、最初から school_id・複合外部キー・一意制約を持たせて作る。試作のデータを本番へ移す場合は、一度だけの移行スクリプトにする。§3.1〜3.3（school_id・tenantDb・assertOwned・分離テスト）の考え方はそのまま本実装に適用する。

試作のデータは、共通基盤に登録したときにその学校へ振られた school_id に寄せる。

1. `school_settings`・`school_years`・`terms`・`school_cache` を作り、`settings` の1行から作る。
2. 全業務テーブルに `school_id TEXT NOT NULL DEFAULT '<試作校の school_id>'` を ADD COLUMN する。
3. 一意制約と複合外部キーを張り替える。SQLite では制約を ALTER できないので、テーブルを作り直す。`PRAGMA foreign_key_check` で整合を確かめてから確定する。DEFAULT もここで外す。
4. `product_entitlements` を共通基盤へ移し、`settings` を削除する。

手順 1〜2 だけなら動作は変わらないので、認証より先に単独でリリースできる。

---

## 4. M-1：認証・認可

### 4.1 ログイン（共通基盤）

- 方式は **Google OAuth＋パスワード**、JWT、管理者による所属承認（school-timetable の現状のまま、D-2）。
- 行事予定アプリはログイン画面を持たない。共通基盤が発行した JWT を検証して、次の `AuthContext` を得る。

```ts
type AuthContext = {
  userId: string;            // 共通基盤の利用者 ID
  schoolId: string;          // 共通基盤の school_id（= 時間割と同じ値）
  role: "Admin" | "Editor" | "Viewer";  // 行事予定の役割（製品ごと、§4.2）
  isSuperAdmin: boolean;     // 運営（共通基盤の SuperAdmin）
  personId: number | null;   // 行事予定の people の行（「自分の出張・休暇」の判定用）
  teacherId: string | null;  // 共通基盤の教員 ID（時間割との連携用、§7）
};
```

- **ログイン手段の違いは「アダプタ」1か所に閉じ込める**。試作の Hatch ランタイムから本番の基盤に移るときも、アクション層には手を入れずに済む。
- 未ログインの公開閲覧は §4.5 の公開トークンで扱い、`AuthContext` とは別の型にする。こうしておくと、公開閲覧で書き込みのアクションを呼べないことを型で保証できる。

### 4.2 役割（製品ごと、D-4）

共通基盤の所属（学校×利用者）に、製品ごとの役割を持たせる。例：`product_roles`（school_id, user_id, product, role）。時間割では Editor でも、行事予定では Viewer、という持ち方ができる。

| 行事予定の role | 中身 | できること |
|---|---|---|
| `Admin` 管理者 | DESIGN §9 の「管理者」 | すべて。定義（項目・対象軸・当番定義・日課・ビュー）、マスタ、プリセット、テンプレート、連携設定、公開トークンの発行・無効化、休暇分類の閲覧 |
| `Editor` 行事担当 | 「行事担当」 | 予定・日次値・日レコード・当番割当・交代・見送り・輪番・CSV 取込・発行・印刷。**教職員が登録した「仮」の出張・研修・休暇の確認（確定）** |
| `Viewer` 一般教職員 | 「一般教職員」 | 職員用の閲覧。**自分が担当者の出張・研修・休暇の登録・編集（「仮」として入る）**。自分の当番の交代の申し出 |
| SuperAdmin | 運営（共通基盤） | 契約（entitlement）の管理。学校の役割としては扱わない |

保護者・児童生徒は利用者として登録しない（D-3）。公開は §4.5 で扱う。

### 4.3 アクション層での強制

- 全アクションを `secureAction({ permission, request, response, handler })` で包む。`Actions` の型を `Record<string, SecureAction | PublicAction>` にして、どちらも通っていないアクションは型エラーになるようにする。
- `secureAction` の処理順：
  1. JWT を検証して `AuthContext` を得る（無ければ 401）。
  2. 所属の承認と、行事予定の契約が有効かを確かめる（無効なら 403）。
  3. `permission` を役割と照合する（足りなければ 403）。
  4. `tenantDb(auth)` を作り、ハンドラを呼ぶ。
- 「自分の出張だけ」のような行単位の判定は、`canEditEvent(auth, event)` のような純粋関数にして、単体テストを付ける。

### 4.4 アクションと必要な権限（現行の48アクション）

| 権限 | 対象アクション | Admin | Editor | Viewer |
|---|---|---|---|---|
| `view.read` | getBootstrap, getRange, getSummary | ○ | ○ | ○ |
| `event.write` | createEvent, updateEvent, deleteEvent, moveEvent | ○ | ○ | △自分が担当者の出張・研修・休暇だけ。登録は「仮」になる |
| `event.confirm`（新設） | 仮の予定の確定 | ○ | ○ | － |
| `daily.write` | setDailyValue, moveDailyValues, setDayRecord | ○ | ○ | － |
| `duty.write` | setDutyAssignment, previewRotation, applyRotation, applyDutyChange, waiveConflict | ○ | ○ | △自分の割当の交代の申し出だけ |
| `import.events` | importEvents | ○ | ○ | － |
| `publish` | createPublication, updatePublication, deletePublication | ○ | ○ | － |
| `view.layout` | setViewColumnWidths | ○ | ○ | －（列幅はビューの共有設定なので。個人ごとの幅にするなら別の扱い） |
| `master.write` | upsert／delete の Person, Location, Holiday | ○ | ○（場所・祝日） | － |
| `definition.write` | upsert／delete の ItemDefinition, TargetGroup, Target, PeriodPattern, DutyDefinition, View | ○ | － | － |
| `school.admin` | saveSettings, saveLeaveTypes, applyPreset, exportTemplate, importTemplate, saveLinkSettings, upsert／deleteMasterLink、公開トークンの発行・無効化 | ○ | － | － |
| （共通基盤へ移す） | upsertEntitlement, deleteEntitlement | 学校の Admin でも不可。運営（SuperAdmin）だけ | | |

### 4.5 公開範囲のサーバー側フィルタと公開 URL（M-1 の中心、D-3）

**ログインした職員**
- `getRange({ from, to, viewId })` では、サーバー側で実効ランクを計算する：`max(0, ビューの audience のランク)`。職員が生徒用ビューで「生徒にどう見えるか」を確かめられる。
- 試作の `client/src/audience.ts` の純粋関数を共有パッケージに移し、サーバーとクライアントの両方から使う。

**休暇の分類（D-5）**
- `leave_type` は、Admin と取得者本人（`event_assignees.person_id = auth.personId`）にだけ返す。
- それ以外の職員には `null` を返し、画面には「休暇」とだけ出す。休暇を取ること自体と取得者名は、当番の競合検出に要るので職員には返す。
- 集計・CSV 書き出し・テンプレートにも同じ規則を当てる。

**未ログインの公開閲覧（保護者・児童生徒・地域）**
- school-timetable の仕組み（`public_view_token`＋allowlist）に揃える。ただし行事予定では、**トークンを学校単位ではなくビュー単位にする**。生徒用・保護者用でトークンを分け、片方だけ無効化できるようにする。
  - `public_view_tokens`（school_id, view_definition_id, token_hash, created_by, created_at, revoked_at）。トークンはハッシュだけを保存し、Admin が発行・無効化する。
  - 発行できるのは audience が guardian／student／public のビューだけ。職員用ビューには発行できない。
- 公開閲覧で呼べるのは `PublicAction` として宣言した読み取りだけ（allowlist）。中身は次のとおり。
  - `getPublicRange`：トークンのビューの audience で絞った予定と、列に出る項目の日次値。当番・人名・担当者名・休暇は返さない。
  - `getPublicBootstrap`：学校名、ビュー定義、列に出る項目と対象軸、祝日だけ。
- **PDF 配布**：発行版（publications）と紐付けて保持する（R-5）。公開 URL は最新の内容、PDF は配った時点の版という役割分担にする。

**職員以外に返さないもの**
- 人の一覧、当番定義と輪番、当番割当・競合・交代履歴、場所マスタ、名寄せ、発行履歴の管理情報、テンプレート。
- これでレビュー後の申し送りにあった当番パネルの未フィルタ経路も塞がる。

クライアント側の `audience.ts` による絞り込みは、表示の整合のために残す。ただし守りはサーバー側だけが担う。

### 4.6 一般教職員の入力と確認（D-6）

- Viewer が登録した出張・研修・休暇は `certainty = "tentative"`（仮）で保存し、`created_by` を記録する。Viewer が自分で「確定」にはできない。
- Editor／Admin が確認すると `confirmed` になり、`confirmed_by`・`confirmed_at` を記録する。確定済みの予定を Viewer が編集すると、再び仮に戻る。
- **当番の競合検出は仮の予定も対象にする**。仮であることを表示して、交代の手配を早めに促す。
- **時間割への反映（§7）は確定した予定だけ**にする。誤登録がそのまま時間割を動かさないようにするため。
- 行事担当向けに「確認待ちの一覧」を出す。承認ワークフロー（差し戻し・コメント往復など）は DESIGN §1.4 の非目的なので作らない。確認か削除かの二択にとどめる。

### 4.7 監査・記録

- `events`・`daily_values`・`duty_assignments`：`created_by`・`updated_by`・`updated_at`。`events` には `confirmed_by`・`confirmed_at` も持たせる。
- `duty_changes`：`requested_by`・`approved_by`。from／to は person_id で持ち、`status`（proposed／applied／declined）を実際に使う（R-4）。
- `duty_conflict_waivers`：`waived_by`（R-1(e)）。
- 公開トークンの発行・無効化、役割の変更、テンプレートの取込、プリセットの適用は `audit_log` に残す。

### 4.8 通信面

- JWT の受け渡しは共通基盤の方式に合わせる。Cookie なら `HttpOnly; Secure; SameSite=Lax` にし、POST には Origin ヘッダーを検査する。
- 401 と 403 はクライアントで区別して扱う。401 は共通基盤のログインへ、403 は「権限がありません」と表示する。

---

## 5. 実施順序（行事予定アプリ側）

| 段階 | 内容 | 完了条件 |
|---|---|---|
| 1 | （本実装では Postgres スキーマを最初からこの形で作る。下の段階分けは試作を育てる場合のもの）§3.4 の手順 1〜2（学校ごとの設定・年度、school_id 列）と、全アクションの `tenantDb` 化（学校は1つで固定） | 既存の結合テストが通る。`ctx.db(` が platform 以外に残っていない |
| 2 | §3.4 の手順 3〜4（制約の張り替え、`assertOwned`） | 2校分のデータで分離テストが全アクションで通る |
| 3 | 認証アダプタ（共通基盤の JWT の検証）、`secureAction` と権限表（§4.4）、仮の予定と確認（§4.6） | 未ログインは 401、権限不足は 403。全アクション×全役割のテストが通る |
| 4 | サーバー側の公開範囲フィルタ、休暇分類の秘匿、公開トークン（§4.5） | Viewer や公開トークンで API を直接呼んでも、許されないデータが返らない |
| 5 | 監査列（§4.7）、PDF スナップショット（R-5） | — |

**段階 3 は共通基盤の完成待ちになる。** それまでは開発用アダプタ（固定の利用者と役割を返す。本番では起動しない）で段階 3〜4 を作り込み、テストできる。

---

## 6. 共通基盤の切り出し（school-timetable 側との調整事項）

共通基盤は両製品にまたがるので、このリポジトリだけでは完結しない。以下は school-timetable 側の Task として起票・設計する必要がある（school-timetable の運用では、設計は Codex／Muse が Builder・Architect、Claude が起票とレビュー）。

1. **切り出す範囲**：`schools`（school_id・slug・name）、`users` とログイン（Google OAuth・パスワード・JWT）、所属承認、製品ごとの役割（`product_roles`）、契約（`product_entitlements`）、教員 ID（`teacher_id`）と利用者の紐付け。
2. **利用者の主キー**（→ 2026-11-07 確定：「人」と「所属」に分ける。DESIGN-INTEGRATION §8-2-1）：時間割の `users` は (school_id, user_id) で、学校ごとに別の行になっている。共通基盤で「1人が複数校に所属する」を扱うかどうかで、`users`（人）と `memberships`（所属）に分けるかが決まる。分けない場合は、現行の作りのまま共通基盤へ移す。
3. **役割の移行**：時間割の現在の `users.role` を、`product_roles` の timetable 行へ移す。
4. **公開トークン**：時間割の `school_settings.public_view_token` は時間割の責務のまま残す。仕組み（ハッシュ保存・allowlist）だけを揃える。
5. **`docs/event-management-system-design.md` の扱い**：「同じ SPA・同じ DB のサブアプリ」案は不採用と明記する（§1.2）。

---

## 7. 連携（出張・行事を時間割へ）

→ `docs/DESIGN-INTEGRATION.md`（2026-11-07 確定）。学校暦（日の種別と日課・行事と影響範囲・教職員の不在）と共通マスタ（教職員・学年クラス・時限）は、契約と無関係に**共通基盤**に置くことになった。そのため、本書 §3 の対象テーブルのうち `events`・`event_assignees`・`event_targets`・`day_records`・`holidays`・`people`・`period_*`、学年・クラスの `targets` は行事予定の DB から共通基盤へ移る。§4.5 の公開範囲の規則は、共通基盤の API にも実装する（DESIGN-INTEGRATION §6）。

---

## 8. この案で解消する／しないレビュー指摘

- **解消**：M-1、M-5、R-1(a)（不在種別を school_settings に持たせる）、R-1(e) の waived_by、R-4 の requested_by／status、N-3（年度のハードコード）、REVIEW-RESPONSE の申し送り（当番パネルの未フィルタ経路）。
- **一部**：R-5。PDF を発行版に紐付けるところまでは本案に含めた。スナップショットの中身は R-5 側で決める。
- **対象外**：R-6、R-7、N-2、N-4。ただし段階 2 でテーブルを作り直すので、これらのスキーマ変更を同じ作り直しに相乗りさせると、移行が1回で済む。
