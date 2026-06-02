import { spawn, execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";

const PORT = 3847;
const AUTH_TOKEN = crypto.randomUUID();

function findR() {
  if (process.env.RLAB_R_PATH) {
    const path = process.env.RLAB_R_PATH;
    if (existsSync(path) && (path.endsWith("R.exe") || path.endsWith("R"))) {
      try {
        const out = execSync(`"${path}" --version`).toString();
        if (out.includes("R version")) return path;
      } catch (e) {}
    }
  }
  const base = "C:\\Program Files\\R";
  if (existsSync(base)) {
    const dirs = readdirSync(base);
    dirs.sort().reverse();
    for (const d of dirs) {
      const p = `${base}\\${d}\\bin\\x64\\R.exe`;
      if (existsSync(p)) return p;
    }
  }
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
app.use(cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"] }));
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  next();
});

app.get("/api/health", (_req, res) => {
  const rPath = findR();
  res.json({ ok: true, rFound: Boolean(rPath) });
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
