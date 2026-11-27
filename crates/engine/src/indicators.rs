//! Indicator service: built-in and installed WebAssembly indicators, the chart's
//! indicator instances, and compute over all cached bars of the open chart.
//!
//! Lock order: the bar cache may be held while the store is locked (a cache miss
//! reads the store under the cache lock, so a write that lands meanwhile cannot be
//! lost); nothing locks the bar cache while holding the store. No lock is held
//! across a module call.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use sandchart_core::{Candle, Instrument, InstrumentId, Timeframe};
use sandchart_indicators::{
    Bar, Limits, Meta, Module, ParamValue, REPAINT_BARS, REPAINT_PREFIXES, Runtime, SeriesData,
    SeriesOut, builtins, check_repaint, is_user_id, module_hash, sample_bars,
};
use sandchart_store::{Store, StoreError, StoredInstance, StoredModule};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::{Engine, EngineError, Shared, lock};

/// The compute window: at most this many of the newest cached bars.
pub const MAX_INDICATOR_BARS: usize = 100_000;

/// Highest palette slot a series colour may use.
const MAX_COLOR: u8 = 7;

/// An indicator the user can add to the chart.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IndicatorInfo {
    pub meta: Meta,
    pub builtin: bool,
    /// The module changed earlier values when later bars arrived (checked at install).
    pub repaints: bool,
}

/// A checked module file that has not been installed yet.
#[derive(Debug, Clone, PartialEq)]
pub struct Inspection {
    pub meta: Meta,
    /// The installed version of the same id, which an install would replace.
    pub replaces: Option<String>,
}

/// One indicator on the chart. `instance` ids are made by the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Instance {
    pub instance: String,
    pub module_id: String,
    pub params: Vec<(String, ParamValue)>,
    /// Palette slot per series id.
    pub colors: HashMap<String, u8>,
    pub hidden: bool,
}

/// Series of one instance, cut to the bars with `open_time >= from_time`.
#[derive(Debug, Clone, PartialEq)]
pub struct Computed {
    /// Open time of the first bar kept (0 when no bar is kept).
    pub first_time: i64,
    /// Open time of the last bar kept (0 when no bar is kept).
    pub last_time: i64,
    pub series: Vec<SeriesOut>,
    pub log: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InstanceResult {
    pub instance: String,
    /// The module's error message when this instance failed.
    pub result: Result<Computed, String>,
}

/// Counters for tests and the debug log.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IndicatorStats {
    /// Bar reads from the store by `compute_indicators` (cache misses).
    pub store_reads: u64,
    /// `compute` calls into modules by `compute_indicators` (memo misses).
    pub module_calls: u64,
}

#[derive(Clone)]
struct Loaded {
    module: Module,
    hash: [u8; 32],
    builtin: bool,
    repaints: bool,
}

impl Loaded {
    fn info(&self) -> IndicatorInfo {
        IndicatorInfo {
            meta: self.module.meta().clone(),
            builtin: self.builtin,
            repaints: self.repaints,
        }
    }
}

/// Bars of the open chart, in price units. Only one `(instrument, timeframe)` at a time.
struct BarCache {
    key: (InstrumentId, Timeframe),
    bars: Arc<Vec<Bar>>,
    /// Unique per content: bumped on every replacement or change.
    generation: u64,
}

#[derive(Default)]
pub(crate) struct BarState {
    cache: Option<BarCache>,
    last_generation: u64,
}

impl BarState {
    fn next_generation(&mut self) -> u64 {
        self.last_generation += 1;
        self.last_generation
    }
}

/// The last result of one instance and what it was computed from.
struct Memo {
    generation: u64,
    hash: [u8; 32],
    params: Vec<(String, ParamValue)>,
    from_time: i64,
    result: Result<Computed, String>,
}

