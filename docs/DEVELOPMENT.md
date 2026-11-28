# 開発：共通基盤と行事予定を手元で一緒に動かす

Issue #129 でログイン画面（`platform/client/`）が入ったので、共通基盤と行事予定を手元で一緒に動かす手順をここにまとめる。最初の環境作り（`.env`、Docker の Postgres、`pnpm install`）はリポジトリ直下の README の「開発の始め方」のとおり。

## 動かし方

サーバーは2つとも開発モードで起動する。画面は、サーバーが配る形（本番と同じ経路）を確かめるためにビルドしてから使う。

```sh
# ログイン画面と行事予定の画面をビルドする（サーバーが dist を配る）
pnpm --filter @school-manage/platform build:client
pnpm --filter @school-manage/schedule build:client

# 共通基盤（http://localhost:3001、ログイン画面は /login）
pnpm --filter @school-manage/platform dev

# 行事予定（http://localhost:3002、画面は /{slug}/schedule/）
pnpm --filter @school-manage/schedule dev
```

ログイン画面だけを直すときは、Vite の開発サーバーでも開ける（API は 3001 の共通基盤へ中継される）。

```sh
pnpm --filter @school-manage/platform dev:client   # http://localhost:5174/login/
pnpm --filter @school-manage/schedule dev:client   # http://localhost:5173/（行事予定の画面）
```

学校と管理者がまだ無い DB では、先に運営者コマンドで最初の学校を作る（手順は [OPERATIONS.md](OPERATIONS.md)）。招待・承認は管理者の API（Issue #128）で行い、招待された人は `/login` から Google で初回ログインし、その流れの中でパスワードを設定する。

## 本番との違い（ポートが分かれていること）

本番は同じドメインをパスで分ける（DESIGN-INTEGRATION §8-3-1）ため、`/login` と `/{slug}/schedule/` が同じオリジンにあり、行事予定の画面で 401 になると戻り先付きで `/login` へ移り、ログインが終わると元の画面に戻る。

手元ではポートが 3001 と 3002 に分かれる。違いは次の2点だけ。

- セッションの Cookie はホストに対して発行され、ポートは区別しない。そのため `http://localhost:3001/login` でログインすれば、`http://localhost:3002/{slug}/schedule/` でもそのままログイン済みになる。
- 行事予定の画面で 401 になったときの遷移先は `http://localhost:3002/login` で、そこではログイン画面は配られていない。手元では先に 3001 の `/login` でログインしてから行事予定の画面を開くこと。戻り先付きの遷移そのものは、本番（同一オリジン）で効く。
