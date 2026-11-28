//! The Sandchart engine: ties the SQLite store and the data providers together.
//!
//! * [`Engine::load_chart`] serves candles cache-first and fetches pages on demand.
//! * [`Engine::subscribe_live`] streams live candles and backfills gaps after reconnects.
//! * [`Engine::import_csv`] loads local files as the `csv` source.
//! * [`Engine::drawings`] and [`Engine::save_drawing`] keep the chart drawings.

mod chart;
mod csv_import;
mod drawings;
mod indicators;
mod live;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use sandchart_core::{DecimalError, Instrument, InstrumentId};
use sandchart_data::{DayChange, Provider, ProviderError};
use sandchart_indicators::{Limits, Runtime};
use sandchart_store::{Store, StoreError};
use tokio::sync::watch;

pub use chart::ChartPage;
pub use indicators::{
    Computed, FailedIndicator, IndicatorInfo, IndicatorList, IndicatorStats, Inspection, Instance,
    InstanceResult, MAX_INDICATOR_BARS,
};
pub use live::{ConnectionState, LiveEvent, LiveHandle};

/// Candles per provider request and per chart page.
pub(crate) const PAGE: u16 = 1000;

/// Binance `ticker/24hr` accepts at most this many symbols per call.
const QUOTES_CHUNK: usize = 100;

