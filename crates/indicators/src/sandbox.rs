//! The wasmtime side: engine settings, the WASI sandbox, one store per call,
//! conversion between the WIT bindings and the host types, and trap mapping.

use std::time::Duration;

use rand::SeedableRng;
use rand::rngs::Xoshiro256PlusPlus;
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{
    Config, Engine, ResourceLimiter, Store, StoreLimits, StoreLimitsBuilder, Trap, WasmBacktrace,
    WasmFeatures,
};
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::{HostMonotonicClock, HostWallClock, WasiCtx, WasiCtxView, WasiView};

use crate::{
    Bar, Limits, LoadError, Marker, MarkerShape, Meta, Pane, ParamKind, ParamSpec, ParamValue,
    RunError, SeriesData, SeriesKind, SeriesOut, SeriesSpec,
};

mod wit {
    wasmtime::component::bindgen!({
        path: "../../indicators/sdk/wit",
        world: "plugin",
    });
}

use wit::sandchart::indicator::types as w;

pub(crate) use wit::PluginPre;

/// The interface every indicator exports, with the version this host speaks.
pub(crate) const CONTRACT: &str = "sandchart:indicator/indicator@0.1.0";

/// Seed of both WASI random generators, so runs repeat exactly.
const RANDOM_SEED: u64 = 0x5A4D_C4A7;

/// Guest stdout and stderr kept per call before the log is cut.
const PIPE_BYTES: usize = 1024 * 1024;

/// The log returned in `Output` is cut to this size.
const LOG_BYTES: usize = 16 * 1024;

/// The engine: fuel and epochs on, NaN canonicalized, no relaxed SIMD and no
/// threads, so a module gives the same bits on every machine.
pub(crate) fn engine() -> Result<Engine, LoadError> {
    let mut config = Config::new();
    config
        .consume_fuel(true)
        .epoch_interruption(true)
        .cranelift_nan_canonicalization(true)
        .wasm_relaxed_simd(false)
        // `wasm_threads` exists only with wasmtime's `threads` feature, which
        // this crate leaves off; switch the proposal off explicitly anyway.
        .wasm_features(WasmFeatures::THREADS, false);
    Engine::new(&config).map_err(|e| LoadError::Engine(e.to_string()))
}

/// The linker with WASI 0.2 and nothing else.
pub(crate) fn linker(engine: &Engine) -> Result<Linker<HostState>, LoadError> {
    let mut linker = Linker::new(engine);
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker)
        .map_err(|e| LoadError::Engine(e.to_string()))?;
    Ok(linker)
}

/// Checks that the component imports only WASI 0.2 and exports the indicator
/// contract, then links it.
pub(crate) fn prepare(
    engine: &Engine,
    linker: &Linker<HostState>,
    component: &Component,
) -> Result<PluginPre<HostState>, LoadError> {
    let ty = component.component_type();
    for (name, _) in ty.imports(engine) {
        let wasi_02 = name
            .strip_prefix("wasi:")
            .and_then(|rest| rest.split_once('@'))
            .is_some_and(|(_, version)| version.starts_with("0.2."));
        // The contract's own `types` interface holds only types; the linker
        // has nothing to give for it, so a function in it would fail to link.
        let contract_types = name.starts_with("sandchart:indicator/types@");
        if !wasi_02 && !contract_types {
            return Err(LoadError::ForbiddenImport(name.to_string()));
        }
    }
    let exports: Vec<&str> = ty.exports(engine).map(|(name, _)| name).collect();
    if !exports
        .iter()
        .any(|n| n.starts_with("sandchart:indicator/indicator@"))
    {
        return Err(LoadError::WrongContract(format!(
            "it exports {exports:?} and no sandchart:indicator/indicator interface; implement the \
             SDK's Indicator trait and export it with export!"
        )));
    }
    let pre = linker
        .instantiate_pre(component)
        .map_err(|e| LoadError::ForbiddenImport(format!("{e:#}")))?;
    PluginPre::new(pre).map_err(|e| {
        LoadError::WrongContract(format!(
            "it exports {exports:?}, this host needs {CONTRACT} ({e:#}); rebuild it with \
             sandchart-indicator 0.1"
        ))
    })
}

