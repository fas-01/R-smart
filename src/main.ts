import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { createREditor } from "./r-editor";
import type { EditorView } from "@codemirror/view";
import "./style.css";

type CellData = { id: string; code: string };
type Theme = "light" | "dark";

const app = document.querySelector<HTMLDivElement>("#app")!;

let cells: CellData[] = [{ id: crypto.randomUUID(), code: "1 + 1" }];
const cellEditors = new Map<number, EditorView>();
const THEME_KEY = "r-lab-theme";
let isDirty = false;

function updateDirtyState(dirty: boolean) {
  isDirty = dirty;
  const saveBtn = document.querySelector<HTMLButtonElement>("#save-btn");
  if (saveBtn) {
    if (isDirty) {
      saveBtn.classList.add("err-btn");
    } else {
      saveBtn.classList.remove("err-btn");
    }
  }
}

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

  app.replaceChildren();

  const header = document.createElement("header");
  header.className = "header";

  const h1 = document.createElement("h1");
  h1.textContent = "R Smart";
  header.appendChild(h1);

  const statusSpan = document.createElement("span");
  statusSpan.id = "r-status";
  statusSpan.className = "badge";
  statusSpan.textContent = "R 確認中…";
  header.appendChild(statusSpan);

  const spacer = document.createElement("div");
  spacer.className = "header-spacer";
  header.appendChild(spacer);

  const themeBtnEl = document.createElement("button");
  themeBtnEl.type = "button";
  themeBtnEl.id = "theme-toggle";
  themeBtnEl.className = "toolbar-btn theme-btn";
  header.appendChild(themeBtnEl);

  const addCellBtn = document.createElement("button");
  addCellBtn.type = "button";
  addCellBtn.id = "add-cell";
  addCellBtn.className = "toolbar-btn";
  addCellBtn.textContent = "＋ セルを追加";
  header.appendChild(addCellBtn);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.id = "save-btn";
  saveBtn.className = isDirty ? "toolbar-btn err-btn" : "toolbar-btn";
  saveBtn.textContent = "保存";
  header.appendChild(saveBtn);

  const loadBtn = document.createElement("button");
  loadBtn.type = "button";
  loadBtn.id = "load-btn";
  loadBtn.className = "toolbar-btn";
  loadBtn.textContent = "開く";
  header.appendChild(loadBtn);

  app.appendChild(header);

  const banner = document.createElement("div");
  banner.className = "security-banner";
  banner.style.backgroundColor = "var(--accent)";
  banner.style.color = "#fff";
  banner.style.padding = "4px 16px";
  banner.style.textAlign = "center";
  banner.style.fontSize = "0.8em";
  banner.style.fontWeight = "bold";
  banner.style.display = "flex";
  banner.style.justifyContent = "center";
  banner.style.alignItems = "center";
  banner.style.position = "relative";

  const bannerText = document.createElement("span");
  bannerText.textContent = "警告: 信頼できない R コードを実行するとシステムが乗っ取られる危険性があります（OS コマンドインジェクション）。信頼できるコードのみ実行してください。";
  banner.appendChild(bannerText);

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✖";
  closeBtn.style.position = "absolute";
  closeBtn.style.right = "16px";
  closeBtn.style.background = "none";
  closeBtn.style.border = "none";
  closeBtn.style.color = "#fff";
  closeBtn.style.cursor = "pointer";
  closeBtn.style.fontSize = "1.2em";
  closeBtn.style.padding = "0";
  closeBtn.addEventListener("click", () => {
    banner.style.transition = "opacity 0.3s ease";
    banner.style.opacity = "0";
    setTimeout(() => banner.remove(), 300);
  });
  banner.appendChild(closeBtn);

  app.appendChild(banner);

  const main = document.createElement("main");
  main.className = "notebook";
  main.id = "notebook-root";
  app.appendChild(main);

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Shift+Enter で実行して次のセルへ。入力中は関数候補が表示されます（Ctrl+Space）。";
  app.appendChild(hint);

  const root = main;

  cells.forEach((cell, index) => {
    const section = document.createElement("section");
    section.className = "cell";
    section.dataset.cellIndex = String(index);

    const canRemove = cells.length > 1;

    const toolbar = document.createElement("div");
    toolbar.className = "cell-toolbar";

    const label = document.createElement("span");
    label.className = "cell-label";
    label.textContent = `In [${index + 1}]`;
    toolbar.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "cell-actions";

    if (canRemove) {
      const rmBtn = document.createElement("button");
      rmBtn.type = "button";
      rmBtn.className = "remove-btn";
      rmBtn.dataset.action = "remove";
      rmBtn.title = "セルを削除";
      rmBtn.textContent = "✕";
      actions.appendChild(rmBtn);
    }

    const timeoutSelect = document.createElement("select");
    timeoutSelect.className = "timeout-select toolbar-btn";
    timeoutSelect.dataset.action = "timeout";
    const options = [
      { label: "1秒", value: 1 },
      { label: "10秒", value: 10 },
      { label: "30秒", value: 30 },
      { label: "1分", value: 60 },
      { label: "5分", value: 300 },
      { label: "30分", value: 1800 },
      { label: "無制限", value: 0 }
    ];
    options.forEach(opt => {
      const optionEl = document.createElement("option");
      optionEl.value = String(opt.value);
      optionEl.textContent = opt.label;
      if (opt.value === 10) optionEl.selected = true;
      timeoutSelect.appendChild(optionEl);
    });
    actions.appendChild(timeoutSelect);

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "run-btn";
    runBtn.dataset.action = "run";
    runBtn.textContent = "▶ 実行";
    actions.appendChild(runBtn);

    toolbar.appendChild(actions);
    section.appendChild(toolbar);

    const cmHost = document.createElement("div");
    cmHost.className = "cm-host";
    cmHost.dataset.cellIndex = String(index);
    section.appendChild(cmHost);

    const pre = document.createElement("pre");
    pre.className = "output muted";
    pre.dataset.outputFor = String(index);
    pre.textContent = "Shift+Enter または ▶ で実行";
    section.appendChild(pre);

    const imageContainer = document.createElement("div");
    imageContainer.className = "image-output";
    imageContainer.dataset.imagesFor = String(index);
    section.appendChild(imageContainer);

    root.appendChild(section);

    const host = section.querySelector<HTMLDivElement>(".cm-host")!;
    const view = createREditor({
      parent: host,
      doc: cell.code,
      onChange: (code) => {
        cells[index]!.code = code;
        updateDirtyState(true);
      },
      onShiftEnter: () => {
        void runCell(index).then(() => focusNextCell(index));
      },
    });
    cellEditors.set(index, view);
  });

  document.querySelector<HTMLButtonElement>("#add-cell")!.addEventListener("click", () => {
    cells.push({ id: crypto.randomUUID(), code: "" });
    updateDirtyState(true);
    render();
    focusCell(cells.length - 1);
  });
  
  document.querySelector<HTMLButtonElement>("#save-btn")!.addEventListener("click", saveNotebook);
  document.querySelector<HTMLButtonElement>("#load-btn")!.addEventListener("click", loadNotebook);
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
        updateDirtyState(true);
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

