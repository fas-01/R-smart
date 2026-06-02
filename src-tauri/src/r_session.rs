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
    stdout_rx: std::sync::mpsc::Receiver<String>,
    script_dir: tempfile::TempDir,
    /// Background pump appends R stderr (install.packages progress, warnings).
    stderr_acc: Arc<Mutex<String>>,
}

impl RSession {
    pub fn start(r_path: &str) -> std::io::Result<Self> {
        let script_dir = tempfile::tempdir()?;

        let mut cmd = Command::new(r_path);
        cmd.args(["--slave", "--no-save", "--no-restore"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let mut child = cmd.spawn()?;

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
                        if acc.len() < 1024 * 1024 {
                            acc.push_str(&line);
                            if acc.len() >= 1024 * 1024 {
                                acc.push_str("\n[stderr truncated due to size limit]\n");
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let (stdout_tx, stdout_rx) = std::sync::mpsc::channel();
        let mut stdout_reader = BufReader::new(stdout);
        thread::spawn(move || {
            let mut line = String::new();
            loop {
                line.clear();
                match stdout_reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if stdout_tx.send(line.clone()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            stdout_rx,
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
        let s = path.to_string_lossy().replace('\\', "/");
        s.replace('\"', "\\\"")
    }

    pub fn evaluate(&mut self, code: &str, timeout_sec: Option<u64>) -> std::io::Result<(String, String, Vec<String>)> {
        self.stderr_acc.lock().unwrap_or_else(|e| e.into_inner()).clear();

        let script_path = self.script_path();
        std::fs::write(&script_path, code)?;

        let path_lit = Self::r_string_literal(&script_path);
        
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let n = SCRIPT_COUNTER.load(Ordering::Relaxed);
        let plot_pattern = self.script_dir.path().join(format!("plot_{}_{}_%03d.png", ts, n));
        let plot_pattern_lit = Self::r_string_literal(&plot_pattern);
        
        let timeout_setup = match timeout_sec {
            Some(secs) => format!("setTimeLimit(elapsed = {}, transient = TRUE)", secs),
            None => "setTimeLimit(elapsed = Inf, transient = TRUE)".to_string(),
        };

        // Non-interactive CRAN default so install.packages does not prompt.
        let wrapper = format!(
            r#"options(repos = c(CRAN = "https://cloud.r-project.org"), BioC_mirror = "https://bioconductor.org")
png("{plot_pattern_lit}", width=800, height=600, res=100)
tryCatch({{
  {}
  invisible(source("{path_lit}", local = FALSE, echo = FALSE, print.eval = TRUE))
}}, error = function(e) {{
  cat("Error:", conditionMessage(e), "\n")
}}, finally = {{
  setTimeLimit(elapsed = Inf, transient = TRUE)
  graphics.off()
}})
cat("{END_MARKER}\n")
flush.console()
"#,
            timeout_setup,
            path_lit = path_lit,
            plot_pattern_lit = plot_pattern_lit,
            END_MARKER = END_MARKER
        );

        self.stdin.write_all(wrapper.as_bytes())?;
        self.stdin.flush()?;

        let timeout = timeout_sec.map(std::time::Duration::from_secs);
        let start = std::time::Instant::now();

        let mut stdout_lines: Vec<String> = Vec::new();
        loop {
            match self.stdout_rx.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(line) => {
                    let trimmed = line.trim_end_matches(['\r', '\n']);
                    if trimmed == END_MARKER {
                        break;
                    }
                    stdout_lines.push(trimmed.to_string());
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(t) = timeout {
                        if start.elapsed() > t {
                            let _ = self.child.kill();
                            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "Execution timed out"));
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    break;
                }
            }
        }

        let _ = std::fs::remove_file(&script_path);

        let stdout = stdout_lines.join("\n");
        let stderr = self.stderr_acc.lock().unwrap_or_else(|e| e.into_inner()).clone();

        use base64::Engine;
        let mut image_paths = Vec::new();
        if let Ok(entries) = std::fs::read_dir(self.script_dir.path()) {
            let prefix = format!("plot_{}_{}_", ts, n);
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(file_name) = path.file_name().and_then(|s| s.to_str()) {
                    if file_name.starts_with(&prefix) && file_name.ends_with(".png") {
                        image_paths.push(path);
                    }
                }
            }
        }
        image_paths.sort();

        let mut images = Vec::new();
        for path in image_paths {
            if let Ok(meta) = path.metadata() {
                // 1024 bytes threshold to ignore empty blank plots if generated
                if meta.len() > 1024 {
                    if let Ok(bytes) = std::fs::read(&path) {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        images.push(format!("data:image/png;base64,{}", b64));
                    }
                }
            }
            let _ = std::fs::remove_file(&path);
        }

        Ok((stdout, stderr, images))
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
  .lines <- readLines("{path_lit}", encoding = "UTF-8", warn = FALSE)
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

        let timeout = std::time::Duration::from_secs(5); // completion timeout
        let start = std::time::Instant::now();

        let mut stdout_lines: Vec<String> = Vec::new();
        loop {
            match self.stdout_rx.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(line) => {
                    let trimmed = line.trim_end_matches(['\r', '\n']);
                    if trimmed == END_MARKER {
                        break;
                    }
                    stdout_lines.push(trimmed.to_string());
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if start.elapsed() > timeout {
                        let _ = self.child.kill();
                        return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "Completion timed out"));
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    break;
                }
            }
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

    pub fn evaluate(&self, code: &str, timeout_sec: Option<u64>) -> Result<(String, String, i32, Vec<String>), String> {
        self.ensure_session()?;
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        let session = guard.as_mut().ok_or("R session not available")?;

        match session.evaluate(code, timeout_sec) {
            Ok((stdout, stderr, images)) => {
                let stdout_err = stdout.starts_with("Error:");
                let stderr_fatal = stderr.contains("Execution halted");
                let ok = !stdout_err && !stderr_fatal;
                let exit_code = if ok { 0 } else { 1 };
                Ok((stdout, stderr, exit_code, images))
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
