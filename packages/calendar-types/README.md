# @school-manage/calendar-types

学校暦・共通マスタ・変更イベントの型と検証（zod スキーマ＋導出 TypeScript 型）を、
共通基盤・行事予定・時間割の3サービスで共有するパッケージです。
根拠：`docs/DESIGN-INTEGRATION.md` §2・§7.1・§8.1。

- zod は peerDependency です（`^3.23.0 || ^4.0.0`）。zod 3 と 4 の両方にある
  API だけを使っており、CI で両方の版でテストします。
- 時刻は入力した形のまま保持し（`CalendarTime`）、時限はその日の日課から
  `calendarTimeToPeriods` で導きます。
- 休暇の細分は `absencePublicSchema` で落とせます（時間割へは分類を渡さない）。
