use crate::r_session::RSessionHandle;
use serde::Serialize;
use std::path::Path;
use std::sync::OnceLock;
use tauri::AppHandle;



static R_SESSION: OnceLock<RSessionHandle> = OnceLock::new();

fn find_r() -> Option<String> {
    if let Ok(path) = std::env::var("RLAB_R_PATH") {
        if Path::new(&path).exists() && (path.ends_with("R.exe") || path.ends_with("R")) {
            let mut cmd = std::process::Command::new(&path);
            cmd.arg("--version");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }
            if let Ok(output) = cmd.output() {
                if String::from_utf8_lossy(&output.stdout).contains("R version") {
                    return Some(path);
                }
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(r"C:\Program Files\R") {
        let mut versions = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let r_exe = path.join("bin").join("x64").join("R.exe");
                if r_exe.exists() {
                    versions.push(r_exe);
                }
            }
        }
        versions.sort_by(|a, b| b.cmp(a));
        if let Some(p) = versions.first() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    None
}

pub fn init_r_session(_app: &AppHandle) {
    if let Some(r_path) = find_r() {
        let handle = RSessionHandle::new(r_path);
        let _ = R_SESSION.set(handle);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RHealth {
    pub r_found: bool,
}

#[tauri::command]
pub fn r_health() -> RHealth {
    RHealth {
        r_found: find_r().is_some(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RExecuteResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[serde(default)]
    pub images_base64: Vec<String>,
}

#[tauri::command]
pub fn r_execute(code: String, timeout_sec: Option<u64>) -> RExecuteResult {
    let code = code.trim();
    if code.is_empty() {
        return RExecuteResult {
            ok: false,
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 1,
            error: Some("コードが空です".into()),
            images_base64: vec![],
        };
    }

    let Some(session) = R_SESSION.get() else {
        return RExecuteResult {
            ok: false,
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 1,
            error: Some(
                "R が見つかりません。環境変数 RLAB_R_PATH で R.exe を指定してください。".into(),
            ),
            images_base64: vec![],
        };
    };

    match session.evaluate(code, timeout_sec) {
        Ok((stdout, stderr, exit_code, images_base64)) => RExecuteResult {
            ok: exit_code == 0,
            stdout,
            stderr,
            exit_code,
            error: None,
            images_base64,
        },
        Err(e) => {
            eprintln!("R execution error: {}", e);
            RExecuteResult {
                ok: false,
                stdout: String::new(),
                stderr: "Internal execution error".into(),
                exit_code: 1,
                error: Some("Failed to evaluate R code".into()),
                images_base64: vec![],
            }
        }
    }
}

#[tauri::command]
pub fn r_complete(
    prefix: String,
    limit: Option<u32>,
    functions_only: Option<bool>,
) -> Vec<String> {
    let limit = limit.unwrap_or(50).clamp(1, 200) as usize;
    let functions_only = functions_only.unwrap_or(true);
    let Some(session) = R_SESSION.get() else {
        return vec![];
    };
    match session.complete(prefix.trim(), limit, functions_only) {
        Ok(v) => v,
        Err(_) => vec![],
    }
}
