//! Sandchart indicator host: loads indicator WebAssembly components
//! (`indicators/sdk/wit/indicator.wit`) and runs them in a sandbox with no
//! files, network, env or real clocks, under memory, fuel and time limits.
//!
//! [`Runtime::load`] compiles and checks a module; [`Module::compute`] runs it
//! over candles in a fresh sandbox each call. Inputs and outputs are `f64` in
//! price units; a value of NaN is a gap.

mod params;
mod sandbox;
mod validate;
mod wasi;

use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use wasmtime::Engine;
use wasmtime::component::{Component, Linker};

use sandbox::{HostState, PluginPre};

/// Fuel per `compute` call. Fuel counts executed instructions, so the limit is
/// the same on every machine.
pub const DEFAULT_FUEL: u64 = 5_000_000_000;

/// The largest module file accepted.
pub const MAX_MODULE_BYTES: usize = 20 * 1024 * 1024;

/// How often the epoch ticks; `Limits::deadline_ticks` counts these.
const EPOCH_TICK: Duration = Duration::from_millis(100);

/// Limits of one call into a module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Linear memory cap in bytes.
    pub memory_bytes: usize,
    /// Fuel per call, the deterministic limit.
    pub fuel: u64,
    /// Wall-time backstop in epoch ticks of 100 ms.
    pub deadline_ticks: u64,
}

impl Default for Limits {
    /// 256 MiB, [`DEFAULT_FUEL`], 10 s.
    fn default() -> Self {
        Self {
            memory_bytes: 256 * 1024 * 1024,
            fuel: DEFAULT_FUEL,
            deadline_ticks: 100,
        }
    }
}

/// One candle as an indicator sees it, in price units.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Bar {
    /// Open time, Unix milliseconds.
    pub time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

/// What a module declares about itself.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Meta {
    pub id: String,
    pub name: String,
    /// Semver version of the module.
    pub version: String,
    pub description: String,
    pub params: Vec<ParamSpec>,
    pub series: Vec<SeriesSpec>,
}

/// One parameter the user can set.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParamSpec {
    pub id: String,
    pub label: String,
    pub kind: ParamKind,
    pub default: ParamValue,
}

/// The type and allowed values of a parameter.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParamKind {
    /// An integer in `min..=max`.
    Int {
        min: i64,
        max: i64,
    },
    /// A float in `min..=max`.
    Float {
        min: f64,
        max: f64,
    },
    Boolean,
    /// One of these strings.
    Choice(Vec<String>),
}

/// A parameter value.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParamValue {
    Int(i64),
    Float(f64),
    Boolean(bool),
    Choice(String),
}

/// One output series a module declares.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SeriesSpec {
    pub id: String,
    pub label: String,
    pub kind: SeriesKind,
    pub pane: Pane,
    /// Palette slot, 0..=7.
    pub color: u8,
}

/// How a series is drawn.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SeriesKind {
    Line,
    Histogram,
    Markers,
    /// A fill between two line series of the same module, by id.
    Band(String, String),
}

/// Where a series is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Pane {
    /// Over the candles.
    Price,
    /// In a pane of its own under the chart.
    Own,
}

/// A mark at one bar.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Marker {
    /// Bar index into the candles passed to `compute`.
    pub index: u32,
    pub shape: MarkerShape,
    pub text: Option<String>,
}

/// The shape of a marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MarkerShape {
    Up,
    Down,
    Dot,
}

/// The data of one series after a compute.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SeriesOut {
    pub id: String,
    pub data: SeriesData,
}

/// Values (one per bar, NaN for a gap) or markers. A band carries empty values.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SeriesData {
    Values(Vec<f64>),
    Markers(Vec<Marker>),
}

/// The result of [`Module::compute`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Output {
    /// Every declared series once, in the order of [`Meta::series`].
    pub series: Vec<SeriesOut>,
    /// What the module wrote to stdout and stderr, cut to 16 KiB.
    pub log: String,
    /// Fuel the call used; the same for the same input.
    pub fuel_used: u64,
}