/// Indicator state owned by the engine.
pub(crate) struct Service {
    runtime: Arc<Runtime>,
    modules: Arc<Mutex<HashMap<String, Loaded>>>,
    ready: Arc<watch::Sender<bool>>,
    /// `<data_dir>/indicators`, the installed module files.
    dir: PathBuf,
    memo: Mutex<HashMap<String, Memo>>,
    store_reads: AtomicU64,
    module_calls: AtomicU64,
}

fn guard<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn indicator_err(e: impl std::fmt::Display) -> EngineError {
    EngineError::Indicator(e.to_string())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Where an installed module is kept, by the hex SHA-256 of its bytes.
fn module_file(dir: &Path, sha256: &str) -> PathBuf {
    dir.join(format!("{sha256}.wasm"))
}

/// Marks the service ready when dropped, so a failing or panicking loader never
/// leaves the indicator methods waiting.
struct ReadyOnDrop(Arc<watch::Sender<bool>>);

impl Drop for ReadyOnDrop {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}

impl Service {
    /// Creates the runtime and starts a background thread that loads the built-ins
    /// and every installed module; returns without waiting for it.
    pub(crate) fn start(
        data_dir: &Path,
        cache_dir: Option<&Path>,
        store: Arc<Mutex<Store>>,
    ) -> Result<Service, EngineError> {
        let runtime = Arc::new(
            Runtime::new(Limits::default(), cache_dir.map(Path::to_path_buf))
                .map_err(indicator_err)?,
        );
        let (ready, _) = watch::channel(false);
        let service = Service {
            runtime: Arc::clone(&runtime),
            modules: Arc::default(),
            ready: Arc::new(ready),
            dir: data_dir.join("indicators"),
            memo: Mutex::default(),
            store_reads: AtomicU64::new(0),
            module_calls: AtomicU64::new(0),
        };
        let done = ReadyOnDrop(Arc::clone(&service.ready));
        let (modules, dir) = (Arc::clone(&service.modules), service.dir.clone());
        std::thread::Builder::new()
            .name("indicator-load".into())
            .spawn(move || {
                let _done = done;
                load_all(&runtime, &store, &dir, &modules);
            })?;
        Ok(service)
    }

    async fn wait_ready(&self) {
        let mut rx = self.ready.subscribe();
        // The sender lives as long as the service, so this only returns once ready.
        let _ = rx.wait_for(|ready| *ready).await;
    }

    fn loaded(&self, id: &str) -> Option<Loaded> {
        guard(&self.modules).get(id).cloned()
    }
}

fn load_all(
    runtime: &Runtime,
    store: &Mutex<Store>,
    dir: &Path,
    modules: &Mutex<HashMap<String, Loaded>>,
) {
    let mut keep = Vec::new();
    for (id, bytes) in builtins() {
        let hash = module_hash(bytes);
        keep.push(hash);
        match runtime.load(bytes) {
            Ok(module) => {
                guard(modules).insert(
                    (*id).to_owned(),
                    Loaded {
                        module,
                        hash,
                        builtin: true,
                        repaints: false,
                    },
                );
            }
            Err(e) => eprintln!("cannot load the built-in indicator {id}: {e}"),
        }
    }
    let rows = match lock(store).indicator_modules() {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("cannot read the installed indicators: {e}");
            Vec::new()
        }
    };
    for row in rows {
        let path = module_file(dir, &row.sha256);
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) => {
                eprintln!("cannot read indicator {} ({}): {e}", row.id, path.display());
                continue;
            }
        };
        let hash = module_hash(&bytes);
        keep.push(hash);
        match runtime.load(&bytes) {
            Ok(module) if module.meta().id == row.id => {
                guard(modules).insert(
                    row.id,
                    Loaded {
                        module,
                        hash,
                        builtin: false,
                        repaints: row.repaints,
                    },
                );
            }
            Ok(module) => eprintln!(
                "indicator file {} declares id {:?}, expected {:?}; skipped",
                path.display(),
                module.meta().id,
                row.id
            ),
            Err(e) => eprintln!("cannot load indicator {}: {e}", row.id),
        }
    }
    if let Err(e) = runtime.prune_cache(&keep) {
        eprintln!("cannot prune the compiled indicator cache: {e}");
    }
}

