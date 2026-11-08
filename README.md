# school-manage

school-manage.jp の製品群のリポジトリです。

- `platform/` — 共通基盤（学校・利用者・ログイン・役割・契約・学校暦・共通マスタ）
- `schedule/` — 行事予定アプリの本実装
- `packages/calendar-types/` — 学校暦・共通マスタ・変更イベントの型の共有パッケージ

時間割アプリは別リポジトリ（overdozer1124/school-timetable）です。

設計の正本は `docs/` です（目次：[docs/README.md](docs/README.md)）。作業の流れは [docs/WORKFLOW.md](docs/WORKFLOW.md)。

## 開発の始め方

必要なもの：Node.js 22 LTS、pnpm（`corepack enable` で `packageManager` の指定どおりに入ります）、Docker（開発用 Postgres 用）。

```sh
cp .env.example .env   # ローカル専用のパスワードと接続文字列を設定する（.env はコミットされません）
docker compose up -d   # Postgres 16。platform / schedule の2つの DB と、DB ごとの接続用利用者が作られます
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

共通基盤のサーバーを起動するには：

```sh
pnpm --filter @school-manage/platform dev
curl http://localhost:3001/healthz   # {"status":"ok"}
```

DB の結合テスト（`platform/tests/db.integration.test.ts`）は、`PLATFORM_DATABASE_URL` が設定されているときだけ実行されます。CI では Postgres をサービスとして起動し、同じ初期化スクリプト（`docker/postgres/init.sh`）で DB と利用者を作ってから、型チェック・lint・テストを回します。
