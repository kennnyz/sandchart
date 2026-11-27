//! `build`: cargo build for wasm32-wasip2, then load the result in the host.

use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

use sandchart_indicators::{Limits, Meta, Runtime, is_user_id};

pub fn run(dir: &Path) -> Result<ExitCode, String> {
    if !dir.join("Cargo.toml").is_file() {
        return Err(format!("{} has no Cargo.toml", dir.display()));
    }
    let cargo = env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let output = Command::new(cargo)
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-wasip2",
            "--message-format=json-render-diagnostics",
        ])
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run cargo: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let _ = std::io::stderr().write_all(stderr.as_bytes());
    if !output.status.success() {
        if stderr.contains("wasm32-wasip2")
            && (stderr.contains("may not be installed") || stderr.contains("can't find crate"))
        {
            eprintln!(
                "hint: the wasm32-wasip2 target is missing; run: rustup target add wasm32-wasip2"
            );
        }
        return Err("cargo build failed".into());
    }
    let wasm = find_wasm(&String::from_utf8_lossy(&output.stdout)).ok_or(
        "cargo built nothing to load: set crate-type = [\"cdylib\"] under [lib] in Cargo.toml",
    )?;
    let bytes = fs::read(&wasm).map_err(|e| format!("cannot read {}: {e}", wasm.display()))?;
    let meta = check(&bytes)?;
    println!("ok {} {} → {}", meta.id, meta.version, wasm.display());
    Ok(ExitCode::SUCCESS)
}

/// Loads the built module in the host and checks its id, as the app does at install.
fn check(bytes: &[u8]) -> Result<Meta, String> {
    let runtime = Runtime::new(Limits::default(), None).map_err(|e| e.to_string())?;
    let module = runtime.load(bytes).map_err(|e| e.to_string())?;
    let meta = module.meta();
    if !is_user_id(&meta.id) {
        return Err(format!(
            "the indicator id {:?} is reserved: ids starting with \"builtin.\" belong to the \
             indicators that come with Sandchart, and the app will refuse to install it; give \
             yours an id like \"author.name\" in meta()",
            meta.id
        ));
    }
    Ok(meta.clone())
}

/// The `.wasm` of the last cdylib artifact in cargo's JSON messages.
fn find_wasm(stdout: &str) -> Option<PathBuf> {
    let mut found = None;
    for line in stdout.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v["reason"] != "compiler-artifact" {
            continue;
        }
        let is_cdylib = v["target"]["kind"]
            .as_array()
            .is_some_and(|k| k.iter().any(|k| k == "cdylib"));
        if !is_cdylib {
            continue;
        }
        for f in v["filenames"].as_array().into_iter().flatten() {
            if let Some(f) = f.as_str().filter(|f| f.ends_with(".wasm")) {
                found = Some(PathBuf::from(f));
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reserved_id_fails_the_check() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../indicators/target/wasm32-wasip2/release/builtin_sma.wasm");
        let bytes = fs::read(&path)
            .unwrap_or_else(|e| panic!("{}: {e}; build the guests first", path.display()));
        let err = check(&bytes).unwrap_err();
        assert!(
            err.contains("builtin.sma") && err.contains("reserved"),
            "{err}"
        );
    }

    #[test]
    fn picks_the_cdylib_wasm() {
        let out = concat!(
            r#"{"reason":"compiler-artifact","target":{"kind":["lib"]},"filenames":["/t/libdep.rlib"]}"#,
            "\n",
            r#"{"reason":"compiler-artifact","target":{"kind":["cdylib"]},"filenames":["/t/demo.wasm"]}"#,
            "\n",
            r#"{"reason":"build-finished","success":true}"#,
            "\n",
            "not json\n"
        );
        assert_eq!(find_wasm(out), Some(PathBuf::from("/t/demo.wasm")));
        assert_eq!(find_wasm("{}\n"), None);
    }
}
