//! Runs the test guests from `indicators/testguests` through the sandboxed runtime.

use std::path::{Path, PathBuf};

use sandchart_indicators::{
    Bar, Limits, LoadError, Module, Output, ParamValue, RunError, Runtime, SeriesData, SeriesKind,
    module_hash,
};

fn guest_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../indicators/target/wasm32-wasip2/release")
        .join(format!("testguest_{name}.wasm"))
}

fn guest(name: &str) -> Vec<u8> {
    let path = guest_path(name);
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read {}: {e}. Build the test guests first: \
             cargo build --manifest-path indicators/Cargo.toml --target wasm32-wasip2 --release",
            path.display()
        )
    })
}

fn runtime() -> Runtime {
    Runtime::new(Limits::default(), None).unwrap()
}

fn load(name: &str) -> Module {
    runtime().load(&guest(name)).unwrap()
}

fn bars(closes: &[f64]) -> Vec<Bar> {
    closes
        .iter()
        .enumerate()
        .map(|(i, &c)| Bar {
            time: i as i64 * 60_000,
            open: c,
            high: c + 1.0,
            low: c - 1.0,
            close: c,
            volume: 10.0,
        })
        .collect()
}

fn values(data: &SeriesData) -> &[f64] {
    match data {
        SeriesData::Values(v) => v,
        SeriesData::Markers(_) => panic!("expected values, got markers"),
    }
}

fn indicator_error(name: &str) -> String {
    match load(name).compute(&[], &bars(&[1.0])) {
        Err(RunError::Indicator(msg)) => msg,
        other => panic!("expected an indicator error, got {other:?}"),
    }
}

#[test]
fn loads_ok_echo_and_reads_meta() {
    let m = load("ok_echo");
    let meta = m.meta();
    assert_eq!(meta.id, "test.echo");
    assert_eq!(meta.version, "0.1.0");
    assert_eq!(meta.series.len(), 1);
    assert_eq!(meta.series[0].id, "close");
    assert!(matches!(meta.series[0].kind, SeriesKind::Line));
}

#[test]
fn ok_echo_returns_close() {
    let out = load("ok_echo")
        .compute(&[], &bars(&[1.5, 2.5, 3.5]))
        .unwrap();
    assert_eq!(out.series.len(), 1);
    assert_eq!(out.series[0].id, "close");
    assert_eq!(values(&out.series[0].data), &[1.5, 2.5, 3.5]);
    assert!(out.fuel_used > 0);
    assert!(out.log.contains("echo 3 bars"), "log: {:?}", out.log);
    assert!(out.log.contains("echo done"), "log: {:?}", out.log);
}

#[test]
fn same_input_same_output() {
    let m = load("repaints");
    let input = bars(&[3.0, 1.0, 4.0, 1.0, 5.0]);
    let a = m.compute(&[], &input).unwrap();
    let b = m.compute(&[], &input).unwrap();
    let bits = |o: &Output| -> Vec<u64> {
        values(&o.series[0].data)
            .iter()
            .map(|v| v.to_bits())
            .collect()
    };
    assert_eq!(bits(&a), bits(&b));
    assert_eq!(values(&a.series[0].data), &[5.0; 5]);
    assert_eq!(a.fuel_used, b.fuel_used);
}

#[test]
fn loop_forever_runs_out_of_fuel() {
    let rt = Runtime::new(
        Limits {
            fuel: 10_000_000,
            ..Limits::default()
        },
        None,
    )
    .unwrap();
    let m = rt.load(&guest("loop_forever")).unwrap();
    // Without the param it does not spin.
    m.compute(&[], &bars(&[1.0])).unwrap();
    let spin = [("spin".to_string(), ParamValue::Boolean(true))];
    assert!(matches!(
        m.compute(&spin, &bars(&[1.0])),
        Err(RunError::OutOfFuel)
    ));
}

#[test]
fn loop_forever_times_out_without_a_fuel_limit() {
    let rt = Runtime::new(
        Limits {
            fuel: u64::MAX,
            deadline_ticks: 2,
            ..Limits::default()
        },
        None,
    )
    .unwrap();
    let m = rt.load(&guest("loop_forever")).unwrap();
    let spin = [("spin".to_string(), ParamValue::Boolean(true))];
    assert!(matches!(
        m.compute(&spin, &bars(&[1.0])),
        Err(RunError::Timeout)
    ));
}

#[test]
fn alloc_bomb_hits_memory_limit() {
    let rt = Runtime::new(
        Limits {
            memory_bytes: 16 * 1024 * 1024,
            ..Limits::default()
        },
        None,
    )
    .unwrap();
    let m = rt.load(&guest("alloc_bomb")).unwrap();
    match m.compute(&[], &bars(&[1.0])) {
        Err(RunError::OutOfMemory) => {}
        Err(RunError::Trap(msg)) if msg.contains("memory") => {}
        other => panic!("expected out of memory, got {other:?}"),
    }
}