/// Why a module cannot be loaded.
#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error(
        "the module is larger than 20 MiB; build it in release mode and strip debug info \
         (strip = true in the release profile)"
    )]
    TooLarge,
    #[error("not an indicator component: {0}")]
    NotAComponent(String),
    #[error("the module does not implement {contract}: {0}", contract = sandbox::CONTRACT)]
    WrongContract(String),
    #[error(
        "the module imports {0}, which indicators may not use; only WASI 0.2 interfaces are \
         available, so remove the dependency that needs it"
    )]
    ForbiddenImport(String),
    #[error("invalid meta: {0}")]
    BadMeta(String),
    #[error("meta() failed: {0}")]
    Trap(String),
    #[error("cannot start the WebAssembly engine: {0}")]
    Engine(String),
}

/// Why a `compute` call gave no output.
#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error(
        "the indicator ran out of fuel: it did too much work in one call; look for an endless \
         loop or work that grows faster than the number of bars"
    )]
    OutOfFuel,
    #[error("the indicator ran past the time limit; look for an endless loop")]
    Timeout,
    #[error("the indicator hit the memory limit; allocate less, for example reuse buffers")]
    OutOfMemory,
    #[error("the indicator crashed: {0}")]
    Trap(String),
    #[error("the indicator returned an error: {0}")]
    Indicator(String),
    #[error("the indicator returned invalid output: {0}")]
    BadOutput(String),
}

/// SHA-256 of a module file, the key of its compiled copy in the cache.
pub fn module_hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Compiles, checks and caches modules. Owns the wasmtime engine and its
/// epoch ticker thread, which stops once the engine and all modules are gone.
pub struct Runtime {
    engine: Engine,
    linker: Linker<HostState>,
    limits: Limits,
    cache_dir: Option<PathBuf>,
    engine_hash: String,
}

impl Runtime {
    /// A runtime whose modules run under `limits`. With `cache_dir`, compiled
    /// modules are kept there between runs.
    pub fn new(limits: Limits, cache_dir: Option<PathBuf>) -> Result<Runtime, LoadError> {
        let engine = sandbox::engine()?;
        let linker = sandbox::linker(&engine)?;
        let weak = engine.weak();
        std::thread::Builder::new()
            .name("indicator-epoch".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(EPOCH_TICK);
                    match weak.upgrade() {
                        Some(engine) => engine.increment_epoch(),
                        None => break,
                    }
                }
            })
            .map_err(|e| LoadError::Engine(format!("cannot start the epoch thread: {e}")))?;
        let engine_hash = engine_hash(&engine);
        Ok(Runtime {
            engine,
            linker,
            limits,
            cache_dir,
            engine_hash,
        })
    }

    /// Compiles (or takes from the cache) and checks a module, and reads its meta.
    pub fn load(&self, bytes: &[u8]) -> Result<Module, LoadError> {
        if bytes.len() > MAX_MODULE_BYTES {
            return Err(LoadError::TooLarge);
        }
        check_header(bytes)?;
        let component = self.compile(bytes)?;
        let pre = sandbox::prepare(&self.engine, &self.linker, &component)?;
        let meta = sandbox::call_meta(&pre, &self.limits)?;
        validate::meta(&meta).map_err(LoadError::BadMeta)?;
        Ok(Module(Arc::new(ModuleInner {
            pre,
            meta,
            limits: self.limits,
        })))
    }

    /// Deletes cached compiled modules whose module hash is not in `keep` or
    /// that were compiled by another wasmtime build, and stray temp files.
    pub fn prune_cache(&self, keep: &[[u8; 32]]) -> io::Result<()> {
        let Some(dir) = &self.cache_dir else {
            return Ok(());
        };
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        let keep: Vec<String> = keep.iter().map(|h| hex(h)).collect();
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let stale = if name.ends_with(".tmp") {
                true
            } else if let Some(stem) = name.strip_suffix(".cwasm") {
                !stem.split_once('-').is_some_and(|(module, engine)| {
                    engine == self.engine_hash && keep.iter().any(|k| k == module)
                })
            } else {
                false
            };
            if stale {
                match fs::remove_file(entry.path()) {
                    Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                    _ => {}
                }
            }
        }
        Ok(())
    }

    /// Takes the compiled module from the cache, or compiles it and stores it
    /// there. Cache failures never fail a load; they only cost a compile.
    fn compile(&self, bytes: &[u8]) -> Result<Component, LoadError> {
        let compile = || {
            Component::new(&self.engine, bytes)
                .map_err(|e| LoadError::NotAComponent(format!("{e:#}")))
        };
        let Some(dir) = &self.cache_dir else {
            return compile();
        };
        let path = dir.join(format!(
            "{}-{}.cwasm",
            hex(&module_hash(bytes)),
            self.engine_hash
        ));
        if path.is_file() {
            // SAFETY: deserializing runs the machine code in the file. The
            // directory is the app's own cache, written only by `store_cached`
            // below; a tampered file there is equal to a tampered app binary.
            // The name carries the engine hash, and wasmtime checks the file's
            // header and engine settings before use.
            if let Ok(component) = unsafe { Component::deserialize_file(&self.engine, &path) } {
                return Ok(component);
            }
        }
        let component = compile()?;
        if let Ok(serialized) = component.serialize() {
            store_cached(dir, &path, &serialized);
        }
        Ok(component)
    }
}