type RHealth = { rFound: boolean };
type RExecuteResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
  imagesBase64?: string[];
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

const DANGEROUS_FUNCTIONS = ["system", "shell", "Sys.setenv", "unlink", "file.remove", "system2", "file.create", "file.append"];
const DANGEROUS_REGEX = new RegExp(`\\b(${DANGEROUS_FUNCTIONS.join("|")})\\s*\\(`, "i");

function checkDangerousCode(code: string): Promise<boolean> {
  if (!DANGEROUS_REGEX.test(code)) return Promise.resolve(true);

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "modal-dialog";

    const title = document.createElement("h2");
    title.textContent = "警告: 危険なコードの実行";
    title.style.color = "var(--err)";
    title.style.marginTop = "0";

    const msg = document.createElement("p");
    msg.textContent = "実行しようとしているコードにOS操作などの危険な関数が含まれています。システムに重大な影響を与える可能性があります。";

    const instruction = document.createElement("p");
    instruction.textContent = "本当に実行する場合は、下の入力欄に「OK」と入力し、10秒経過後にボタンを押してください。";
    instruction.style.fontWeight = "bold";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "OK と入力";
    input.className = "modal-input";

    const btnContainer = document.createElement("div");
    btnContainer.className = "modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "キャンセル";
    cancelBtn.className = "toolbar-btn";

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "実行する (10)";
    confirmBtn.className = "toolbar-btn err-btn";
    confirmBtn.disabled = true;

    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(confirmBtn);

    dialog.appendChild(title);
    dialog.appendChild(msg);
    dialog.appendChild(instruction);
    dialog.appendChild(input);
    dialog.appendChild(btnContainer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let secondsLeft = 10;
    const checkEnable = () => {
      if (secondsLeft <= 0 && input.value.trim() === "OK") {
        confirmBtn.disabled = false;
      } else {
        confirmBtn.disabled = true;
      }
    };

    const timer = setInterval(() => {
      secondsLeft--;
      if (secondsLeft > 0) {
        confirmBtn.textContent = `実行する (${secondsLeft})`;
      } else {
        clearInterval(timer);
        confirmBtn.textContent = "実行する";
        checkEnable();
      }
    }, 1000);

    input.addEventListener("input", checkEnable);

    cancelBtn.addEventListener("click", () => {
      clearInterval(timer);
      document.body.removeChild(overlay);
      resolve(false);
    });

    confirmBtn.addEventListener("click", () => {
      clearInterval(timer);
      document.body.removeChild(overlay);
      resolve(true);
    });

    input.focus();
  });
}