#[test]
fn panic_is_a_trap_and_app_survives() {
    let rt = runtime();
    let m = rt.load(&guest("panics")).unwrap();
    match m.compute(&[], &bars(&[1.0])) {
        Err(RunError::Trap(msg)) => assert!(msg.contains("boom"), "trap: {msg}"),
        other => panic!("expected a trap, got {other:?}"),
    }
    let echo = rt.load(&guest("ok_echo")).unwrap();
    let out = echo.compute(&[], &bars(&[7.0])).unwrap();
    assert_eq!(values(&out.series[0].data), &[7.0]);
}

#[test]
fn returns_err_is_indicator_error() {
    assert_eq!(indicator_error("returns_err"), "bad period");
}

#[test]
fn reads_file_sees_no_files() {
    // The guest returns `io::Error::kind()`; with no preopened directory the
    // path does not exist for it.
    assert_eq!(indicator_error("reads_file"), "NotFound");
}

#[test]
fn opens_socket_is_refused() {
    assert_eq!(indicator_error("opens_socket"), "PermissionDenied");
}

/// Runs `compute` on another thread and fails the test if it does not return
/// within `secs`, so a hang shows up as a failure instead of a stuck test run.
fn compute_within(m: Module, input: Vec<Bar>, secs: u64) -> Result<Output, RunError> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(m.compute(&[], &input));
    });
    rx.recv_timeout(std::time::Duration::from_secs(secs))
        .expect("compute did not return: a host call blocked the thread")
}

#[test]
fn sleep_returns_at_once() {
    let started = std::time::Instant::now();
    let out = compute_within(load("sleeps"), bars(&[1.0, 2.0]), 5).unwrap();
    assert_eq!(values(&out.series[0].data), &[1.0, 2.0]);
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}

#[test]
fn long_log_is_cut_not_a_trap() {
    let out = load("logs_a_lot").compute(&[], &bars(&[1.0])).unwrap();
    assert_eq!(values(&out.series[0].data), &[1.0]);
    assert!(out.log.starts_with("line 000000 "), "{:?}", &out.log[..40]);
    assert!(
        out.log.len() <= 16 * 1024 + 64,
        "log is {} bytes",
        out.log.len()
    );
    assert!(out.log.len() >= 16 * 1024, "log is {} bytes", out.log.len());
}

#[test]
fn random_is_seeded() {
    let input = bars(&[1.0, 2.0, 3.0]);
    let a = load("reads_random").compute(&[], &input).unwrap();
    let b = load("reads_random").compute(&[], &input).unwrap();
    let c = runtime()
        .load(&guest("reads_random"))
        .unwrap()
        .compute(&[], &input)
        .unwrap();
    assert_eq!(a.series, b.series);
    assert_eq!(a.series, c.series);
    let v = values(&a.series[0].data);
    assert_eq!(v[2], f64::from(0x5A4D_C4A7_u32), "insecure seed");
    assert_ne!(v[0], 0.0);
}

#[test]
fn env_and_args_are_empty() {
    let out = load("reads_env").compute(&[], &bars(&[1.0, 2.0])).unwrap();
    assert_eq!(values(&out.series[0].data), &[0.0, 0.0]);
}

#[test]
fn resource_spam_is_stopped() {
    let rt = runtime();
    match compute_within(
        rt.load(&guest("spams_resources")).unwrap(),
        bars(&[1.0]),
        30,
    ) {
        Err(RunError::Trap(msg)) => assert!(msg.contains("10000 WASI handles"), "{msg}"),
        other => panic!("expected a trap, got {other:?}"),
    }
    let echo = rt.load(&guest("ok_echo")).unwrap();
    assert!(echo.compute(&[], &bars(&[1.0])).is_ok());
}

#[test]
fn clock_is_zero() {
    let out = load("reads_clock")
        .compute(&[], &bars(&[1.0, 2.0]))
        .unwrap();
    assert_eq!(values(&out.series[0].data), &[0.0, 0.0]);
}

#[test]
fn bad_meta_rejected() {
    match runtime().load(&guest("bad_meta")) {
        Err(LoadError::BadMeta(msg)) => assert!(msg.contains("lower"), "{msg}"),
        other => panic!("expected BadMeta, got {:?}", other.err()),
    }
}

#[test]
fn bad_output_rejected() {
    assert!(matches!(
        load("bad_output").compute(&[], &bars(&[1.0, 2.0, 3.0])),
        Err(RunError::BadOutput(_))
    ));
}

#[test]
fn inf_becomes_nan() {
    let out = load("returns_inf")
        .compute(&[], &bars(&[1.0, 2.0, 3.0]))
        .unwrap();
    let v = values(&out.series[0].data);
    assert_eq!(v.len(), 3);
    assert!(v.iter().all(|x| x.is_nan()), "{v:?}");
}