/// Writes through a temp file and a rename, so another app instance never
/// reads a half-written file. Errors are ignored: the cache is optional.
fn store_cached(dir: &Path, path: &Path, data: &[u8]) {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_extension(format!(
        "cwasm.{}-{}.tmp",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let written = fs::create_dir_all(dir)
        .and_then(|()| fs::write(&tmp, data))
        .and_then(|()| fs::rename(&tmp, path));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/// Tells a core module or a non-wasm file from a component, with advice.
fn check_header(bytes: &[u8]) -> Result<(), LoadError> {
    match bytes.get(..8) {
        Some([0, b'a', b's', b'm', _, _, 1, 0]) => Ok(()),
        Some([0, b'a', b's', b'm', _, _, 0, 0]) => Err(LoadError::NotAComponent(
            "this is a core WebAssembly module; build the indicator with the sandchart-indicator \
             SDK for --target wasm32-wasip2, which produces a component"
                .into(),
        )),
        _ => Err(LoadError::NotAComponent(
            "the file is not WebAssembly (it does not start with \\0asm)".into(),
        )),
    }
}

/// A short hex digest of the engine's compatibility hash (wasmtime version,
/// settings and target), so files of another build are never tried.
fn engine_hash(engine: &Engine) -> String {
    struct ShaHasher(Sha256);
    impl Hasher for ShaHasher {
        fn write(&mut self, bytes: &[u8]) {
            self.0.update(bytes);
        }
        fn finish(&self) -> u64 {
            unreachable!("only the SHA-256 digest is read")
        }
    }
    let mut h = ShaHasher(Sha256::new());
    engine.precompile_compatibility_hash().hash(&mut h);
    hex(&h.0.finalize()[..16])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A loaded, checked module. Cheap to clone; every [`Module::compute`] runs
/// in a fresh sandbox, so calls share no state.
#[derive(Clone)]
pub struct Module(Arc<ModuleInner>);

struct ModuleInner {
    pre: PluginPre<HostState>,
    meta: Meta,
    limits: Limits,
}

impl Module {
    /// What the module declared, already checked.
    pub fn meta(&self) -> &Meta {
        &self.0.meta
    }

    /// One value per declared param: the saved value when it still fits, the
    /// default otherwise. Unknown saved ids are dropped.
    pub fn resolve_params(&self, saved: &[(String, ParamValue)]) -> Vec<(String, ParamValue)> {
        params::resolve(&self.0.meta.params, saved)
    }

    /// Runs the module over `candles` (oldest first). `params` go through
    /// [`Module::resolve_params`] first, so the module always gets all of
    /// them, in range.
    pub fn compute(
        &self,
        params: &[(String, ParamValue)],
        candles: &[Bar],
    ) -> Result<Output, RunError> {
        let params = self.resolve_params(params);
        let raw = sandbox::call_compute(&self.0.pre, &self.0.limits, &params, candles)?;
        let series = validate::output(&self.0.meta, raw.series, candles.len())
            .map_err(RunError::BadOutput)?;
        Ok(Output {
            series,
            log: raw.log,
            fuel_used: raw.fuel_used,
        })
    }
}
