---
name: Editor cells install
overview: 括弧の自動補完（軽量）、複数セルUI、および `install.packages` が使いにくい原因（stderr捨て・CRANミラー）への対処を段階的に実装する。
todos:
  - id: stderr-repos
    content: "r_session.rs: stderr をパイプで収集し返却に含める。source 前ラッパーで options(repos=...) を設定"
    status: pending
  - id: multi-cell-ui
    content: "main.ts: セル配列・追加ボタン・各セル実行・Shift+Enter で次セル。style.css でレイアウト"
    status: pending
  - id: auto-brackets
    content: textarea（各セル）に括弧・引用符の自動閉じロジックを追加（小さなモジュール化可）
    status: pending
  - id: optional-codemirror
    content: （任意）CodeMirror 6 へ差し替え、closeBrackets と将来の R 補完の土台
    status: pending
isProject: false
---

# 括弧補完・複数セル・install 対応プラン

## 現状の整理

- UI は [c:\Users\shunk\Desktop\R\src\main.ts](c:\Users\shunk\Desktop\R\src\main.ts) の **単一 `<textarea>`** 固定HTML。セル追加の仕組みがない。
- エディタはプレーン textarea のため、**括弧の自動閉じ**も **R の予測補完**も未実装。
- R 実行は [c:\Users\shunk\Desktop\R\src-tauri\src\r_session.rs](c:\Users\shunk\Desktop\R\src-tauri\src\r_session.rs) の永続プロセス＋`source()`。ここで **`.stderr(Stdio::null())`** となっており、`install.packages` の進捗・警告・一部エラーが **一切ユーザーに届かない**。
- `install.packages()` は **CRAN ミラー未設定**の環境だと対話プロンプト待ちになり、パイプ stdin では **固まったように見える**ことがある。

```mermaid
flowchart LR
  UI[main.ts textarea]
  IPC[invoke r_execute]
  RS[r_session.rs]
  RProc[R.exe persistent]
  UI --> IPC --> RS --> RProc
```

## 1. 「( を入れたら )」のような機能

**可能**。レベルは2段階ある。

| レベル | 内容 | 工数 |
|--------|------|------|
| A. 括弧・引用符の自動閉じ | `(`→`)`、`[`→`]`、`{`→`}`、`"`→`"` など。カーソルを中に入れる／直後の閉じ括弧は「飛ばす」(overwrite) 程度。textarea 上の `beforeinput` / `keydown` で実装可。 | 小 |
| B. R の「予測」（補完リスト） | 関数名・引数名の候補。プレーン textarea では厳しい。**CodeMirror 6**（プラン [local_r_notebook_lab_5d91cf15.plan.md](c:\Users\shunk\Desktop\R\local_r_notebook_lab_5d91cf15.plan.md) でも言及）＋言語サポート（`@codemirror/lang-r` または最小の独自補完）が現実的。 | 中〜大 |

**提案**: まず **レベル A** を [main.ts](c:\Users\shunk\Desktop\R\src\main.ts)（またはセル用に切り出した小さな `editor.ts`）に入れる。必要なら次スプリントで **CodeMirror + closeBrackets + 最低限の補完** に置き換え。

## 2. セルを複数にする（追加ボタン）

**可能**。単一セルをやめ、**セル配列を JS で管理**する。

- ヘッダー付近に **「セルを追加」** ボタン（任意で「下に追加」）。
- 各セル: ツールバー（`In [n]`、実行）、textarea、出力 `<pre>`。
- **Shift+Enter**: フォーカス中のセルを実行し、**次セルへフォーカス**（最後のセルなら新規セル追加は任意）。
- 実行は既存の `invoke("r_execute", { code })` をそのセルのコードで呼ぶ（バックエンドは既にセッション共有）。

主に触るファイル: [src/main.ts](c:\Users\shunk\Desktop\R\src\main.ts)、必要なら [src/style.css](c:\Users\shunk\Desktop\R\src\style.css)（セル間の余白・ボタン配置）。

## 3. `install.packages` が使えない／見えない問題

**技術的には可能**。対策は次の組み合わせが効く。

1. **stderr を捨てない**  
   [r_session.rs](c:\Users\shunk\Desktop\R\src-tauri\src\r_session.rs) で `stderr` を `Stdio::piped()` にし、`source()` 実行中は **別スレッドで stderr を読み取り**、返却文字列に **stdout の後に stderr を連結**（または Tauri の戻り値を `{ stdout, stderr }` のまま UI で2ブロック表示）。これだけで「何も起きない」体感がかなり減る。

2. **非対話のデフォルト CRAN**  
   `source()` の前に毎回（またはセッション開始時に一度）R 側で例えば次を実行するラッパーを挟む案:
   - `options(repos = c(CRAN = "https://cloud.r-project.org"))`  
   これで `install.packages("foo")` が **ミラー待ちで止まりにくい**。

3. **長時間インストール**  
   現状はマーカー行が返るまで UI は「実行中」。stderr を流せば進捗は見える。将来的に **タイムアウト**や **キャンセル**は別タスク。

4. **ドキュメント**  
   ユーザー向けに README かヒント文で「初回は `repos` 明示推奨」を1行。

触るファイル: [src-tauri/src/r_session.rs](c:\Users\shunk\Desktop\R\src-tauri\src\r_session.rs)、必要なら [commands.rs](c:\Users\shunk\Desktop\R\src-tauri\src\commands.rs)（戻り値は既に `stderr` フィールドあり）。

## 実装順序（推奨）

1. **stderr 回収 + デフォルト `options(repos=...)`**（install の体感改善が最大）
2. **複数セル + 追加ボタン + Shift+Enter のセル単位**
3. **括弧の自動閉じ（レベル A）**
4. （任意）CodeMirror 化と補完（レベル B）

## リスク・注意

- stderr を読むスレッドは、R プロセス終了時に **EOF でループ終了**するようガードする。
- 括弧自動閉じは、R の文字列内の `)` などで誤動作しうる。**最小実装＋後で CodeMirror に移行**が安全。
