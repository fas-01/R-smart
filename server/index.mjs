import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import express from "express";

const PORT = 3847;
const DEFAULT_R = "C:\\Program Files\\R\\R-4.5.0\\bin\\x64\\R.exe";

function findR() {
  if (process.env.RLAB_R_PATH && existsSync(process.env.RLAB_R_PATH)) {
    return process.env.RLAB_R_PATH;
  }
  if (existsSync(DEFAULT_R)) return DEFAULT_R;
  return null;
}

function runR(code, rPath) {
  return new Promise((resolve) => {
    const child = spawn(rPath, ["--slave", "-e", code], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ exitCode: 1, stdout: "", stderr: err.message });
    });
  });
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  const rPath = findR();
  res.json({ ok: true, rPath, rFound: Boolean(rPath) });
});

app.post("/api/execute", async (req, res) => {
  const rPath = findR();
  if (!rPath) {
    res.status(503).json({
      ok: false,
      error: "R が見つかりません。RLAB_R_PATH で R.exe を指定してください。",
    });
    return;
  }
  const code = String(req.body?.code ?? "").trim();
  if (!code) {
    res.status(400).json({ ok: false, error: "コードが空です" });
    return;
  }
  const result = await runR(code, rPath);
  res.json({
    ok: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`R bridge http://127.0.0.1:${PORT}`);
});
