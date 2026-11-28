# 初回の配備の手順（運営者向け）

共通基盤（platform）と行事予定（schedule）を、本番の VPS に初めて置くまでの手順です（Issue #132）。
前提は DESIGN-INTEGRATION §8.3 のとおりで、置き場所は**時間割と同じ VPS**、ドメインは `school-manage.jp` です。

- **本番サーバーでの作業は荒木が行います。** この手順書はその作業のためのものです。
- 常駐のさせ方は時間割の本番にそろえました：**PM2** でプロセスを常駐させ、環境変数の正本は**リポジトリの外**（`/etc/school-manage/`）に置きます（時間割は `/etc/school-timetable/` に正本を置く運用です）。
- ここでは nginx の設定はしません（Issue #133）。バックアップは Issue #134、監視は Issue #135 です。時間割の本番の設定は変えません。

## 全体の流れ

1. DB と接続用の利用者を作る
2. コードを置いてビルドする
3. 環境変数を `/etc/school-manage/` に置く
4. PM2 で起動する（起動時にマイグレーションが自動で流れる）
5. `/healthz` で確認する
6. 最初の学校を作る（Issue #127 のコマンド）

## 1. DB と利用者の作成

Postgres は時間割と**同じサーバー**を使い、DB を分けて作ります（8-3-2：platform／schedule／timetable の3つ）。接続用の利用者も DB ごとに分け、他の DB には接続できないようにします。

Postgres の管理者で接続し、次を実行します（パスワードはその場で決めた強いものに置き換え、ここには書き残しません）。

```sql
CREATE ROLE platform_app LOGIN PASSWORD '<platform 用の強いパスワード>';
CREATE ROLE schedule_app LOGIN PASSWORD '<schedule 用の強いパスワード>';
CREATE DATABASE platform OWNER platform_app;
CREATE DATABASE schedule OWNER schedule_app;
REVOKE CONNECT ON DATABASE platform FROM PUBLIC;
REVOKE CONNECT ON DATABASE schedule FROM PUBLIC;
GRANT CONNECT ON DATABASE platform TO platform_app;
GRANT CONNECT ON DATABASE schedule TO schedule_app;
```

（開発・検証用の Docker では、同じ内容を `docker/postgres/init.sh` が自動で行います。）

### 他の DB を読めないことの確認

schedule の利用者で platform の DB に接続を試みます。**拒否されるのが正しい結果**です（platform の利用者で schedule を試す場合も同じです）。

```sh
psql "postgresql://schedule_app@127.0.0.1:5432/platform" -c "select 1"
# → FATAL: permission denied for database "platform" と出れば、分離できています
```

権限の一覧は管理者で次でも確認できます。

```sql
SELECT datname, datacl FROM pg_database WHERE datname IN ('platform', 'schedule');
```

## 2. コードの配置とビルド

配置先は時間割と並べて `/opt/school-manage` とします。

```sh
cd /opt
git clone https://github.com/overdozer1124/school-manage.git
cd school-manage
pnpm install --frozen-lockfile
pnpm build
```

- `pnpm build` は、platform と schedule のサーバー（`dist/`）と、schedule の画面（`schedule/client/dist/`）をまとめてビルドします。platform の画面はまだ無いので、その分は自動で飛ばされます（画面ができたら同じコマンドでビルドされます）。
- メモリの小さい VPS でビルドが止まる場合は、時間割の手順と同じく `export NODE_OPTIONS="--max-old-space-size=2048"` を付けてから再実行してください。
- 作業ユーザーのそろえ方：初回の配置はこの手順のとおり root で行い、4 で配置先の所有者を専用ユーザー `school-manage` に変えます。**2回目以降の更新（7）は、配置からビルドまで `school-manage` ユーザーで行ってください**（`sudo -u school-manage -H` を付けます）。root のまま更新すると、ファイルの所有者が混ざって PM2 側から読み書きできないファイルができます。

## 3. 環境変数の置き場所

環境変数の正本はリポジトリの外に、サービスごとに1ファイル置きます（時間割が `/etc/school-timetable/` に正本を置く運用に合わせた形です）。

```sh
sudo mkdir -p /etc/school-manage
sudo nano /etc/school-manage/platform.env   # platform 用の変数を書く
sudo nano /etc/school-manage/schedule.env   # schedule 用の変数を書く
sudo chmod 600 /etc/school-manage/platform.env /etc/school-manage/schedule.env
```

- 変数の一覧と意味は [ENVIRONMENT.md](ENVIRONMENT.md) を見てください。**値はリポジトリやチャットに書かないでください。**
- 秘密の値は、その場で生成します。例：`openssl rand -base64 32`（`JWT_SECRET` 用）。
- 接続文字列は、1で作った利用者と DB の組み合わせになります（`PLATFORM_DATABASE_URL` は `platform_app` で `platform` へ、`SCHEDULE_DATABASE_URL` は `schedule_app` で `schedule` へ）。
- `PUBLIC_READ_SERVICE_TOKEN` は、platform と schedule の両方のファイルに**同じ値**を書きます。
- `PLATFORM_DEV_AUTH` と `VITE_SCHEDULE_DEV_ADAPTER` は開発専用です。本番のファイルには書かないでください。