/// Calls `meta` in a fresh sandbox.
pub(crate) fn call_meta(pre: &PluginPre<HostState>, limits: &Limits) -> Result<Meta, LoadError> {
    let (mut store, log) = new_store(pre.engine(), limits);
    let result = pre
        .instantiate(&mut store)
        .and_then(|p| p.sandchart_indicator_indicator().call_meta(&mut store));
    match result {
        Ok(m) => Ok(meta_from_wit(m)),
        Err(e) => Err(LoadError::Trap(
            run_error(e, &store, &log_text(&log)).to_string(),
        )),
    }
}

/// What one `compute` call gave back, before output validation.
pub(crate) struct RawOutput {
    pub series: Vec<SeriesOut>,
    pub log: String,
    pub fuel_used: u64,
}

/// Calls `compute` in a fresh sandbox.
pub(crate) fn call_compute(
    pre: &PluginPre<HostState>,
    limits: &Limits,
    params: &[(String, ParamValue)],
    candles: &[Bar],
) -> Result<RawOutput, RunError> {
    let params: Vec<(String, w::ParamValue)> = params
        .iter()
        .map(|(k, v)| (k.clone(), param_value_to_wit(v)))
        .collect();
    let candles: Vec<w::Candle> = candles
        .iter()
        .map(|b| w::Candle {
            time: b.time,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
        })
        .collect();

    let (mut store, log) = new_store(pre.engine(), limits);
    let result = pre.instantiate(&mut store).and_then(|p| {
        p.sandchart_indicator_indicator()
            .call_compute(&mut store, &params, &candles)
    });
    let log = log_text(&log);
    match result {
        Ok(Ok(series)) => Ok(RawOutput {
            series: series.into_iter().map(series_from_wit).collect(),
            fuel_used: limits.fuel - store.get_fuel().unwrap_or(0),
            log,
        }),
        Ok(Err(msg)) => Err(RunError::Indicator(msg)),
        Err(e) => Err(run_error(e, &store, &log)),
    }
}

/// Maps a wasmtime error to the reason an author can act on.
fn run_error(e: wasmtime::Error, store: &Store<HostState>, log: &str) -> RunError {
    match e.downcast_ref::<Trap>() {
        Some(Trap::OutOfFuel) => return RunError::OutOfFuel,
        Some(Trap::Interrupt) => return RunError::Timeout,
        _ => {}
    }
    if store.data().limiter.refused {
        return RunError::OutOfMemory;
    }
    // The cause first (for a Rust panic the output below holds the message
    // and the source line), then the wasm stack.
    let mut msg = e.root_cause().to_string();
    if !log.is_empty() {
        msg.push_str("\nindicator output:\n");
        msg.push_str(log.trim());
    }
    if let Some(trace) = e.downcast_ref::<WasmBacktrace>() {
        msg.push_str(&format!("\n{trace}"));
    }
    RunError::Trap(msg)
}

fn log_text(pipe: &MemoryOutputPipe) -> String {
    let bytes = pipe.contents();
    let mut text = String::from_utf8_lossy(&bytes[..bytes.len().min(LOG_BYTES)]).into_owned();
    if bytes.len() > LOG_BYTES {
        text.push_str("\n[log cut at 16 KiB]");
    }
    text
}

/// Store data: the WASI context and the memory limiter.
pub(crate) struct HostState {
    wasi: WasiCtx,
    table: ResourceTable,
    limiter: Limiter,
}

impl WasiView for HostState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

/// [`StoreLimits`] that remembers whether it refused memory, so the trap that
/// follows a failed allocation is reported as `OutOfMemory`.
struct Limiter {
    inner: StoreLimits,
    refused: bool,
}

impl ResourceLimiter for Limiter {
    fn memory_growing(
        &mut self,
        current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        let allowed = self.inner.memory_growing(current, desired, maximum)?;
        self.refused |= !allowed;
        Ok(allowed)
    }

    fn table_growing(
        &mut self,
        current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        self.inner.table_growing(current, desired, maximum)
    }
}

/// A clock that always reads 0.
struct ZeroClock;

impl HostWallClock for ZeroClock {
    fn resolution(&self) -> Duration {
        Duration::from_nanos(1)
    }
    fn now(&self) -> Duration {
        Duration::ZERO
    }
}