#[test]
fn core_module_rejected() {
    assert!(matches!(
        runtime().load(b"\0asm\x01\0\0\0"),
        Err(LoadError::NotAComponent(_))
    ));
    assert!(matches!(
        runtime().load(b"not wasm at all"),
        Err(LoadError::NotAComponent(_))
    ));
}

#[test]
fn too_large_rejected() {
    assert!(matches!(
        runtime().load(&vec![0u8; 21 * 1024 * 1024]),
        Err(LoadError::TooLarge)
    ));
}

#[test]
fn forbidden_import_rejected() {
    match runtime().load(&guest("imports_host")) {
        Err(LoadError::ForbiddenImport(msg)) => assert!(msg.contains("secret"), "{msg}"),
        other => panic!("expected ForbiddenImport, got {:?}", other.err()),
    }
}

#[test]
fn wrong_version_rejected() {
    match runtime().load(&guest("wrong_version")) {
        Err(LoadError::WrongContract(msg)) => assert!(msg.contains("0.2.0"), "{msg}"),
        other => panic!("expected WrongContract, got {:?}", other.err()),
    }
}

/// A guest built against a newer patch of the contract (0.1.1) on this 0.1.0 host.
/// The test records what wasmtime does; ADR 0002 explains the rule.
#[test]
fn newer_patch_version_is_accepted() {
    let m = load("newer_patch");
    let out = m.compute(&[], &bars(&[1.0, 2.0])).unwrap();
    assert_eq!(values(&out.series[0].data), &[1.0, 2.0]);
}

#[test]
fn empty_candles() {
    let out = load("ok_echo").compute(&[], &[]).unwrap();
    assert_eq!(out.series.len(), 1);
    assert!(values(&out.series[0].data).is_empty());
}

fn cache_files(dir: &Path) -> Vec<(PathBuf, std::time::SystemTime)> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            (e.path(), e.metadata().unwrap().modified().unwrap())
        })
        .collect();
    files.sort();
    files
}

#[test]
fn compile_cache_hit() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = guest("ok_echo");
    let rt = Runtime::new(Limits::default(), Some(dir.path().to_path_buf())).unwrap();
    let first = rt.load(&bytes).unwrap();
    let files = cache_files(dir.path());
    assert_eq!(files.len(), 1, "{files:?}");
    assert!(files[0].0.extension().is_some_and(|e| e == "cwasm"));

    let rt2 = Runtime::new(Limits::default(), Some(dir.path().to_path_buf())).unwrap();
    let second = rt2.load(&bytes).unwrap();
    assert_eq!(cache_files(dir.path()), files);
    assert_eq!(first.meta().id, second.meta().id);
    let input = bars(&[1.0, 2.0]);
    assert_eq!(
        values(&first.compute(&[], &input).unwrap().series[0].data),
        values(&second.compute(&[], &input).unwrap().series[0].data)
    );
}

#[test]
fn compile_cache_corrupt_file_recovers() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = guest("ok_echo");
    let rt = Runtime::new(Limits::default(), Some(dir.path().to_path_buf())).unwrap();
    rt.load(&bytes).unwrap();
    let path = cache_files(dir.path()).remove(0).0;
    std::fs::write(&path, b"garbage").unwrap();

    let m = rt.load(&bytes).unwrap();
    assert_eq!(m.meta().id, "test.echo");
    assert_ne!(std::fs::read(&path).unwrap(), b"garbage");
    assert_eq!(cache_files(dir.path()).len(), 1);
}

#[test]
fn prune_cache_keeps_only_listed() {
    let dir = tempfile::tempdir().unwrap();
    let rt = Runtime::new(Limits::default(), Some(dir.path().to_path_buf())).unwrap();
    let echo = guest("ok_echo");
    rt.load(&echo).unwrap();
    rt.load(&guest("repaints")).unwrap();
    // A file from another wasmtime build of a kept module, and a stray temp file.
    let hex: String = module_hash(&echo)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    std::fs::write(dir.path().join(format!("{hex}-00.cwasm")), b"old").unwrap();
    std::fs::write(dir.path().join("x.cwasm.tmp"), b"half").unwrap();
    std::fs::write(dir.path().join("notes.txt"), b"keep me").unwrap();
    assert_eq!(cache_files(dir.path()).len(), 5);

    rt.prune_cache(&[module_hash(&echo)]).unwrap();
    let left: Vec<String> = cache_files(dir.path())
        .into_iter()
        .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left.len(), 2, "{left:?}");
    assert!(left.contains(&"notes.txt".to_string()));
    assert!(
        left.iter()
            .any(|n| n.starts_with(&hex) && n.ends_with(".cwasm") && !n.ends_with("-00.cwasm"))
    );
}
