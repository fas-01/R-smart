use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

const END_MARKER: &str = ".__RLAB_END__.";

static SCRIPT_COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct RSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
    script_dir: tempfile::TempDir,
    /// Background pump appends R stderr (install.packages progress, warnings).
    stderr_acc: Arc<Mutex<String>>,
}

impl RSession {
    pub fn start(r_path: &str) -> std::io::Result<Self> {
        let script_dir = tempfile::tempdir()?;

        let mut child = Command::new(r_path)
            .args(["--slave", "--no-save", "--no-restore"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdin = child.stdin.take().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::Other, "R stdin unavailable")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::Other, "R stdout unavailable")
        })?;
        let stderr_pipe = child.stderr.take().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::Other, "R stderr unavailable")
        })?;

        let stderr_acc = Arc::new(Mutex::new(String::new()));
        let acc_for_thread = Arc::clone(&stderr_acc);
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr_pipe);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let mut acc = acc_for_thread.lock().unwrap_or_else(|e| e.into_inner());
                        acc.push_str(&line);
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            script_dir,
            stderr_acc,
        })
    }

    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn script_path(&self) -> PathBuf {
        let n = SCRIPT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        self.script_dir
            .path()
            .join(format!("cell_{}_{}.R", ts, n))
    }

    fn r_string_literal(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/").replace('\'', "\\'")
    }

    pub fn evaluate(&mut self, code: &str, timeout_sec: Option<u64>) -> std::io::Result<(String, String)> {
        self.stderr_acc.lock().unwrap_or_else(|e| e.into_inner()).clear();

        let script_path = self.script_path();
        std::fs::write(&script_path, code)?;

        let path_lit = Self::r_string_literal(&script_path);
        
        let timeout_setup = if let Some(secs) = timeout_sec {
            if secs > 0 {
                format!("setTimeLimit(elapsed = {}, transient = TRUE)", secs)
            } else {
                "setTimeLimit(elapsed = Inf, transient = TRUE)".to_string()
            }
        } else {
            "setTimeLimit(elapsed = 10, transient = TRUE)".to_string()
        };

        // Non-interactive CRAN default so install.packages does not prompt.
        let wrapper = format!(
            r#"options(repos = c(CRAN = "https://cloud.r-project.org"), BioC_mirror = "https://bioconductor.org")
tryCatch({{
  {}
  invisible(source('{path_lit}', local = FALSE, echo = FALSE, print.eval = TRUE))
}}, error = function(e) {{
  cat("Error:", conditionMessage(e), "\n")
}}, finally = {{
  setTimeLimit(elapsed = Inf, transient = TRUE)
}})
cat("{END_MARKER}\n")
flush.console()
"#,
            timeout_setup,
            path_lit = path_lit,
            END_MARKER = END_MARKER
        );

        self.stdin.write_all(wrapper.as_bytes())?;
        self.stdin.flush()?;

        let mut stdout_lines: Vec<String> = Vec::new();
        let mut line = String::new();
        loop {
            line.clear();
            let n = self.stdout.read_line(&mut line)?;
            if n == 0 {
                break;
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed == END_MARKER {
                break;
            }
            stdout_lines.push(trimmed.to_string());
        }

        let _ = std::fs::remove_file(&script_path);

        let stdout = stdout_lines.join("\n");
        let stderr = self.stderr_acc.lock().unwrap_or_else(|e| e.into_inner()).clone();

        Ok((stdout, stderr))
    }

    /// Prefix completion via `utils::apropos` (regex from glob `prefix*`).
    pub fn complete(
        &mut self,
        prefix: &str,
        limit: usize,
        functions_only: bool,
    ) -> std::io::Result<Vec<String>> {
        self.stderr_acc.lock().unwrap_or_else(|e| e.into_inner()).clear();

        let prefix_path = self.script_path().with_extension("prefix.txt");
        std::fs::write(&prefix_path, prefix)?;

        let path_lit = Self::r_string_literal(&prefix_path);
        let mode = if functions_only { "function" } else { "any" };
        let lim = limit.min(200).max(1);

        let wrapper = format!(
            r#"options(repos = c(CRAN = "https://cloud.r-project.org"), BioC_mirror = "https://bioconductor.org")
tryCatch({{
  .lines <- readLines('{path_lit}', encoding = "UTF-8", warn = FALSE)
  .prefix <- paste(.lines, collapse = "\n")
  pat <- utils::glob2rx(paste0(.prefix, "*"))
  hits <- tryCatch(unique(stats::na.omit(utils::apropos(pat, mode = "{mode}"))), error = function(e) character(0))
  hits <- sort(hits)
  hits <- utils::head(hits, {lim}L)
  if (length(hits) > 0) cat(paste(hits, collapse = "\n"))
  cat("\n")
}}, error = function(e) {{ cat("\n") }})
cat("{END_MARKER}\n")
flush.console()
"#,
            path_lit = path_lit,
            mode = mode,
            lim = lim,
            END_MARKER = END_MARKER,
        );

        self.stdin.write_all(wrapper.as_bytes())?;
        self.stdin.flush()?;

        let mut stdout_lines: Vec<String> = Vec::new();
        let mut line = String::new();
        loop {
            line.clear();
            let n = self.stdout.read_line(&mut line)?;
            if n == 0 {
                break;
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed == END_MARKER {
                break;
            }
            stdout_lines.push(trimmed.to_string());
        }

        let _ = std::fs::remove_file(&prefix_path);

        let text = stdout_lines.join("\n");
        let names: Vec<String> = text
            .lines()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();

        Ok(names)
    }
}

pub struct RSessionHandle {
    r_path: String,
    session: Mutex<Option<RSession>>,
}

impl RSessionHandle {
    pub fn new(r_path: String) -> Self {
        Self {
            r_path,
            session: Mutex::new(None),
        }
    }

    fn ensure_session(&self) -> Result<(), String> {
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        let needs_start = match guard.as_mut() {
            None => true,
            Some(s) => !s.is_alive(),
        };
        if needs_start {
            let session = RSession::start(&self.r_path).map_err(|e| e.to_string())?;
            *guard = Some(session);
        }
        Ok(())
    }

    pub fn evaluate(&self, code: &str, timeout_sec: Option<u64>) -> Result<(String, String, i32), String> {
        self.ensure_session()?;
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        let session = guard.as_mut().ok_or("R session not available")?;

        match session.evaluate(code, timeout_sec) {
            Ok((stdout, stderr)) => {
                let stdout_err = stdout.starts_with("Error:");
                let stderr_fatal = stderr.contains("Execution halted");
                let ok = !stdout_err && !stderr_fatal;
                let exit_code = if ok { 0 } else { 1 };
                Ok((stdout, stderr, exit_code))
            }
            Err(e) => {
                *guard = None;
                Err(e.to_string())
            }
        }
    }

    pub fn complete(
        &self,
        prefix: &str,
        limit: usize,
        functions_only: bool,
    ) -> Result<Vec<String>, String> {
        let prefix = prefix.trim();
        if prefix.is_empty() {
            return Ok(vec![]);
        }
        self.ensure_session()?;
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        let session = guard.as_mut().ok_or("R session not available")?;

        match session.complete(prefix, limit, functions_only) {
            Ok(v) => Ok(v),
            Err(e) => {
                *guard = None;
                Err(e.to_string())
            }
        }
    }
}
