//! The wasmtime side: engine settings, the WASI sandbox, one store per call,
//! conversion between the WIT bindings and the host types, and trap mapping.

use std::time::Duration;

use rand::SeedableRng;
use rand::rngs::Xoshiro256PlusPlus;
use wasmtime::component::{Component, Linker, ResourceTable, ResourceTableError};
use wasmtime::{Config, Engine, ResourceLimiter, Store, Trap, WasmBacktrace, WasmFeatures};
use wasmtime_wasi::{HostWallClock, WasiCtx, WasiCtxView, WasiView};

use crate::validate::shown;
use crate::wasi::{LogPipe, add_frozen_clock};

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

/// The log returned in `Output` is cut to this size; the rest is dropped.
const LOG_BYTES: usize = 16 * 1024;

/// An error message returned by `compute` is cut to this size.
const ERROR_BYTES: usize = 1024;

/// Bytes the host may copy out of the guest in one call (wasmtime's hostcall
/// fuel, which bounds what the host allocates for the returned lists and
/// strings). The largest valid output is 100 000 bars x 64 series x 8 bytes,
/// about 49 MiB; 64 MiB leaves room for markers, ids and the log. wasmtime's
/// default is 128 MiB.
const HOSTCALL_BYTES: usize = 64 * 1024 * 1024;

/// WASI handles (streams, pollables) one call may hold in the host table.
const MAX_HANDLES: usize = 10_000;

/// Per-store counts. A Rust indicator component needs a handful of each.
const MAX_INSTANCES: usize = 32;
const MAX_MEMORIES: usize = 4;
const MAX_TABLES: usize = 16;

