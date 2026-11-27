//! The Sandchart engine: ties the SQLite store and the data providers together.
//!
//! * [`Engine::load_chart`] serves candles cache-first and fetches pages on demand.
//! * [`Engine::subscribe_live`] streams live candles and backfills gaps after reconnects.
//! * [`Engine::import_csv`] loads local files as the `csv` source.

mod chart;
mod csv_import;
mod live;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use sandchart_core::{DecimalError, Instrument, InstrumentId};
use sandchart_data::{DayChange, Provider, ProviderError};
use sandchart_store::{Store, StoreError};
use tokio::sync::watch;

pub use chart::ChartPage;
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
}

type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// Shared pieces the background live task needs as well.
#[derive(Clone)]
pub(crate) struct Shared {
    pub store: Arc<Mutex<Store>>,
    pub connection: Arc<watch::Sender<ConnectionState>>,
}

pub struct Engine {
    shared: Shared,
    providers: HashMap<String, Arc<dyn Provider>>,
    clock: Clock,
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
    /// Reflects a failed provider call in the connection state.
    pub(crate) fn note_error(&self, err: &ProviderError) {
        if matches!(
            err,
            ProviderError::Network(_) | ProviderError::Blocked { .. }
        ) {
            self.connection.send_replace(ConnectionState::Offline);
        }
    }

    /// A successful REST call proves the network is back.
    pub(crate) fn note_ok(&self) {
        self.connection.send_if_modified(|s| {
            let was_offline = *s == ConnectionState::Offline;
            if was_offline {
                *s = ConnectionState::Connected;
            }
            was_offline
        });
    }
}

impl Engine {
    /// Opens `data_dir/sandchart.db` and registers the providers by their source name.
    pub fn open(data_dir: &Path, providers: Vec<Arc<dyn Provider>>) -> Result<Engine, EngineError> {
        Self::open_with_clock(data_dir, providers, Arc::new(system_now_ms))
    }

    /// Like [`Engine::open`] with an explicit clock (milliseconds since the Unix epoch).
    pub fn open_with_clock(
        data_dir: &Path,
        providers: Vec<Arc<dyn Provider>>,
        clock: Clock,
    ) -> Result<Engine, EngineError> {
        let store = Store::open(&data_dir.join("sandchart.db"))?;
        let (connection, _) = watch::channel(ConnectionState::Connected);
        Ok(Engine {
            shared: Shared {
                store: Arc::new(Mutex::new(store)),
                connection: Arc::new(connection),
            },
            providers: providers
                .into_iter()
                .map(|p| (p.source().to_owned(), p))
                .collect(),
            clock,
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
