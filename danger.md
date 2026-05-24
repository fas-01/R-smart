# R Smart セキュリティ脆弱性レポート

アプリケーション全体（Rust/Tauri バックエンド、TypeScript フロントエンド、Express サーバー）を調査し、以下の脆弱性を発見しました。

---

## 🔴 重大 (Critical)

### 1. CSP (Content Security Policy) の完全無効化

> [!CAUTION]
> **ファイル**: [tauri.conf.json](file:///c:/Users/shunk/Desktop/R/src-tauri/tauri.conf.json#L22-L24)

```json
"security": {
  "csp": null
}
```

**問題**: `csp: null` により Content Security Policy が完全に無効化されています。これにより WebView 内で**任意のインラインスクリプト実行**、**外部スクリプトの読み込み**、**eval() の使用**が可能になり、XSS 攻撃の影響を最大化します。

**修正方針**:
```json
"security": {
  "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://cloud.r-project.org"
}
```

---

### 2. R コード実行における OS コマンドインジェクション

> [!CAUTION]
> **ファイル**: [r_session.rs](file:///c:/Users/shunk/Desktop/R/src-tauri/src/r_session.rs#L90-L110)

```rust
let wrapper = format!(
    r#"options(repos = c(CRAN = "https://cloud.r-project.org"), ...)
tryCatch({{
  invisible(source('{path_lit}', local = FALSE, echo = FALSE, print.eval = TRUE))
}}, error = function(e) {{
  cat("Error:", conditionMessage(e), "\n")
}})
cat("{END_MARKER}\n")
..."#
);
```

**問題**: ユーザーが入力した R コードがそのまま `source()` 経由で実行されます。R の `system()` や `shell()` 関数を使えば **OS レベルの任意コマンドが実行可能** です。

例: `system("whoami")` や `system("del /s /q C:\\*")` のような破壊的コマンドも実行できます。

**注意**: これはアプリの本質的な機能（R コード実行）であるため完全な防御は困難ですが、以下の緩和策が有効です：
- ユーザーへの警告表示（信頼できないコードを実行しないよう促す）
- `system()`, `shell()`, `file.remove()` 等の危険な関数呼び出しの検出と警告
- サンドボックス化（ファイルシステムアクセスの制限）

---

### 3. Express サーバーの認証・認可なしコード実行 API

> [!CAUTION]
> **ファイル**: [server/index.mjs](file:///c:/Users/shunk/Desktop/R/server/index.mjs#L42-L63)

```javascript
app.post("/api/execute", async (req, res) => {
  // 認証チェックなし
  const code = String(req.body?.code ?? "").trim();
  const result = await runR(code, rPath);
  // ...
});
```

**問題**: `dev:web` モードで使用される Express サーバーは `127.0.0.1:3847` でリッスンしていますが、**認証も CORS 制限もありません**。ローカルマシン上の任意のプロセスや、ブラウザ上の悪意のある Web ページから、`POST /api/execute` で任意の R コード（= 任意の OS コマンド）を実行できます。

**修正方針**:
- ランダムトークンベースの認証を追加
- CORS ヘッダーで `localhost:5173` のみ許可
- 本番では Express サーバー自体を使用しない設計に

---

## 🟠 高 (High)

### 4. innerHTML による XSS (Cross-Site Scripting)

> [!WARNING]
> **ファイル**: [main.ts](file:///c:/Users/shunk/Desktop/R/src/main.ts#L38-L48) および [main.ts](file:///c:/Users/shunk/Desktop/R/src/main.ts#L59-L69)

```typescript
app.innerHTML = `
  <header class="header">
    <h1>R Smart</h1>
    ...
  </header>
  ...
`;
```

```typescript
section.innerHTML = `
  <div class="cell-toolbar">
    <span class="cell-label">In [${index + 1}]</span>
    ...
  </div>
  <div class="cm-host" data-cell-index="${index}"></div>
  <pre class="output muted" data-output-for="${index}">...</pre>
`;
```

**問題**: `innerHTML` で DOM を構築しています。現時点では `index` は数値なので直接の攻撃ベクトルは限定的ですが、CSP が無効化されている状態と組み合わせると、将来的にデータフローが変わった場合にXSSの温床になります。

**修正方針**: `document.createElement()` によるDOM構築、または `textContent` の使用に置き換える。

---

### 5. R コード出力の未サニタイズ表示

> [!WARNING]
> **ファイル**: [main.ts](file:///c:/Users/shunk/Desktop/R/src/main.ts#L185)

```typescript
outputEl.textContent = formatOutput(data);
```

**現状**: `textContent` を使用しているため、ここでは XSS リスクは **低い** です（HTML として解釈されない）。ただし `outputEl.className` の動的設定と組み合わせると、将来的なリファクタリングで `innerHTML` に変更された場合にリスクが顕在化します。

---

### 6. 一時ファイルの TOCTOU レースコンディション

> [!WARNING]
> **ファイル**: [r_session.rs](file:///c:/Users/shunk/Desktop/R/src-tauri/src/r_session.rs#L24-L26)

```rust
let script_dir = std::env::temp_dir().join("r-lab-scripts");
std::fs::create_dir_all(&script_dir)?;
```

**問題**: 一時ディレクトリ `%TEMP%\r-lab-scripts` は予測可能なパス名で作成されます。マルチユーザー環境では、攻撃者が同名ディレクトリやシンボリックリンクを事前に配置し、以下の攻撃が可能です：
- **スクリプト差し替え (TOCTOU)**: ファイル書き込みと `source()` 実行の間にスクリプトファイルを悪意のある内容に差し替える
- **シンボリックリンク攻撃**: `r-lab-scripts` を別のディレクトリへのシンボリックリンクにして、任意のファイルを上書き

**修正方針**:
- ランダムなディレクトリ名を使用 (`tempfile::tempdir()` クレートの利用)
- アクセス権を制限 (ACL)
- 使用後即削除（既に実施済み ✓ だが、タイミングウィンドウは残る）

---

### 7. パスリテラルのエスケープ不完全

> [!WARNING]
> **ファイル**: [r_session.rs](file:///c:/Users/shunk/Desktop/R/src-tauri/src/r_session.rs#L86-L88)

```rust
fn r_string_literal(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").replace('\'', "\\'")
}
```

**問題**: シングルクォートのみエスケープしていますが、R の文字列リテラルでは `\n`, `\t`, `\0` 等のエスケープシーケンスも解釈されます。一時ディレクトリパスにこれらの文字（実際にはまれですが）が含まれる場合、R コードインジェクションの可能性があります。

**修正方針**: より厳密なエスケープ、またはファイルパスを環境変数経由で渡す方式に変更。

---

## 🟡 中 (Medium)

### 8. R パスの環境変数による制御

> [!IMPORTANT]
> **ファイル**: [commands.rs](file:///c:/Users/shunk/Desktop/R/src-tauri/src/commands.rs#L11-L21) / [server/index.mjs](file:///c:/Users/shunk/Desktop/R/server/index.mjs#L8-L14)

```rust
fn find_r() -> Option<String> {
    if let Ok(path) = std::env::var("RLAB_R_PATH") {
        if Path::new(&path).exists() {
            return Some(path);
        }
    }
    // ...
}
```

**問題**: `RLAB_R_PATH` 環境変数を設定できる攻撃者は、偽の `R.exe` を指定して任意のバイナリを実行させることができます。環境変数の汚染は共有マシンやCI環境でリスクが高まります。

**修正方針**: 実行前にバイナリの署名やパスのホワイトリストを検証。

---

### 9. ハードコードされた R パス

> [!IMPORTANT]
> **ファイル**: [commands.rs](file:///c:/Users/shunk/Desktop/R/src-tauri/src/commands.rs#L7) / [server/index.mjs](file:///c:/Users/shunk/Desktop/R/server/index.mjs#L6)

```rust
const DEFAULT_R: &str = r"C:\Program Files\R\R-4.5.0\bin\x64\R.exe";
```

**問題**: R のバージョン `4.5.0` がハードコードされています。セキュリティの問題ではなく **可用性の問題** ですが、異なるバージョンの R がインストールされている環境では動作しません。

**修正方針**: レジストリや `where R` コマンドで動的に検出。

---

### 10. エラー情報の過剰公開

**ファイル**: [commands.rs](file:///c:/Users/shunk/Desktop/R/src-tauri/src/commands.rs#L90-L97)

```rust
Err(e) => RExecuteResult {
    ok: false,
    stdout: String::new(),
    stderr: e.clone(),
    exit_code: 1,
    error: Some(e),
},
```

**問題**: R セッションの内部エラーメッセージ（ファイルパス、システム情報を含む可能性）がそのままフロントエンドに返されます。情報漏洩のリスクがあります。

---

## 🔵 低 (Low)

### 11. Mutex ポイズニング時のセッション喪失

**ファイル**: [r_session.rs](file:///c:/Users/shunk/Desktop/R/src-tauri/src/r_session.rs#L226-L237)

```rust
fn ensure_session(&self) -> Result<(), String> {
    let mut guard = self.session.lock().map_err(|e| e.to_string())?;
    // ...
}
```

**問題**: パニックにより Mutex がポイズンされた場合、以降のすべての `evaluate` / `complete` 呼び出しが永続的に失敗します。`lock().unwrap_or_else(|e| e.into_inner())` でポイズンからの回復を検討。

---

### 12. 一時スクリプトファイルの残留

**問題**: [r_session.rs](file:///c:/Users/shunk/Desktop/R/src-tauri/src/r_session.rs#L130) でファイル削除が試みられますが、R プロセスがクラッシュした場合やアプリが強制終了した場合、`%TEMP%\r-lab-scripts` にスクリプトファイルが残留します。ユーザーが入力した R コードが一時ファイルとしてディスクに残ることは情報漏洩のリスクです。

**修正方針**: アプリ終了時のクリーンアップフックを追加。

---

## 📊 脆弱性サマリー

| # | 脆弱性 | 重大度 | ファイル | 種別 |
|---|--------|--------|----------|------|
| 1 | CSP 無効化 | 🔴 Critical | `tauri.conf.json` | 設定ミス |
| 2 | R コード → OS コマンド実行 | 🔴 Critical | `r_session.rs` | 設計上の制約 |
| 3 | 認証なし Express API | 🔴 Critical | `server/index.mjs` | 認証欠如 |
| 4 | innerHTML XSS | 🟠 High | `main.ts` | XSS |
| 5 | 出力のサニタイズ | 🟠 High | `main.ts` | 潜在的 XSS |
| 6 | TOCTOU レースコンディション | 🟠 High | `r_session.rs` | レースコンディション |
| 7 | パスエスケープ不完全 | 🟠 High | `r_session.rs` | インジェクション |
| 8 | 環境変数によるバイナリ差し替え | 🟡 Medium | `commands.rs` | 信頼境界の逸脱 |
| 9 | ハードコードされた R パス | 🟡 Medium | `commands.rs` | 可用性 |
| 10 | エラー情報の過剰公開 | 🟡 Medium | `commands.rs` | 情報漏洩 |
| 11 | Mutex ポイズニング | 🔵 Low | `r_session.rs` | 可用性 |
| 12 | 一時ファイル残留 | 🔵 Low | `r_session.rs` | 情報漏洩 |

---

## 🎯 優先的に対応すべき項目

1. **CSP を有効にする** (tauri.conf.json) — 最も手軽で効果が大きい
2. **Express API に認証を追加する** — dev モード限定でもリスクが高い
3. **一時ディレクトリのランダム化** — `tempfile` クレートの利用
4. **innerHTML を DOM API に置き換える** — XSS 耐性の向上