/// Loads and checks a module file for installing: the id must be a user id.
fn inspect(
    runtime: &Runtime,
    store: &Mutex<Store>,
    bytes: &[u8],
) -> Result<(Module, Inspection), EngineError> {
    let module = runtime.load(bytes).map_err(indicator_err)?;
    let id = &module.meta().id;
    if !is_user_id(id) {
        return Err(EngineError::Indicator(format!(
            "the indicator id {id:?} is reserved: ids starting with \"builtin.\" belong to the \
             indicators that come with Sandchart; give yours an id like \"author.name\""
        )));
    }
    let replaces = lock(store)
        .indicator_modules()?
        .into_iter()
        .find(|m| m.id == *id)
        .map(|m| m.version);
    let meta = module.meta().clone();
    Ok((module, Inspection { meta, replaces }))
}

/// Writes through a temp file and a rename, so a crash never leaves half a module.
fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("wasm.tmp");
    std::fs::write(&tmp, data).and_then(|()| std::fs::rename(&tmp, path))
}

fn remove_file(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Saved instances whose module is loaded, with params resolved against it.
fn resolve(stored: Vec<StoredInstance>, service: &Service) -> Vec<(Instance, Loaded)> {
    stored
        .into_iter()
        .filter_map(|s| {
            let loaded = service.loaded(&s.module_id)?;
            // Unreadable saved values fall back to the defaults.
            let saved: Vec<(String, ParamValue)> =
                serde_json::from_str(&s.params).unwrap_or_default();
            let mut colors: HashMap<String, u8> =
                serde_json::from_str(&s.colors).unwrap_or_default();
            colors.retain(|_, c| *c <= MAX_COLOR);
            let instance = Instance {
                instance: s.instance,
                module_id: s.module_id,
                params: loaded.module.resolve_params(&saved),
                colors,
                hidden: s.hidden,
            };
            Some((instance, loaded))
        })
        .collect()
}

fn to_bars(candles: &[Candle], inst: &Instrument) -> Vec<Bar> {
    let price = 10f64.powi(i32::from(inst.price_scale));
    let qty = 10f64.powi(i32::from(inst.qty_scale));
    candles
        .iter()
        .map(|c| Bar {
            time: c.open_time,
            open: c.open as f64 / price,
            high: c.high as f64 / price,
            low: c.low as f64 / price,
            close: c.close as f64 / price,
            volume: c.volume as f64 / qty,
        })
        .collect()
}

/// Keeps the bars from index `start` on: values are cut, markers re-based.
fn cut(series: Vec<SeriesOut>, start: usize) -> Vec<SeriesOut> {
    series
        .into_iter()
        .map(|s| {
            let data = match s.data {
                SeriesData::Values(v) => SeriesData::Values(v.get(start..).unwrap_or(&[]).to_vec()),
                SeriesData::Markers(m) => SeriesData::Markers(
                    m.into_iter()
                        .filter_map(|mut m| {
                            let i = usize::try_from(m.index).ok()?.checked_sub(start)?;
                            m.index = u32::try_from(i).ok()?;
                            Some(m)
                        })
                        .collect(),
                ),
            };
            SeriesOut { id: s.id, data }
        })
        .collect()
}

impl Shared {
    fn bar_state(&self) -> MutexGuard<'_, BarState> {
        guard(&self.bars)
    }

    /// Drops the cached bars of `(id, tf)` after a write that is not a single live candle.
    /// Must not be called while the store is locked.
    pub(crate) fn drop_bars(&self, id: &InstrumentId, tf: Timeframe) {
        let mut state = self.bar_state();
        if state
            .cache
            .as_ref()
            .is_some_and(|c| c.key.0 == *id && c.key.1 == tf)
        {
            state.cache = None;
        }
    }

    /// Applies a live candle just stored for `(inst, tf)` to the cached bars: the same
    /// open time as the last bar replaces it, a newer one is appended. Must not be
    /// called while the store is locked.
    pub(crate) fn live_bar(&self, inst: &Instrument, tf: Timeframe, candle: &Candle) {
        let mut state = self.bar_state();
        let Some(cache) = state.cache.as_mut() else {
            return;
        };
        if cache.key.0 != inst.id || cache.key.1 != tf {
            return;
        }
        let [bar] = to_bars(std::slice::from_ref(candle), inst)[..] else {
            return;
        };
        let last = cache.bars.last().map(|b| b.time);
        let changed = match last {
            Some(t) if t == bar.time => {
                if cache.bars.last() == Some(&bar) {
                    false
                } else {
                    let bars = Arc::make_mut(&mut cache.bars);
                    let n = bars.len();
                    bars[n - 1] = bar;
                    true
                }
            }
            Some(t) if t > bar.time => {
                // An older candle changed; the store is the truth, read it again.
                state.cache = None;
                return;
            }
            _ => {
                let bars = Arc::make_mut(&mut cache.bars);
                bars.push(bar);
                if bars.len() > MAX_INDICATOR_BARS {
                    bars.remove(0);
                }
                true
            }
        };
        if changed {
            let generation = state.next_generation();
            if let Some(cache) = state.cache.as_mut() {
                cache.generation = generation;
            }
        }
    }
}