impl HostMonotonicClock for ZeroClock {
    fn resolution(&self) -> u64 {
        1
    }
    fn now(&self) -> u64 {
        0
    }
}

/// A store for one call: no args, env, files or network; clocks at 0; seeded
/// random; stdout and stderr into one memory pipe; memory, fuel and epoch limits.
fn new_store(engine: &Engine, limits: &Limits) -> (Store<HostState>, MemoryOutputPipe) {
    let log = MemoryOutputPipe::new(PIPE_BYTES);
    let wasi = WasiCtx::builder()
        .stdout(log.clone())
        .stderr(log.clone())
        .allow_tcp(false)
        .allow_udp(false)
        .allow_ip_name_lookup(false)
        .wall_clock(ZeroClock)
        .monotonic_clock(ZeroClock)
        .secure_random(Xoshiro256PlusPlus::seed_from_u64(RANDOM_SEED))
        .insecure_random(Xoshiro256PlusPlus::seed_from_u64(RANDOM_SEED))
        .insecure_random_seed(u128::from(RANDOM_SEED))
        .build();
    let state = HostState {
        wasi,
        table: ResourceTable::new(),
        limiter: Limiter {
            inner: StoreLimitsBuilder::new()
                .memory_size(limits.memory_bytes)
                .build(),
            refused: false,
        },
    };
    let mut store = Store::new(engine, state);
    store.limiter(|s| &mut s.limiter);
    store
        .set_fuel(limits.fuel)
        .expect("the engine is configured with consume_fuel");
    store.set_epoch_deadline(limits.deadline_ticks);
    (store, log)
}

fn param_value_to_wit(v: &ParamValue) -> w::ParamValue {
    match v {
        ParamValue::Int(v) => w::ParamValue::Int(*v),
        ParamValue::Float(v) => w::ParamValue::Float(*v),
        ParamValue::Boolean(v) => w::ParamValue::Boolean(*v),
        ParamValue::Choice(v) => w::ParamValue::Choice(v.clone()),
    }
}

fn param_value_from_wit(v: w::ParamValue) -> ParamValue {
    match v {
        w::ParamValue::Int(v) => ParamValue::Int(v),
        w::ParamValue::Float(v) => ParamValue::Float(v),
        w::ParamValue::Boolean(v) => ParamValue::Boolean(v),
        w::ParamValue::Choice(v) => ParamValue::Choice(v),
    }
}

fn meta_from_wit(m: w::Meta) -> Meta {
    Meta {
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description,
        params: m
            .params
            .into_iter()
            .map(|p| ParamSpec {
                id: p.id,
                label: p.label,
                kind: match p.kind {
                    w::ParamKind::Int((min, max)) => ParamKind::Int { min, max },
                    w::ParamKind::Float((min, max)) => ParamKind::Float { min, max },
                    w::ParamKind::Boolean => ParamKind::Boolean,
                    w::ParamKind::Choice(options) => ParamKind::Choice(options),
                },
                default: param_value_from_wit(p.default),
            })
            .collect(),
        series: m
            .series
            .into_iter()
            .map(|s| SeriesSpec {
                id: s.id,
                label: s.label,
                kind: match s.kind {
                    w::SeriesKind::Line => SeriesKind::Line,
                    w::SeriesKind::Histogram => SeriesKind::Histogram,
                    w::SeriesKind::Markers => SeriesKind::Markers,
                    w::SeriesKind::Band((a, b)) => SeriesKind::Band(a, b),
                },
                pane: match s.pane {
                    w::Pane::Price => Pane::Price,
                    w::Pane::Own => Pane::Own,
                },
                color: s.color,
            })
            .collect(),
    }
}

fn series_from_wit(s: w::SeriesOut) -> SeriesOut {
    SeriesOut {
        id: s.id,
        data: match s.data {
            w::SeriesData::Values(v) => SeriesData::Values(v),
            w::SeriesData::Markers(m) => SeriesData::Markers(
                m.into_iter()
                    .map(|m| Marker {
                        index: m.index,
                        shape: match m.shape {
                            w::MarkerShape::Up => MarkerShape::Up,
                            w::MarkerShape::Down => MarkerShape::Down,
                            w::MarkerShape::Dot => MarkerShape::Dot,
                        },
                        text: m.text,
                    })
                    .collect(),
            ),
        },
    }
}
