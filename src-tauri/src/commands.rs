use crate::r_session::RSessionHandle;
use serde::Serialize;
use std::path::Path;
use std::sync::OnceLock;
use tauri::AppHandle;

const DEFAULT_R: &str = r"C:\Program Files\R\R-4.5.0\bin\x64\R.exe";

static R_SESSION: OnceLock<RSessionHandle> = OnceLock::new();

fn find_r() -> Option<String> {
    if let Ok(path) = std::env::var("RLAB_R_PATH") {
        if Path::new(&path).exists() {
            return Some(path);
        }
    }
    if Path::new(DEFAULT_R).exists() {
        return Some(DEFAULT_R.to_string());
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
    pub r_path: Option<String>,
}

#[tauri::command]
pub fn r_health() -> RHealth {
    let r_path = find_r();
    RHealth {
        r_found: r_path.is_some(),
        r_path,
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
}

#[tauri::command]
pub fn r_execute(code: String) -> RExecuteResult {
    let code = code.trim();
    if code.is_empty() {
        return RExecuteResult {
            ok: false,
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 1,
            error: Some("コードが空です".into()),
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
        };
    };

    match session.evaluate(code) {
        Ok((stdout, stderr, exit_code)) => RExecuteResult {
            ok: exit_code == 0,
            stdout,
            stderr,
            exit_code,
            error: None,
        },
        Err(e) => RExecuteResult {
            ok: false,
            stdout: String::new(),
            stderr: e.clone(),
            exit_code: 1,
            error: Some(e),
        },
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