/// Source name of instruments imported from CSV files.
pub const CSV_SOURCE: &str = "csv";

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Provider(#[from] ProviderError),
    #[error("no data source named {0:?}")]
    UnknownSource(String),
    #[error("unknown instrument {}/{}", .0.source, .0.symbol)]
    UnknownInstrument(InstrumentId),
    #[error("CSV import failed: {0}")]
    Csv(String),
    #[error("number out of range: {0}")]
    Decimal(#[from] DecimalError),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("background task failed: {0}")]
    Task(String),
    #[error("live updates need a running tokio runtime")]
    NoRuntime,
    #[error("{0}")]
    Indicator(String),
    /// A drawing or position the UI sent breaks a rule.
    #[error("{0}")]
    Drawing(String),
}

type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// What decides the connection state: streams with an unfilled gap, failed REST calls,
/// and whether anything has answered yet.
#[derive(Default)]
struct ConnectionInputs {
    gaps: usize,
    offline: bool,
    contacted: bool,
}

/// Shared pieces the background live tasks need as well.
#[derive(Clone)]
pub(crate) struct Shared {
    pub store: Arc<Mutex<Store>>,
    connection: Arc<watch::Sender<ConnectionState>>,
    inputs: Arc<Mutex<ConnectionInputs>>,
    /// Bars of the open chart for indicators; see `indicators.rs` for the lock order.
    bars: Arc<Mutex<indicators::BarState>>,
}

pub struct Engine {
    shared: Shared,
    providers: HashMap<String, Arc<dyn Provider>>,
    clock: Clock,
    indicators: indicators::Service,
}

/// Locks the store; a poisoned lock is safe to reuse because every store write is a transaction.
pub(crate) fn lock(store: &Mutex<Store>) -> std::sync::MutexGuard<'_, Store> {
    store.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs a store operation on the blocking thread pool.
pub(crate) async fn blocking<T, F>(store: &Arc<Mutex<Store>>, f: F) -> Result<T, EngineError>
where
    T: Send + 'static,
    F: FnOnce(&mut Store) -> Result<T, StoreError> + Send + 'static,
{
    let store = Arc::clone(store);
    tokio::task::spawn_blocking(move || f(&mut lock(&store)))
        .await
        .map_err(|e| EngineError::Task(e.to_string()))?
        .map_err(EngineError::from)
}

impl Shared {
    /// Applies `f` to the inputs and publishes the derived state if it changed.
    fn update(&self, f: impl FnOnce(&mut ConnectionInputs)) {
        let mut inputs = self.inputs.lock().unwrap_or_else(PoisonError::into_inner);
        f(&mut inputs);
        let state = if inputs.offline {
            ConnectionState::Offline
        } else if inputs.gaps > 0 {
            ConnectionState::Reconnecting
        } else if !inputs.contacted {
            ConnectionState::Connecting
        } else {
            ConnectionState::Connected
        };
        self.connection.send_if_modified(|s| {
            let changed = *s != state;
            *s = state;
            changed
        });
    }

    /// Reflects a failed provider call in the connection state. Any other error than a
    /// network one is an answer from the exchange, so it counts as contact.
    pub(crate) fn note_error(&self, err: &ProviderError) {
        if matches!(
            err,
            ProviderError::Network(_) | ProviderError::Blocked { .. }
        ) {
            self.update(|i| i.offline = true);
        } else {
            self.update(|i| i.contacted = true);
        }
    }

    /// A successful REST call or live message proves the network is up.
    pub(crate) fn note_ok(&self) {
        self.update(|i| {
            i.offline = false;
            i.contacted = true;
        });
    }

    pub(crate) fn gap_opened(&self) {
        self.update(|i| i.gaps += 1);
    }

    pub(crate) fn gap_closed(&self) {
        self.update(|i| i.gaps = i.gaps.saturating_sub(1));
    }
}

impl Engine {
    /// Opens `data_dir/sandchart.db` and registers the providers by their source name.
    /// Installed indicators live in `data_dir/indicators`; compiled modules are cached in
    /// `cache_dir` when given. Returns at once: indicators load in the background.
    pub fn open(
        data_dir: &Path,
        cache_dir: Option<&Path>,
        providers: Vec<Arc<dyn Provider>>,
    ) -> Result<Engine, EngineError> {
        Self::open_with_clock(data_dir, cache_dir, providers, Arc::new(system_now_ms))
    }

    /// Like [`Engine::open`] with an explicit clock (milliseconds since the Unix epoch).
    pub fn open_with_clock(
        data_dir: &Path,
        cache_dir: Option<&Path>,
        providers: Vec<Arc<dyn Provider>>,
        clock: Clock,
    ) -> Result<Engine, EngineError> {
        let runtime = Runtime::new(Limits::default(), cache_dir.map(Path::to_path_buf))
            .map_err(|e| format!("the indicator runtime could not start: {e}"));
        Self::open_with_runtime(data_dir, providers, clock, runtime)
    }

    /// Opens the engine with an indicator runtime that may have failed to start: then
    /// charts still work and every indicator method returns that error.
    fn open_with_runtime(
        data_dir: &Path,
        providers: Vec<Arc<dyn Provider>>,
        clock: Clock,
        runtime: Result<Runtime, String>,
    ) -> Result<Engine, EngineError> {
        let store = Arc::new(Mutex::new(Store::open(&data_dir.join("sandchart.db"))?));
        let indicators = indicators::Service::start(data_dir, runtime, Arc::clone(&store));
        let (connection, _) = watch::channel(ConnectionState::Connecting);
        Ok(Engine {
            shared: Shared {
                store,
                connection: Arc::new(connection),
                inputs: Arc::default(),
                bars: Arc::default(),
            },
            providers: providers
                .into_iter()
                .map(|p| (p.source().to_owned(), p))
                .collect(),
            clock,
            indicators,
        })
    }

    pub(crate) fn provider(&self, source: &str) -> Option<Arc<dyn Provider>> {
        self.providers.get(source).cloned()
    }

    pub(crate) fn now_ms(&self) -> i64 {
        (self.clock)()
    }

    /// Downloads the instrument list of `source` into the store; returns how many were stored.
    pub async fn sync_instruments(&self, source: &str) -> Result<usize, EngineError> {
        let provider = self
            .provider(source)
            .ok_or_else(|| EngineError::UnknownSource(source.to_owned()))?;
        let items = match provider.instruments().await {
            Ok(items) => items,
            Err(e) => {
                self.shared.note_error(&e);
                return Err(e.into());
            }
        };
        self.shared.note_ok();
        let n = items.len();
        blocking(&self.shared.store, move |s| s.upsert_instruments(&items)).await?;
        Ok(n)
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<Instrument>, EngineError> {
        Ok(lock(&self.shared.store).search_instruments(query, limit)?)
    }

    pub fn watchlist(&self) -> Result<Vec<InstrumentId>, EngineError> {
        Ok(lock(&self.shared.store).watchlist()?)
    }

    pub fn set_watchlist(&self, ids: &[InstrumentId]) -> Result<(), EngineError> {
        Ok(lock(&self.shared.store).set_watchlist(ids)?)
    }

    /// 24 h changes for the whole watchlist: one provider call per source (per 100 symbols).
    /// `csv` instruments, unknown instruments and sources without a provider are skipped.
    pub async fn watchlist_quotes(&self) -> Result<Vec<DayChange>, EngineError> {
        let by_source = blocking(&self.shared.store, |s| {
            let mut groups: Vec<(String, Vec<Instrument>)> = Vec::new();
            for id in s.watchlist()? {
                if id.source == CSV_SOURCE {
                    continue;
                }
                let Some(inst) = s.instrument(&id)? else {
                    continue;
                };
                match groups.iter_mut().find(|(src, _)| *src == id.source) {
                    Some((_, v)) => v.push(inst),
                    None => groups.push((id.source.clone(), vec![inst])),
                }
            }
            Ok(groups)
        })
        .await?;

        let mut out = Vec::new();
        for (source, insts) in by_source {
            let Some(provider) = self.provider(&source) else {
                continue;
            };
            for chunk in insts.chunks(QUOTES_CHUNK) {
                match provider.day_changes(chunk).await {
                    Ok(mut changes) => {
                        self.shared.note_ok();
                        out.append(&mut changes);
                    }
                    Err(e) => {
                        self.shared.note_error(&e);
                        return Err(e.into());
                    }
                }
            }
        }
        Ok(out)
    }

    /// Watch channel with the current connection state (status bar, top-bar dot).
    pub fn connection(&self) -> watch::Receiver<ConnectionState> {
        self.shared.connection.subscribe()
    }
}

fn system_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn charts_work_when_the_indicator_runtime_cannot_start() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open_with_runtime(
            dir.path(),
            vec![],
            Arc::new(|| 0),
            Err("the indicator runtime could not start: injected".into()),
        )
        .unwrap();
        assert!(engine.indicators_ready());
        assert_eq!(engine.watchlist().unwrap(), vec![]);

        let list = engine.indicators().await;
        assert!(list.indicators.is_empty());
        assert_eq!(
            list.error.as_deref(),
            Some("the indicator runtime could not start: injected")
        );
        let err = engine.install_indicator(vec![]).await.unwrap_err();
        assert!(
            matches!(&err, EngineError::Indicator(m) if m.contains("injected")),
            "{err:?}"
        );
        assert!(engine.chart_indicators().await.is_err());
        assert!(engine.set_chart_indicators(vec![]).await.is_err());
        assert!(engine.remove_indicator("me.x").await.is_err());
    }
}