async function runCell(index: number) {
  const view = cellEditors.get(index);
  const outputEl = document.querySelector<HTMLPreElement>(`[data-output-for="${index}"]`);
  const imageContainer = document.querySelector<HTMLDivElement>(`[data-images-for="${index}"]`);
  const runBtn = document.querySelector<HTMLButtonElement>(
    `.cell[data-cell-index="${index}"] [data-action='run']`,
  );
  const timeoutSelect = document.querySelector<HTMLSelectElement>(
    `.cell[data-cell-index="${index}"] [data-action='timeout']`,
  );
  if (!view || !outputEl) return;

  const code = view.state.doc.toString();
  cells[index]!.code = code;
  outputEl.textContent = "実行中…";
  outputEl.className = "output";
  if (imageContainer) imageContainer.replaceChildren();
  if (runBtn) runBtn.disabled = true;
  if (timeoutSelect) timeoutSelect.disabled = true;

  const isSafeToRun = await checkDangerousCode(code);
  if (!isSafeToRun) {
    outputEl.textContent = "実行がキャンセルされました。";
    outputEl.className = "output";
    if (runBtn) runBtn.disabled = false;
    if (timeoutSelect) timeoutSelect.disabled = false;
    return;
  }

  const timeoutSec = timeoutSelect ? Number(timeoutSelect.value) : 10;
  const timeoutParam = timeoutSec === 0 ? null : timeoutSec;

  try {
    const data = await invoke<RExecuteResult>("r_execute", { code, timeoutSec: timeoutParam });
    if (data.error) {
      outputEl.textContent = data.error;
      outputEl.className = "output err";
      return;
    }
    outputEl.textContent = formatOutput(data);
    outputEl.className = data.ok ? "output ok" : "output err";

    if (imageContainer && data.imagesBase64) {
      data.imagesBase64.forEach((b64) => {
        const img = document.createElement("img");
        img.src = b64;
        img.style.maxWidth = "100%";
        img.style.marginTop = "8px";
        img.style.borderRadius = "4px";
        img.style.backgroundColor = "white"; // Provide solid background for transparent plots
        imageContainer.appendChild(img);
      });
    }
  } catch (e) {
    outputEl.textContent = `実行失敗: ${e}`;
    outputEl.className = "output err";
  } finally {
    if (runBtn) runBtn.disabled = false;
    if (timeoutSelect) timeoutSelect.disabled = false;
  }
}

async function saveNotebook() {
  const filePath = await save({
    filters: [
      { name: "R Scripts", extensions: ["R", "r"] },
      { name: "R Markdown", extensions: ["Rmd", "rmd"] },
      { name: "Text Files", extensions: ["txt"] }
    ]
  });

  if (!filePath) return;

  const ext = filePath.split(".").pop()?.toLowerCase();
  let content = "";

  if (ext === "rmd") {
    content = cells.map(c => "```{r}\n" + c.code + "\n```").join("\n\n");
  } else {
    content = cells.map(c => c.code).join("\n\n# %%\n\n");
  }

  try {
    await invoke("save_file", { path: filePath, content });
    updateDirtyState(false);
  } catch (err) {
    console.error("Failed to save:", err);
    alert(`保存に失敗しました: ${err}`);
  }
}

async function loadNotebook() {
  const file = await open({
    multiple: false,
    filters: [
      { name: "R Scripts & Text", extensions: ["R", "r", "txt"] },
      { name: "R Markdown", extensions: ["Rmd", "rmd"] }
    ]
  });

  if (!file) return;

  const filePath = Array.isArray(file) ? file[0] : file;
  
  try {
    const content = await invoke<string>("load_file", { path: filePath });
    const ext = filePath.split(".").pop()?.toLowerCase();
    
    let parsedCells: string[] = [];

    if (ext === "rmd") {
      const regex = /```\{r\}[\s\S]*?\n([\s\S]*?)```/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        parsedCells.push(match[1].trim());
      }
      if (parsedCells.length === 0) {
        parsedCells.push(content);
      }
    } else {
      parsedCells = content.split(/^[ \t]*#[ \t]*%%[ \t]*$/m).map(s => s.trim());
    }

    cells = parsedCells.map(code => ({ id: crypto.randomUUID(), code }));
    
    if (cells.length === 0) {
      cells = [{ id: crypto.randomUUID(), code: "" }];
    }
    
    updateDirtyState(false);
    render();
  } catch (err) {
    console.error("Failed to load:", err);
    alert("読み込みに失敗しました");
  }
}

setTheme(detectInitialTheme());
render();
