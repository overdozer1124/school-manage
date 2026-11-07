# 設計文書

| 文書 | 内容 |
|---|---|
| [DESIGN-AUTH-TENANCY.md](DESIGN-AUTH-TENANCY.md) | 認証・認可・テナント分離（判断 D-1〜D-7） |
| [DESIGN-INTEGRATION.md](DESIGN-INTEGRATION.md) | 共通基盤の学校暦・共通マスタと時間割との連携、実装の土台、作業の進め方（連携1〜7、§7〜§9） |
| [schedule/DESIGN.md](schedule/DESIGN.md) | 行事予定アプリの DB・カスタマイズ設計（定義駆動モデル、v0.6） |
| [HANDOFF-2026-11-07.md](HANDOFF-2026-11-07.md) | セッションの引き継ぎ（開いている PR・Issue、未起票の作業、確認事項） |
| [WORKFLOW.md](WORKFLOW.md) | Issue と PR による作業の流れ（Builder＝Muse、起票とレビュー＝Claude、連絡＝swarmchat） |

これらは overdozer1124/school-schedule から移したもので、2026-11-07 以降はこちらが正本です。試作のコードと、試作のレビュー対応記録（REVIEW-RESPONSE.md）は school-schedule に残っています。

食い違いがあれば、日付の新しい決定を優先します。DESIGN-INTEGRATION.md の決定は、schedule/DESIGN.md の古い記述（例：§10.2 の「二つのモード」）より優先します。