## 4. 起動（PM2）

時間割と同じく PM2 で常駐させます。運用は root ではなく専用ユーザーで行います。

```sh
# 初回だけ：専用ユーザーと配置先の所有者
sudo adduser --disabled-password --gecos "" school-manage
sudo chown -R school-manage:school-manage /opt/school-manage

# PM2 の導入（未導入の場合）
sudo npm install -g pm2

# 起動（school-manage ユーザーで）
sudo -u school-manage -H pm2 start /opt/school-manage/deploy/ecosystem.config.cjs
sudo -u school-manage -H pm2 save

# 再起動後も自動で立ち上がるようにする（表示されたコマンドを root で1回実行）
env PATH=$PATH pm2 startup systemd -u school-manage --hp /home/school-manage
```

- `deploy/ecosystem.config.cjs` が、platform と schedule の2プロセスの定義です。環境変数は3のファイルを PM2 が読みます（`env_file`）。
- **起動時にマイグレーションが自動で流れます**（`NODE_ENV=production` のとき、受け付けを始める前に未適用分を適用します）。手で流す場合は、先に環境変数を読み込んでから `pnpm --filter @school-manage/platform db:migrate` と `pnpm --filter @school-manage/schedule db:migrate` を実行してください。
- 2回目以降の起動では、マイグレーションの記録用の表がすでにあるため、ログに `relation "__drizzle_migrations" already exists, skipping` という NOTICE が出ることがあります。害はありません（「記録用の表は作成済みなので飛ばした」という意味です）。
- 必須の環境変数が足りないと、プロセスは起動を止めてエラーを出します（既定値で動き続けることはしません）。`pm2 logs` で理由を確認してください。

## 5. /healthz の確認

VPS の中で、両方のサービスが答えることを確認します。

```sh
curl -s http://127.0.0.1:3001/healthz   # platform → {"status":"ok"} が返ればよい
curl -s http://127.0.0.1:3002/healthz   # schedule → {"status":"ok"} が返ればよい
```

どちらも HTTP 200 で `{"status":"ok"}` が返れば、起動はできています。ドメイン経由の確認は nginx（Issue #133）の後に行います。

### 外から直接届かないことの確認

本番では、両サービスは `127.0.0.1` でだけ待ち受けます（nginx と同じサーバー内からしか届かない形です）。VPS のファイアウォールが 3001・3002 を開けていても、nginx と TLS を通さずに外から直接届くことはありません。待ち受けているアドレスを確認してください。

```sh
ss -ltnp | grep -E ':(3001|3002)'
# → 127.0.0.1:3001 / 127.0.0.1:3002 のように出ればよい
```

`0.0.0.0:3001` のように出た場合は全アドレスで待ち受けているので、`/etc/school-manage/` の env ファイルに `PLATFORM_HOST` / `SCHEDULE_HOST` の指定が無いか（あれば外すか `127.0.0.1` にする）、`NODE_ENV=production` で起動しているかを確認してください。

## 6. 最初の学校を作る

platform の環境変数を読み込んでから、Issue #127 のコマンドを実行します（詳しい意味は [OPERATIONS.md](OPERATIONS.md)）。

```sh
cd /opt/school-manage
set -a; . /etc/school-manage/platform.env; set +a
pnpm --filter @school-manage/platform setup:school:prod \
  --slug <学校の slug> \
  --name <学校名> \
  --admin-email <管理者のメールアドレス> \
  --admin-name <管理者の名前>
```

- `setup:school:prod` は、ビルド済みの `dist/` を使う本番用です（開発用の `setup:school` と同じ動きで、マイグレーションも自動で適用されます）。
- パスワードは発行されません。管理者は登録したメールアドレスの Google アカウントでログインします。
- 運営者（platform_admins）を追加するときは `setup:platform-admin:prod` を同じ形で使います。

## 7. 更新の手順（2回目以降）

配置からビルドまでは、ファイルの所有者をそろえるため `school-manage` ユーザーで行います（2 の注意も見てください）。

```sh
sudo -u school-manage -H git -C /opt/school-manage pull
sudo -u school-manage -H bash -c 'cd /opt/school-manage && pnpm install --frozen-lockfile && pnpm build'
sudo -u school-manage -H pm2 restart school-manage-platform school-manage-schedule
curl -s http://127.0.0.1:3001/healthz
curl -s http://127.0.0.1:3002/healthz
```

再起動時にもマイグレーションは自動で適用されます。