/// Elements of any one table (function references, about 8 bytes each).
const MAX_TABLE_ELEMENTS: usize = 100_000;

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
        .and_then(|()| add_frozen_clock(&mut linker))
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
            return Err(LoadError::ForbiddenImport(shown(name)));
        }
    }
    let names: Vec<&str> = ty.exports(engine).map(|(name, _)| name).collect();
    let exports = export_list(&names);
    if !names
        .iter()
        .any(|n| n.starts_with("sandchart:indicator/indicator@"))
    {
        return Err(LoadError::WrongContract(format!(
            "it exports {exports} and no sandchart:indicator/indicator interface; implement the \
             SDK's Indicator trait and export it with export!"
        )));
    }
    let pre = linker
        .instantiate_pre(component)
        .map_err(|e| LoadError::ForbiddenImport(cut_error(format!("{e:#}"))))?;
    PluginPre::new(pre).map_err(|e| {
        LoadError::WrongContract(format!(
            "it exports {exports}, this host needs {CONTRACT} ({}); rebuild it with \
             sandchart-indicator 0.1",
            cut_error(format!("{e:#}"))
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
        Ok(Err(msg)) => Err(RunError::Indicator(cut_error(msg))),
        Err(e) => Err(run_error(e, &store, &log)),
    }
}

/// Maps a wasmtime error to the reason an author can act on.
fn run_error(e: wasmtime::Error, store: &Store<HostState>, log: &str) -> RunError {
    match e.downcast_ref::<Trap>() {
        Some(Trap::OutOfFuel) => return RunError::OutOfFuel,
        Some(Trap::Interrupt) => return RunError::Timeout,
        Some(Trap::HostcallFuelExhausted) => {
            return RunError::BadOutput(format!(
                "the indicator returned more than {} MiB; return at most one value per bar \
                 for each declared series",
                HOSTCALL_BYTES / (1024 * 1024)
            ));
        }
        _ => {}
    }
    if store.data().limiter.refused {
        return RunError::OutOfMemory;
    }
    if let Some(ResourceTableError::Full) = e.downcast_ref::<ResourceTableError>() {
        return RunError::Trap(format!(
            "the indicator holds more than {MAX_HANDLES} WASI handles (streams, pollables); \
             drop the ones it no longer needs"
        ));
    }
    // The cause first (for a Rust panic the output below holds the message
    // and the source line), then the wasm stack.
    let mut msg = cut_error(e.root_cause().to_string());
    if !log.is_empty() {
        msg.push_str("\nindicator output:\n");
        msg.push_str(log.trim());
    }
    if let Some(trace) = e.downcast_ref::<WasmBacktrace>() {
        // Frame names come from the module, so the trace is cut too.
        msg.push_str(&format!("\n{}", cut_error(trace.to_string())));
    }
    RunError::Trap(msg)
}

/// Keeps the first [`ERROR_BYTES`] of a message that carries guest text (an
/// error the guest returned, or a wasmtime error naming its imports, exports
/// or functions), cut at a character boundary.
fn cut_error(mut msg: String) -> String {
    if msg.len() > ERROR_BYTES {
        msg.truncate(msg.floor_char_boundary(ERROR_BYTES));
        msg.push_str("\n[cut at 1 KiB]");
    }
    msg
}

/// At most 8 export names, each cut by [`shown`], for a message.
fn export_list(exports: &[&str]) -> String {
    let mut names: Vec<String> = exports.iter().take(8).map(|n| shown(n)).collect();
    if exports.len() > 8 {
        names.push(format!("and {} more", exports.len() - 8));
    }
    format!("[{}]", names.join(", "))
}

fn log_text(pipe: &LogPipe) -> String {
    let (bytes, cut) = pipe.contents();
    let mut text = String::from_utf8_lossy(&bytes[..bytes.len().min(LOG_BYTES)]).into_owned();
    if cut {
        text.push_str("\n[log cut at 16 KiB]");
    }
    text
}

/// Store data: the WASI context and the limiter.
pub(crate) struct HostState {
    wasi: WasiCtx,
    table: ResourceTable,
    limiter: Limiter,
}

impl HostState {
    pub(crate) fn table(&mut self) -> &mut ResourceTable {
        &mut self.table
    }
}

impl WasiView for HostState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

/// Caps memory for the whole store (the sum of all linear memories, not
/// each one), table sizes and instance counts, and remembers a refusal so
/// the trap that follows a failed allocation is reported as `OutOfMemory`.
struct Limiter {
    memory_limit: usize,
    memory_used: usize,
    refused: bool,
}

impl Limiter {
    fn new(memory_limit: usize) -> Self {
        Self {
            memory_limit,
            memory_used: 0,
            refused: false,
        }
    }
}

impl ResourceLimiter for Limiter {
    fn memory_growing(
        &mut self,
        current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        let total = self.memory_used.saturating_sub(current) + desired;
        let allowed = total <= self.memory_limit && maximum.is_none_or(|max| desired <= max);
        if allowed {
            self.memory_used = total;
        } else {
            self.refused = true;
        }
        Ok(allowed)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        let allowed = desired <= MAX_TABLE_ELEMENTS && maximum.is_none_or(|max| desired <= max);
        self.refused |= !allowed;
        Ok(allowed)
    }

    fn instances(&self) -> usize {
        MAX_INSTANCES
    }

    fn tables(&self) -> usize {
        MAX_TABLES
    }

    fn memories(&self) -> usize {
        MAX_MEMORIES
    }
}

/// A wall clock that always reads 0 (the monotonic clock is replaced in the
/// linker, see `add_frozen_clock`).
struct ZeroClock;

impl HostWallClock for ZeroClock {
    fn resolution(&self) -> Duration {
        Duration::from_nanos(1)
    }
    fn now(&self) -> Duration {
        Duration::ZERO
    }
}

/// A store for one call: no args, env, files or network; clocks at 0; seeded
/// random; stdout and stderr into one capped log; memory, table, handle, fuel
/// and epoch limits.
fn new_store(engine: &Engine, limits: &Limits) -> (Store<HostState>, LogPipe) {
    let log = LogPipe::new(LOG_BYTES);
    let wasi = WasiCtx::builder()
        .stdout(log.clone())
        .stderr(log.clone())
        .allow_tcp(false)
        .allow_udp(false)
        .allow_ip_name_lookup(false)
        .wall_clock(ZeroClock)
        .secure_random(Xoshiro256PlusPlus::seed_from_u64(RANDOM_SEED))
        .insecure_random(Xoshiro256PlusPlus::seed_from_u64(RANDOM_SEED))
        .insecure_random_seed(u128::from(RANDOM_SEED))
        .build();
    let mut table = ResourceTable::new();
    table.set_max_capacity(MAX_HANDLES);
    let state = HostState {
        wasi,
        table,
        limiter: Limiter::new(limits.memory_bytes),
    };
    let mut store = Store::new(engine, state);
    store.limiter(|s| &mut s.limiter);
    store.set_hostcall_fuel(HOSTCALL_BYTES);
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

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: usize = 1024 * 1024;

    #[test]
    fn memory_limit_counts_all_memories_together() {
        let mut l = Limiter::new(10 * MIB);
        assert!(l.memory_growing(0, 6 * MIB, None).unwrap());
        // A second memory of the same size would pass a per-memory limit.
        assert!(!l.memory_growing(0, 6 * MIB, None).unwrap());
        assert!(l.refused);
        assert!(l.memory_growing(0, 4 * MIB, None).unwrap());
        // Growing the first memory further is refused too.
        assert!(!l.memory_growing(6 * MIB, 7 * MIB, None).unwrap());
    }

    #[test]
    fn growth_within_the_limit_is_counted_once() {
        let mut l = Limiter::new(10 * MIB);
        assert!(l.memory_growing(0, 2 * MIB, None).unwrap());
        assert!(l.memory_growing(2 * MIB, 8 * MIB, None).unwrap());
        assert!(l.memory_growing(8 * MIB, 10 * MIB, None).unwrap());
        assert!(!l.refused);
        assert!(!l.memory_growing(10 * MIB, 11 * MIB, None).unwrap());
    }

    #[test]
    fn tables_and_counts_are_capped() {
        let mut l = Limiter::new(10 * MIB);
        assert!(l.table_growing(0, MAX_TABLE_ELEMENTS, None).unwrap());
        assert!(!l.table_growing(0, MAX_TABLE_ELEMENTS + 1, None).unwrap());
        assert!(l.refused);
        assert_eq!(l.instances(), MAX_INSTANCES);
        assert_eq!(l.tables(), MAX_TABLES);
        assert_eq!(l.memories(), MAX_MEMORIES);
    }
}
