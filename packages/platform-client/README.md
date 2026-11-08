# @school-manage/platform-client

行事予定・時間割が、共通基盤のログイン（JWT）を検証して `AuthContext` を得るための部品（Issue #6、設計は `docs/DESIGN-AUTH-TENANCY.md` §4）。

## 使い方

```ts
import { createPlatformClient } from "@school-manage/platform-client";

const platform = createPlatformClient({
  platformBaseUrl: process.env.PLATFORM_BASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  product: "schedule",
});

// リクエストごと：Cookie の JWT を検証し、共通基盤に所属・役割・契約を
// 問い合わせる。401 は未ログイン、403 は権限なし（AuthAccessError）。
const auth = await platform.verifyRequest(req);
```

問い合わせ結果は既定で30秒キャッシュする（成功だけ。失敗はキャッシュしない）。

## 開発用アダプタ

共通基盤が手元に無くても開発・テストできるよう、固定の利用者と役割を返すアダプタがある。本番（`NODE_ENV=production`）で読み込むと例外を投げる。

```ts
import { createDevAuthAdapter } from "@school-manage/platform-client/dev";

const adapter = createDevAuthAdapter({ role: "Editor" });
adapter.setContext({ schoolId: "school-b", role: "Viewer" });
const auth = await adapter.verifyRequest();
```

## secureAction

アクションは `secureAction({ permission, permissions, handler })`（権限の宣言が必須で、無いと型エラー）か `publicAction(handler)` で包み、`defineActions` に登録する。権限表（§4.4）の中身は行事予定の Issue で埋める。