impl Engine {
    /// True once the built-ins and installed modules are loaded.
    pub fn indicators_ready(&self) -> bool {
        *self.indicators.ready.borrow()
    }

    /// Built-ins first (in their fixed order), then installed indicators by name.
    pub async fn indicators(&self) -> Vec<IndicatorInfo> {
        let svc = &self.indicators;
        svc.wait_ready().await;
        let modules = guard(&svc.modules);
        let mut out: Vec<IndicatorInfo> = builtins()
            .iter()
            .filter_map(|(id, _)| modules.get(*id).map(Loaded::info))
            .collect();
        let mut installed: Vec<IndicatorInfo> = modules
            .values()
            .filter(|l| !l.builtin)
            .map(Loaded::info)
            .collect();
        installed.sort_by(|a, b| (&a.meta.name, &a.meta.id).cmp(&(&b.meta.name, &b.meta.id)));
        out.append(&mut installed);
        out
    }

    /// Loads and checks a module file without installing it.
    pub async fn inspect_indicator(&self, bytes: &[u8]) -> Result<Inspection, EngineError> {
        self.indicators.wait_ready().await;
        let (runtime, store) = (
            Arc::clone(&self.indicators.runtime),
            Arc::clone(&self.shared.store),
        );
        let bytes = bytes.to_vec();
        spawn_blocking(move || inspect(&runtime, &store, &bytes).map(|(_, i)| i)).await
    }

    /// Checks a module, runs the repaint check on sample bars, stores the file and
    /// its row, and replaces any installed module with the same id.
    pub async fn install_indicator(&self, bytes: Vec<u8>) -> Result<IndicatorInfo, EngineError> {
        let svc = &self.indicators;
        svc.wait_ready().await;
        let runtime = Arc::clone(&svc.runtime);
        let store = Arc::clone(&self.shared.store);
        let installed_at = self.now_ms();
        let (module, inspection, repaints) = {
            let (store, bytes) = (Arc::clone(&store), bytes.clone());
            spawn_blocking(move || {
                let (module, inspection) = inspect(&runtime, &store, &bytes)?;
                let params = module.resolve_params(&[]);
                let bars = sample_bars(REPAINT_BARS);
                let repaints = check_repaint(&module, &params, &bars, &REPAINT_PREFIXES)
                    .map_err(|e| {
                        EngineError::Indicator(format!("the indicator failed on sample bars: {e}"))
                    })?
                    .is_some();
                Ok((module, inspection, repaints))
            })
            .await?
        };

        let hash = module_hash(&bytes);
        let dir = svc.dir.clone();
        let id = inspection.meta.id.clone();
        let row = StoredModule {
            id: id.clone(),
            version: inspection.meta.version.clone(),
            sha256: hex(&hash),
            repaints,
            installed_at,
        };
        let old = spawn_blocking(move || {
            std::fs::create_dir_all(&dir)?;
            write_atomic(&module_file(&dir, &row.sha256), &bytes)?;
            let mut s = lock(&store);
            let old = s.indicator_modules()?.into_iter().find(|m| m.id == row.id);
            s.upsert_indicator_module(&row)?;
            Ok(old)
        })
        .await?;
        let loaded = Loaded {
            module,
            hash,
            builtin: false,
            repaints,
        };
        let info = loaded.info();
        guard(&svc.modules).insert(id, loaded);
        if let Some(old) = old.filter(|o| o.sha256 != hex(&hash)) {
            let path = module_file(&svc.dir, &old.sha256);
            if let Err(e) = remove_file(&path) {
                eprintln!(
                    "cannot delete the old indicator file {}: {e}",
                    path.display()
                );
            }
        }
        Ok(info)
    }

