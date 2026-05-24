import { invoke } from "@tauri-apps/api/core";
import { createREditor } from "./r-editor";
import type { EditorView } from "@codemirror/view";
import "./style.css";

type CellData = { id: string; code: string };
type Theme = "light" | "dark";

const app = document.querySelector<HTMLDivElement>("#app")!;

let cells: CellData[] = [{ id: crypto.randomUUID(), code: "1 + 1" }];
const cellEditors = new Map<number, EditorView>();
const THEME_KEY = "r-lab-theme";

function detectInitialTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_KEY, theme);
}

function toggleTheme() {
  const current = (document.documentElement.getAttribute("data-theme") as Theme | null) ?? "light";
  const next: Theme = current === "dark" ? "light" : "dark";
  setTheme(next);
  const btn = document.querySelector<HTMLButtonElement>("#theme-toggle");
  if (btn) btn.textContent = next === "dark" ? "ダーク" : "ライト";
}

function render() {
  cellEditors.forEach((v) => v.destroy());
  cellEditors.clear();

  app.innerHTML = `
  <header class="header">
    <h1>R Smart</h1>
    <span id="r-status" class="badge">R 確認中…</span>
    <div class="header-spacer"></div>
    <button type="button" id="theme-toggle" class="toolbar-btn theme-btn"></button>
    <button type="button" id="add-cell" class="toolbar-btn">＋ セルを追加</button>
  </header>
  <main class="notebook" id="notebook-root"></main>
  <p class="hint">Shift+Enter で実行して次のセルへ。入力中は関数候補が表示されます（Ctrl+Space）。</p>
  `;

  const root = document.querySelector<HTMLDivElement>("#notebook-root")!;
  root.replaceChildren();

  cells.forEach((cell, index) => {
    const section = document.createElement("section");
    section.className = "cell";
    section.dataset.cellIndex = String(index);

    const canRemove = cells.length > 1;
    section.innerHTML = `
      <div class="cell-toolbar">
        <span class="cell-label">In [${index + 1}]</span>
        <div class="cell-actions">
          ${canRemove ? `<button type="button" class="remove-btn" data-action="remove" title="セルを削除">✕</button>` : ""}
          <button type="button" class="run-btn" data-action="run">▶ 実行</button>
        </div>
      </div>
      <div class="cm-host" data-cell-index="${index}"></div>
      <pre class="output muted" data-output-for="${index}">Shift+Enter または ▶ で実行</pre>
    `;
    root.appendChild(section);

    const host = section.querySelector<HTMLDivElement>(".cm-host")!;
    const view = createREditor({
      parent: host,
      doc: cell.code,
      onChange: (code) => {
        cells[index]!.code = code;
      },
      onShiftEnter: () => {
        void runCell(index).then(() => focusNextCell(index));
      },
    });
    cellEditors.set(index, view);
  });

  document.querySelector<HTMLButtonElement>("#add-cell")!.addEventListener("click", () => {
    cells.push({ id: crypto.randomUUID(), code: "" });
    render();
    focusCell(cells.length - 1);
  });
  const themeBtn = document.querySelector<HTMLButtonElement>("#theme-toggle")!;
  const current = (document.documentElement.getAttribute("data-theme") as Theme | null) ?? "light";
  themeBtn.textContent = current === "dark" ? "ダーク" : "ライト";
  themeBtn.addEventListener("click", toggleTheme);

  root.querySelectorAll<HTMLButtonElement>("[data-action='run']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = Number((e.target as HTMLElement).closest(".cell")?.getAttribute("data-cell-index"));
      void runCell(idx);
    });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-action='remove']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = Number((e.target as HTMLElement).closest(".cell")?.getAttribute("data-cell-index"));
      if (cells.length > 1 && !Number.isNaN(idx)) {
        cells.splice(idx, 1);
        render();
      }
    });
  });

  const statusEl = document.querySelector<HTMLSpanElement>("#r-status")!;
  void checkHealth(statusEl);
}

function focusCell(index: number) {
  cellEditors.get(index)?.focus();
}

function focusNextCell(currentIndex: number) {
  const next = currentIndex + 1;
  if (next < cells.length) {
    focusCell(next);
  } else {
    cells.push({ id: crypto.randomUUID(), code: "" });
    render();
    focusCell(cells.length - 1);
  }
}

type RHealth = { rFound: boolean; rPath: string | null };
type RExecuteResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
};

async function checkHealth(statusEl: HTMLSpanElement) {
  try {
    const data = await invoke<RHealth>("r_health");
    if (data.rFound) {
      statusEl.textContent = "R 接続 OK";
      statusEl.className = "badge ok";
    } else {
      statusEl.textContent = "R 未検出";
      statusEl.className = "badge warn";
    }
  } catch {
    statusEl.textContent = "起動エラー";
    statusEl.className = "badge err";
  }
}

function formatOutput(data: RExecuteResult): string {
  if (data.error) return data.error;
  const parts = [data.stdout, data.stderr].map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return "(出力なし)";
  return parts.join("\n--- stderr ---\n");
}

async function runCell(index: number) {
  const view = cellEditors.get(index);
  const outputEl = document.querySelector<HTMLPreElement>(`[data-output-for="${index}"]`);
  const runBtn = document.querySelector<HTMLButtonElement>(
    `.cell[data-cell-index="${index}"] [data-action='run']`,
  );
  if (!view || !outputEl) return;

  const code = view.state.doc.toString();
  cells[index]!.code = code;
  outputEl.textContent = "実行中…";
  outputEl.className = "output";
  if (runBtn) runBtn.disabled = true;

  try {
    const data = await invoke<RExecuteResult>("r_execute", { code });
    if (data.error) {
      outputEl.textContent = data.error;
      outputEl.className = "output err";
      return;
    }
    outputEl.textContent = formatOutput(data);
    outputEl.className = data.ok ? "output ok" : "output err";
  } catch (e) {
    outputEl.textContent = `実行失敗: ${e}`;
    outputEl.className = "output err";
  } finally {
    if (runBtn) runBtn.disabled = false;
  }
}

setTheme(detectInitialTheme());
render();
