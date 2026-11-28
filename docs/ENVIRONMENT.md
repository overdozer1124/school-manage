# 環境変数の一覧

本番で使う環境変数の名前と意味の一覧です（Issue #132）。**値はここに書きません。** 実際の値は、サーバー上の `/etc/school-manage/platform.env` と `/etc/school-manage/schedule.env` にだけ置きます（置き方は [DEPLOY.md](DEPLOY.md)）。

「必須」の変数が未設定だと、そのサービスは起動を止めます（既定値で勝手に動くことはしません。Issue #5 の方針）。

## 共通

| 名前 | 必須 | 秘密 | 意味 |
|---|---|---|---|
| `NODE_ENV` | 本番では `production` を設定 | ― | `production` のとき、起動時にマイグレーションを流してから受け付けを始めます。 |

## platform（共通基盤）

| 名前 | 必須 | 秘密 | 意味 |
|---|---|---|---|
| `PLATFORM_DATABASE_URL` | 必須 | 秘密 | platform の DB への接続文字列。専用利用者 `platform_app` のものを使います（他の DB には接続できません）。 |
| `PLATFORM_PORT` | 任意（既定 3001） | ― | platform が受け付けるポート。 |
| `JWT_SECRET` | 必須 | 秘密 | ログインセッションの JWT の署名鍵。未設定だと起動しません。既定値はありません。 |
| `JWT_EXPIRES_IN` | 任意（既定 `7d`） | ― | セッションの有効期間。数値＋単位（`s`/`m`/`h`/`d`）で書きます。 |
| `GOOGLE_CLIENT_ID` | 任意 | ― | Google ログインのクライアント ID。`GOOGLE_CLIENT_SECRET` と組で設定します（片方だけはエラー）。 |
| `GOOGLE_CLIENT_SECRET` | 任意 | 秘密 | Google ログインのクライアントシークレット。 |
| `ALLOW_SUPERADMIN_GOOGLE_LOGIN` | 任意 | ― | `true`（または `1`）のとき、運営者（platform_admins）も Google ログインできます。未設定では運営者は Google ログインできません。 |
| `LOGIN_RATE_LIMIT_MAX_FAILURES` | 任意（既定 10） | ― | メールアドレスごとに許すパスワードログイン失敗の回数（これを超えると 429）。 |
| `LOGIN_RATE_LIMIT_WINDOW_SECONDS` | 任意（既定 900） | ― | 上の失敗回数を数える時間枠（秒）。 |
| `LOGIN_RATE_LIMIT_IP_MAX_FAILURES` | 任意（既定 100） | ― | 接続元ごとに許す失敗の回数。学校の NAT を考えてメールアドレスごとの制限より大きくしてあります。 |
| `TRUST_PROXY` | 任意 | ― | Express の `trust proxy` 設定（例：`loopback`）。nginx の後ろで動かすとき、接続元を正しく判定するために設定します。 |
| `PUBLIC_READ_SERVICE_TOKEN` | 任意 | 秘密 | 公開閲覧（Issue #82）の基盤側の認証情報。schedule 側の同名変数と**同じ値**にします。未設定だと公開閲覧の読み取りはすべて拒否されます。 |
| `CHANGES_SCHEDULE_SERVICE_TOKEN` | 任意 | 秘密 | 行事予定アプリが変更一覧を取りに来るときに提示する認証情報。行事予定アプリのサーバー側にも**同じ値**を設定します。 |
| `CHANGES_TIMETABLE_SERVICE_TOKEN` | 任意 | 秘密 | 時間割アプリ向けの同上の認証情報。時間割アプリのサーバー側にも同じ値を設定します。 |
| `WEBHOOK_SCHEDULE_URL` | 任意 | ― | 変更通知（webhook）の送り先（行事予定の受信窓口）。`WEBHOOK_SCHEDULE_SECRET` と組で設定します。受信側が無いアプリには設定しません。 |
| `WEBHOOK_SCHEDULE_SECRET` | 任意 | 秘密 | 行事予定向け webhook の署名鍵。受信側と**同じ値**にします。 |
| `WEBHOOK_TIMETABLE_URL` | 任意 | ― | 時間割向け webhook の送り先。`WEBHOOK_TIMETABLE_SECRET` と組で設定します。 |
| `WEBHOOK_TIMETABLE_SECRET` | 任意 | 秘密 | 時間割向け webhook の署名鍵。受信側と同じ値にします。 |
| `PLATFORM_DEV_AUTH` | 開発専用 | ― | `1` で開発用の認証アダプタを有効にします。**本番では絶対に設定しません。** |

## schedule（行事予定）

| 名前 | 必須 | 秘密 | 意味 |
|---|---|---|---|
| `SCHEDULE_DATABASE_URL` | 必須 | 秘密 | schedule の DB への接続文字列。専用利用者 `schedule_app` のものを使います（他の DB には接続できません）。 |
| `PLATFORM_BASE_URL` | 必須 | ― | platform のオリジン（末尾の `/` なし）。同一サーバー内では `http://127.0.0.1:3001` の形にします。未設定だと起動しません。 |
| `SCHEDULE_PORT` | 任意（既定 3002） | ― | schedule が受け付けるポート。 |
| `PUBLIC_READ_SERVICE_TOKEN` | 任意 | 秘密 | 公開閲覧で platform に提示する認証情報。platform 側と**同じ値**にします。 |
| `TRUST_PROXY` | 任意 | ― | Express の `trust proxy` 設定（例：`loopback`）。公開閲覧の接続元ごとの制限を正しく数えるために、nginx の後ろでは設定します。 |
| `PLATFORM_DEV_AUTH` | 開発専用 | ― | `1` で開発用の認証アダプタを有効にします。**本番では絶対に設定しません。** |

## ビルド時（schedule の画面）

| 名前 | 必須 | 秘密 | 意味 |
|---|---|---|---|
| `VITE_SCHEDULE_DEV_ADAPTER` | 開発専用 | ― | 開発用アダプタを画面に組み込むビルド変数。**本番のビルドでは絶対に設定しません**（開発用のデータが画面に出てしまいます）。 |