    /// Uninstalls a module and removes its chart instances. Built-ins cannot be removed.
    pub async fn remove_indicator(&self, id: &str) -> Result<(), EngineError> {
        let svc = &self.indicators;
        svc.wait_ready().await;
        if !is_user_id(id) {
            return Err(EngineError::Indicator(format!(
                "{id:?} is not an installed indicator; built-in indicators cannot be removed"
            )));
        }
        let store = Arc::clone(&self.shared.store);
        let key = id.to_owned();
        let row = spawn_blocking(move || {
            let mut s = lock(&store);
            let row = s.indicator_modules()?.into_iter().find(|m| m.id == key);
            if row.is_some() {
                s.delete_indicator_module(&key)?;
            }
            Ok(row)
        })
        .await?
        .ok_or_else(|| EngineError::Indicator(format!("no installed indicator has id {id:?}")))?;
        guard(&svc.modules).remove(id);
        let path = module_file(&svc.dir, &row.sha256);
        if let Err(e) = remove_file(&path) {
            eprintln!("cannot delete the indicator file {}: {e}", path.display());
        }
        Ok(())
    }

    /// The chart's indicators in order, params resolved against their module.
    /// Instances whose module is gone are left out.
    pub async fn chart_indicators(&self) -> Result<Vec<Instance>, EngineError> {
        self.indicators.wait_ready().await;
        let store = Arc::clone(&self.shared.store);
        let stored = spawn_blocking(move || Ok(lock(&store).indicator_instances()?)).await?;
        Ok(resolve(stored, &self.indicators)
            .into_iter()
            .map(|(i, _)| i)
            .collect())
    }

    /// Replaces the chart's indicators, keeping their order.
    pub async fn set_chart_indicators(&self, items: Vec<Instance>) -> Result<(), EngineError> {
        self.indicators.wait_ready().await;
        let stored = items
            .into_iter()
            .map(|i| {
                Ok(StoredInstance {
                    params: serde_json::to_string(&i.params)?,
                    colors: serde_json::to_string(&i.colors)?,
                    instance: i.instance,
                    module_id: i.module_id,
                    hidden: i.hidden,
                })
            })
            .collect::<Result<Vec<_>, serde_json::Error>>()
            .map_err(|e| {
                EngineError::Indicator(format!("cannot save the chart indicators: {e}"))
            })?;
        let store = Arc::clone(&self.shared.store);
        spawn_blocking(move || Ok(lock(&store).set_indicator_instances(&stored)?)).await
    }

