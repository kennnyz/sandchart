//! Runs the `sandchart-indicator` binary against the guests built from
//! `indicators/`. Build them first:
//! `cargo build --manifest-path indicators/Cargo.toml --target wasm32-wasip2 --release`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn guest(file: &str) -> PathBuf {
    let path = root()
        .join("indicators/target/wasm32-wasip2/release")
        .join(file);
    assert!(
        path.is_file(),
        "{} is missing; build the guests first (see the top of this file)",
        path.display()
    );
    path
}

fn cli() -> Command {
    Command::new(env!("CARGO_BIN_EXE_sandchart-indicator"))
}

fn run(args: &[&str]) -> Output {
    cli().args(args).output().unwrap()
}

fn out(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn err(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

fn path_str(p: &Path) -> String {
    p.to_str().unwrap().to_string()
}

#[test]
fn test_prints_meta_and_exits_zero() {
    let sma = path_str(&guest("builtin_sma.wasm"));
    let o = run(&["test", &sma]);
    assert!(o.status.success(), "{}", err(&o));
    let s = out(&o);
    assert!(s.contains("builtin.sma"), "{s}");
    assert!(s.contains("fuel"), "{s}");
    assert!(s.contains("deterministic"), "{s}");
    assert!(!s.contains("warning"), "{s}");
}

#[test]
fn json_has_the_documented_fields_and_no_repaint() {
    let sma = path_str(&guest("builtin_sma.wasm"));
    let o = run(&["test", &sma, "--json"]);
    assert!(o.status.success(), "{}", err(&o));
    let v: serde_json::Value = serde_json::from_str(&out(&o)).unwrap();
    assert_eq!(v["id"], "builtin.sma");
    assert!(v["version"].is_string());
    assert!(v["fuel_used"].as_u64().unwrap() > 0);
    assert!(v["fuel_percent"].as_f64().unwrap() > 0.0);
    assert!(v["log"].is_string());
    assert_eq!(v["deterministic"], true);
    assert!(v["repaints"].is_null());
    assert_eq!(v["errors"], serde_json::json!([]));
    let series = v["series"].as_array().unwrap();
    assert!(!series.is_empty());
    assert_eq!(series[0]["last"].as_array().unwrap().len(), 5);
}

#[test]
fn repainting_guest_gives_a_warning_and_exit_zero() {
    let g = path_str(&guest("testguest_repaints.wasm"));
    let o = run(&["test", &g]);
    assert!(o.status.success(), "{}", err(&o));
    assert!(
        out(&o).contains("warning: repaints (series \"max\", first difference at bar "),
        "{}",
        out(&o)
    );
    let o = run(&["test", &g, "--json"]);
    assert!(o.status.success());
    let v: serde_json::Value = serde_json::from_str(&out(&o)).unwrap();
    assert_eq!(v["repaints"]["series"], "max");
    assert!(v["repaints"]["index"].is_u64());
}

#[test]
fn bad_output_exits_one_with_the_reason() {
    let g = path_str(&guest("testguest_bad_output.wasm"));
    let o = run(&["test", &g]);
    assert_eq!(o.status.code(), Some(1));
    assert!(err(&o).contains("invalid output"), "{}", err(&o));
    let o = run(&["test", &g, "--json"]);
    assert_eq!(o.status.code(), Some(1));
    let v: serde_json::Value = serde_json::from_str(&out(&o)).unwrap();
    assert!(
        v["errors"][0].as_str().unwrap().contains("invalid output"),
        "{v}"
    );
}

#[test]
fn bad_param_names_the_param() {
    let sma = path_str(&guest("builtin_sma.wasm"));
    let o = run(&["test", &sma, "--param", "period=abc"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(err(&o).contains("period"), "{}", err(&o));
    let o = run(&["test", &sma, "--param", "nope=1"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(err(&o).contains("nope"), "{}", err(&o));
    let o = run(&["test", &sma, "--param", "period=0"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(err(&o).contains("period"), "{}", err(&o));
}

#[test]
fn param_changes_the_output() {
    let sma = path_str(&guest("builtin_sma.wasm"));
    let a = run(&["test", &sma, "--json"]);
    let b = run(&["test", &sma, "--json", "--param", "period=5"]);
    assert!(b.status.success(), "{}", err(&b));
    assert_ne!(out(&a), out(&b));
}

#[test]
fn csv_is_used_and_errors_carry_the_line() {
    let dir = tempfile::tempdir().unwrap();
    let sma = path_str(&guest("builtin_sma.wasm"));
    let good = dir.path().join("good.csv");
    let mut text = String::from("time,open,high,low,close,volume\n");
    for i in 0..50 {
        text += &format!(
            "{},{i}.0,{i}.5,{i}.0,{i}.2,10\n",
            1_700_000_000_000i64 + i * 60_000
        );
    }
    fs::write(&good, text).unwrap();
    let o = run(&["test", &sma, "--csv", &path_str(&good), "--json"]);
    assert!(o.status.success(), "{}", err(&o));
    let v: serde_json::Value = serde_json::from_str(&out(&o)).unwrap();
    assert_eq!(v["bars"], 50);

    let bad = dir.path().join("bad.csv");
    fs::write(
        &bad,
        "time,open,high,low,close,volume\n1,1,1,1,1,1\n2,1,x,1,1,1\n",
    )
    .unwrap();
    let o = run(&["test", &sma, "--csv", &path_str(&bad)]);
    assert_eq!(o.status.code(), Some(1));
    assert!(err(&o).contains("line 3"), "{}", err(&o));

    let nohead = dir.path().join("nohead.csv");
    fs::write(&nohead, "1,1,1,1,1,1\n").unwrap();
    let o = run(&["test", &sma, "--csv", &path_str(&nohead)]);
    assert_eq!(o.status.code(), Some(1));
    assert!(err(&o).contains("line 1"), "{}", err(&o));
}

#[test]
fn missing_file_and_non_wasm_exit_one() {
    let o = run(&["test", "/nonexistent/x.wasm"]);
    assert_eq!(o.status.code(), Some(1));
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("x.wasm");
    fs::write(&f, "hello").unwrap();
    let o = run(&["test", &path_str(&f)]);
    assert_eq!(o.status.code(), Some(1));
    assert!(err(&o).contains("not WebAssembly"), "{}", err(&o));
}

#[test]
fn new_creates_the_project() {
    let dir = tempfile::tempdir().unwrap();
    let o = cli()
        .args(["new", "demo"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", err(&o));
    let p = dir.path().join("demo");
    for f in [
        "Cargo.toml",
        "src/lib.rs",
        "AGENTS.md",
        "README.md",
        ".gitignore",
        "rust-toolchain.toml",
    ] {
        assert!(p.join(f).is_file(), "{f} missing");
    }
    let manifest = fs::read_to_string(p.join("Cargo.toml")).unwrap();
    assert!(manifest.contains("name = \"demo\""), "{manifest}");
    assert!(
        manifest.contains("sandchart-indicator = { git"),
        "{manifest}"
    );
    assert!(
        fs::read_to_string(p.join("src/lib.rs"))
            .unwrap()
            .contains("local.demo")
    );
    // A second run refuses to overwrite.
    let o = cli()
        .args(["new", "demo"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(err(&o).contains("already exists"), "{}", err(&o));
}

#[test]
fn new_rejects_bad_names() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["Demo", "1demo", "a.b", "", "../x"] {
        let o = cli()
            .args(["new", name])
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert_eq!(o.status.code(), Some(1), "{name}");
    }
}

/// The whole author loop (new, build, test) against the local SDK. Needs the network for the
/// SDK's crates.io dependencies and the wasm32-wasip2 target; CI runs it with
/// `-- --ignored`.
#[test]
#[ignore]
fn new_build_test_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let o = cli()
        .args(["new", "demo"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", err(&o));
    let project = dir.path().join("demo");

    let sdk = root().join("indicators/sdk").canonicalize().unwrap();
    // A `[patch]` would still make cargo fetch the git tag, which does not
    // exist until the release is tagged, so point the dependency at the local
    // SDK instead.
    let manifest = fs::read_to_string(project.join("Cargo.toml")).unwrap();
    let git_dep = manifest
        .lines()
        .find(|l| l.starts_with("sandchart-indicator = { git"))
        .expect("the template names the SDK by git tag");
    let manifest = manifest.replace(
        git_dep,
        &format!("sandchart-indicator = {{ path = '{}' }}", sdk.display()),
    );
    fs::write(project.join("Cargo.toml"), manifest).unwrap();

    let o = run(&["build", "--path", &path_str(&project)]);
    assert!(o.status.success(), "{}{}", out(&o), err(&o));
    assert!(out(&o).contains("ok local.demo 0.1.0"), "{}", out(&o));

    let wasm = project.join("target/wasm32-wasip2/release/demo.wasm");
    assert!(wasm.is_file());
    let o = run(&["test", &path_str(&wasm), "--json"]);
    assert!(o.status.success(), "{}{}", out(&o), err(&o));
    let v: serde_json::Value = serde_json::from_str(&out(&o)).unwrap();
    assert_eq!(v["id"], "local.demo");
    assert!(v["repaints"].is_null(), "{v}");
    assert_eq!(v["deterministic"], true);
    let series = v["series"].as_array().unwrap();
    assert_eq!(series.len(), 3);
}
