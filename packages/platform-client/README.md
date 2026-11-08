# @school-manage/platform-client

行事予定・時間割が、共通基盤のログイン（JWT）を検証して `AuthContext` を得るための部品（Issue #6、設計は `docs/DESIGN-AUTH-TENANCY.md` §4）。

## 使い方

```ts
import { createPlatformClient } from "@school-manage/platform-client";

const platform = createPlatformClient({
  platformBaseUrl: process.env.PLATFORM_BASE_URL,
  product: "schedule",
});

// リクエストごと：Cookie の JWT を共通基盤にそのまま渡し、所属・役割・
// 契約を問い合わせる。401 は未ログイン、403 は権限なし（AuthAccessError）。
const auth = await platform.verifyRequest(req);
```

製品の側は `JWT_SECRET` を持たない。署名の検証は共通基盤だけが行い、製品はトークンを検証せず、毎回共通基盤の応答で判断する（鍵が製品側から漏れてセッションを偽造される、という経路を作らないため）。

問い合わせ結果は既定で30秒キャッシュする（成功だけ。失敗はキャッシュしない）。

## 開発用アダプタ

共通基盤が手元に無くても開発・テストできるよう、固定の利用者と役割を返すアダプタがある。安全側に倒すため、明示の指定（`PLATFORM_DEV_AUTH=1`）があるときだけ読み込め、本番（`NODE_ENV=production`）では指定があっても例外を投げる。

```ts
// PLATFORM_DEV_AUTH=1 の環境でのみ読み込める
import { createDevAuthAdapter } from "@school-manage/platform-client/dev";

const adapter = createDevAuthAdapter({ role: "Editor" });
adapter.setContext({ schoolId: "school-b", role: "Viewer" });
const auth = await adapter.verifyRequest();
```

## secureAction

アクションは `secureAction({ permission, permissions, handler })`（権限の宣言が必須で、無いと型エラー）か `publicAction(handler)` で包み、`defineActions` に登録する。権限表（§4.4）の中身は行事予定の Issue で埋める。
