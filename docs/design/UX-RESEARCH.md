# UX調査レポート: AI開発でのUX品質向上手法（2026-08-03）

調査: deep-research-tiered（5並列検索→ソース精読→クレーム単位の反証検証3票）+ Fable統合。
**検証済み（2/3以上が支持）のクレームのみを本文に採用**。反証されたクレーム・未検証の統計値は除外または注記済み。

対象: 本リポジトリ（ビルドレス・バニラJS+CesiumJS・PWA）の「動き・フィードバック / モバイル体感 / 操作動線」改善。

---

## 軸1: AIコーディングでデザイン/UX品質を上げるハーネス手法

### 確立されたパターン: 「規範ファイル + 目 + レビューコマンド」の3点セット

実践例（Playwright MCP + Claude Code のビジュアル開発ハーネス。[ap7i.com の実装記事](https://ap7i.com/posts/giving-claude-code-eyes-with-playwright-mcp/)で構成ファイルまで公開・検証済み）:

| ファイル | 役割 |
|---|---|
| `CLAUDE.md` | ビジュアル開発の基本指示（変更後は必ずスクショで自己確認等） |
| `context/design-principles.md` | 審美・UXの規範（AIが常時参照） |
| `context/style-guide.md` | デザイントークン定義 |
| `.claude/agents/design-reviewer.md` | レビュー専用サブエージェント |
| `.claude/commands/design-review.md` | スラッシュコマンド化されたクイックレビュー |

- Playwright MCP は Claude Code に約30ツール（ページ遷移・複数ビューポートのスクショ・コンソールログ・要素操作・**アクセシビリティスナップショット**）を与える（検証2-1）
- 別実践（[gaffer.sh](https://gaffer.sh/blog/playwright-mcp-claude-code-test-loop/)、検証2-0）は**スクショではなくアクセシビリティツリー（role/label構造）でAIに検証させる**方式を採用 — 視覚判定より決定的で高速。**本リポジトリはe2eハーネス（DOM直叩き+フック）が既に同型**なので、この流儀を踏襲するのが低コスト
- 参考リポジトリ:
  - [x1xhlol/system-prompts-and-models-of-ai-tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools) — v0/Lovable/Cursor等20超のAIツールの実システムプロンプト集（デザイン規範の書き方の実例集として有用。検証2-1）
  - [superdesigndev/superdesign](https://github.com/superdesigndev/superdesign) — IDE内オープンソースデザインエージェント。`system-prompt.txt` を常時参照規範として同梱、Cursor向け `design.mdc` にも言及（検証3-0）
  - [GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance) — **Chromeチーム公式のAIエージェント向けskillリポジトリ**。INP改善ガイド等をAIが参照できる形式で配布（検証3-0）

**本リポジトリへの適用**: `docs/design/DESIGN-GUIDELINES.md` を規範ファイルとして新設し、実装チケットの必読に組み込む（ap7i型の簡易版）。レビューは既存の capture-*-shots.mjs + a11yツリー/DOM検証の拡張で賄う（MCP追加は不要）。

## 軸2: ビルドレス・バニラJS向けの軽量UXパターン

1. **デザイントークン（CSSカスタムプロパティ）**: [Open Props](https://github.com/argyleink/open-props)（MIT）は色・影・**イージング・アニメーション**・z-index等のトークン集で、unpkg CDNからビルドなしで利用可能（検証3-0）。ただし本リポジトリはPWAのprecache・依存最小原則があるため、**必要トークン（duration/easing/spacing）のみを自前 `tokens.css` に移植**する方が整合的（出典コメント付き）
2. **View Transition API**: SPAのDOM状態遷移とMPA間ナビゲーションの両方でアニメーション遷移を提供（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API)、検証3-0）。⚠️「ラップするだけで使える」という単純化は反証済み（1-2）— ブラウザ対応・feature detection・reduced-motion連動が必要。本リポジトリではカード内容の差し替え等に**限定的・プログレッシブに**使う
3. **prefers-reduced-motion**: 全ての装飾的モーションを `@media (prefers-reduced-motion: reduce)` で一括無効化する設計を最初から入れる（トークン側で `--duration-*: 0ms` に落とす方式が保守簡単）
4. **スケルトン/進捗の型**: 診断カードの各セクションはすでに段階描画だが、「枠だけ先に出す」スケルトンで体感を上げる（CSSのみで実装可能。追加依存なし）

## 軸3: 地図・防災アプリのモバイルUXベンチマーク

（この軸は一次ソースの検証通過が少なかったため、公式規範ドキュメントの要点として記載）

- **ボトムシート**: Google Maps型の peek/half/full 3状態は本リポジトリで実装済み。差分は (a) **慣性スナップ**（速度で次状態を決める — 実装済みだが閾値調整余地） (b) **地図との連動**（シート高さに応じてカメラ注視点をオフセットし、対象地点がシートに隠れない） (c) シート内スクロールとドラッグの引き継ぎ
- **モーション規範**（[Material 3 Motion](https://m3.material.io/styles/motion/overview) / [Apple HIG Motion](https://developer.apple.com/design/human-interface-guidelines/motion)）: 標準トランジションは150〜300ms・強調でも500ms以内 / 画面内移動は減速系イージング / モーションは意味（因果・空間関係）を伝えるためだけに使う
- **タッチターゲット**: HIG 44×44pt / Material 48×48dp を最小に。ハンドル・閉じるボタン・ラジオ周りが対象
- **プログレッシブディスクロージャ**: 初期表示は最小限（診断カードの折りたたみ既定は実装済み）。左パネルの常時全開域を減らし「よく使う操作を1タップ目に」

## 軸4: 体感パフォーマンスの計測と検証

- **LoAF (Long Animation Frames) API**: メインスレッドの1フレーム作業が**50ms超**で「渋滞」と報告される確定的な閾値。従来のLong Tasks APIはrAFコールバック等の描画系作業を含まず不十分（いずれも[w3c/long-animation-frames](https://github.com/w3c/long-animation-frames)、検証3-0）
- **INPの3分解**: Input Delay / Processing Duration / Presentation Delay に分解して原因フェーズを特定する（Event Timing API。[GoogleChrome/modern-web-guidance の INPガイド](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/performance/identify-inp-causes.md)、検証3-0。web-vitals attribution版のコード例あり）
- **Cesium固有**: requestRenderMode でアイドルCPUが**25.1%→3.0%**（[Cesium公式](https://cesium.com/blog/2018/01/24/cesium-scene-rendering-performance/)、検証3-0）。R8aで軽量モードに導入済み — **電池・発熱面の体感に効くため、PC既定への拡大をR-UXで検討**（描画発火の網羅が前提）
- **AIレビューの回し方**: スクショ視覚判定より、a11yツリー/DOM+計測値（INP・LoAFカウント）をAIに渡す方が決定的（軸1と同結論）。⚠️「視覚テストでデバッグ時間60%削減」等の統計は検証不能のため採用しない

---

## 結論（DESIGN-GUIDELINES.md への反映事項）

1. 規範ファイル+レビュー動線のハーネス化（軸1） — 本リポジトリの既存ハーネスに乗せる簡易版で十分
2. トークン化されたモーション体系 + reduced-motion一括制御（軸2）
3. シート×地図連動・タッチターゲット・動線短縮の具体目標（軸3）
4. INP/LoAFの軽量自前計測をテストフックに常設し、改善を数値で確認（軸4）