    /// Computes every visible chart indicator over all cached bars of `(id, tf)` (the
    /// newest [`MAX_INDICATOR_BARS`]) and returns the bars with `open_time >= from_time`.
    /// One failing instance gets its error as its result; the others still compute.
    pub async fn compute_indicators(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
        from_time: i64,
    ) -> Result<Vec<InstanceResult>, EngineError> {
        let svc = &self.indicators;
        svc.wait_ready().await;
        let (store, key) = (Arc::clone(&self.shared.store), id.clone());
        let (stored, inst) = spawn_blocking(move || {
            let s = lock(&store);
            Ok((s.indicator_instances()?, s.instrument(&key)?))
        })
        .await?;
        let inst = inst.ok_or_else(|| EngineError::UnknownInstrument(id.clone()))?;
        let shared = self.shared.clone();
        let (bars, generation, read) =
            spawn_blocking(move || Ok(cached_bars(&shared, &inst, tf)?)).await?;
        if read {
            svc.store_reads.fetch_add(1, Ordering::Relaxed);
        }

        let visible: Vec<(Instance, Loaded)> = resolve(stored, svc)
            .into_iter()
            .filter(|(i, _)| !i.hidden)
            .collect();
        let mut out = Vec::with_capacity(visible.len());
        for (instance, loaded) in visible {
            let hit = guard(&svc.memo).get(&instance.instance).and_then(|m| {
                (m.generation == generation
                    && m.hash == loaded.hash
                    && m.params == instance.params
                    && m.from_time == from_time)
                    .then(|| m.result.clone())
            });
            let result = match hit {
                Some(result) => result,
                None => {
                    svc.module_calls.fetch_add(1, Ordering::Relaxed);
                    let (module, params, bars) = (
                        loaded.module.clone(),
                        instance.params.clone(),
                        Arc::clone(&bars),
                    );
                    let result =
                        spawn_blocking(move || Ok(compute_one(&module, &params, &bars, from_time)))
                            .await?;
                    guard(&svc.memo).insert(
                        instance.instance.clone(),
                        Memo {
                            generation,
                            hash: loaded.hash,
                            params: instance.params,
                            from_time,
                            result: result.clone(),
                        },
                    );
                    result
                }
            };
            out.push(InstanceResult {
                instance: instance.instance,
                result,
            });
        }
        guard(&svc.memo).retain(|k, _| out.iter().any(|r| r.instance == *k));
        Ok(out)
    }

    pub fn indicator_stats(&self) -> IndicatorStats {
        IndicatorStats {
            store_reads: self.indicators.store_reads.load(Ordering::Relaxed),
            module_calls: self.indicators.module_calls.load(Ordering::Relaxed),
        }
    }
}

/// The cached bars of `(inst, tf)` with their generation, read from the store on a
/// miss (then the third value is true). The store is read under the cache lock, so a
/// write that drops or updates the cache cannot slip in between read and install.
fn cached_bars(
    shared: &Shared,
    inst: &Instrument,
    tf: Timeframe,
) -> Result<(Arc<Vec<Bar>>, u64, bool), StoreError> {
    let mut state = shared.bar_state();
    if let Some(c) = state
        .cache
        .as_ref()
        .filter(|c| c.key.0 == inst.id && c.key.1 == tf)
    {
        return Ok((Arc::clone(&c.bars), c.generation, false));
    }
    let candles = lock(&shared.store).candles_before(&inst.id, tf, None, MAX_INDICATOR_BARS)?;
    let bars = Arc::new(to_bars(&candles, inst));
    let generation = state.next_generation();
    state.cache = Some(BarCache {
        key: (inst.id.clone(), tf),
        bars: Arc::clone(&bars),
        generation,
    });
    Ok((bars, generation, true))
}

fn compute_one(
    module: &Module,
    params: &[(String, ParamValue)],
    bars: &[Bar],
    from_time: i64,
) -> Result<Computed, String> {
    let output = module.compute(params, bars).map_err(|e| e.to_string())?;
    let start = bars.partition_point(|b| b.time < from_time);
    let kept = &bars[start..];
    Ok(Computed {
        first_time: kept.first().map_or(0, |b| b.time),
        last_time: kept.last().map_or(0, |b| b.time),
        series: cut(output.series, start),
        log: output.log,
    })
}

async fn spawn_blocking<T, F>(f: F) -> Result<T, EngineError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, EngineError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| EngineError::Task(e.to_string()))?
}
