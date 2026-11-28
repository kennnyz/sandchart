//! The Sandchart MCP server (ADR 0006): the engine's charts, indicators, drawings, position
//! outcomes, replay results and alerts as Model Context Protocol tools over stdio.
//!
//! It opens the app's data folder as a second process ([`Engine::open_secondary`]), so it
//! works whether the app runs or not. No tool places orders and there are no keys.

mod wire;

use std::fmt::Display;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use sandchart_core::alert::Alert;
use sandchart_core::replay::{MAX_FILE_BYTES, ReplayFile};
use sandchart_core::{Candle, Drawing, Instrument, InstrumentId, Timeframe};
use sandchart_engine::{Engine, EngineError};
use sandchart_indicators::{Meta, ParamKind, ParamValue, SeriesData};
use serde_json::{Map, Value, json};

use wire::{
    AlertInput, BINANCE, CandlesInput, DEFAULT_STYLE, DrawingInput, IdInput, IndicatorInput,
    PairInput, PositionInput, ReplayInput, SearchInput,
};

/// Most search results.
pub const MAX_SEARCH: u32 = 50;
/// Most candles or indicator values per call.
pub const MAX_BARS: u32 = 5000;
/// Longest source or symbol accepted.
const MAX_NAME_BYTES: usize = 64;
/// Most chart pages one call walks back through (1000 candles each).
const MAX_PAGES: usize = 8;
/// Length of a calendar-month bar when judging where a position's bars end.
const MONTH_MS: i64 = 31 * 24 * 60 * 60 * 1000;
/// Least time between two failed instrument-list downloads.
const SYNC_RETRY: Duration = Duration::from_secs(60);

const ALERTS_NOTE: &str = "Alerts fire only while the Sandchart app is running.";

const INSTRUCTIONS: &str = "Sandchart's local chart data. Prices are integer ticks at the \
pair's priceScale (61443.01 at priceScale 2 is 6144301); outputs also give decimal strings. \
Times are Unix milliseconds, UTC. Find a pair with search_instruments first. No tool trades \
or touches an exchange account.";

/// Whether the instrument list was downloaded in this process.
#[derive(Default)]
struct Sync {
    done: bool,
    last_failure: Option<Instant>,
}

#[derive(Clone)]
pub struct Sandchart {
    engine: Arc<Engine>,
    sync: Arc<tokio::sync::Mutex<Sync>>,
    tool_router: ToolRouter<Self>,
}

type ToolResult = Result<CallToolResult, String>;

fn ok(v: Value) -> ToolResult {
    Ok(CallToolResult::structured(v))
}

fn err(e: impl Display) -> String {
    e.to_string()
}

/// Runs a sync engine call off the async threads.
async fn blocking<T: Send + 'static>(
    engine: &Arc<Engine>,
    f: impl FnOnce(&Engine) -> Result<T, EngineError> + Send + 'static,
) -> Result<T, String> {
    let engine = Arc::clone(engine);
    tokio::task::spawn_blocking(move || f(&engine))
        .await
        .map_err(err)?
        .map_err(err)
}

fn timeframe(code: &str) -> Result<Timeframe, String> {
    Timeframe::from_code(code).ok_or_else(|| {
        let codes: Vec<&str> = Timeframe::ALL.iter().map(Timeframe::code).collect();
        format!("unknown timeframe {code:?}; use one of {}", codes.join(" "))
    })
}

/// `v` (default `default`) inside `1..=max`.
fn capped(what: &str, v: Option<u32>, default: u32, max: u32) -> Result<usize, String> {
    match v.unwrap_or(default) {
        n @ 1.. if n <= max => Ok(n as usize),
        n => Err(format!("{what} must be 1 to {max}, not {n}")),
    }
}

fn check_name(what: &str, s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > MAX_NAME_BYTES {
        return Err(format!("{what} must be 1 to {MAX_NAME_BYTES} bytes"));
    }
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// A new id for a drawing or alert: unique across processes and calls.
fn new_id(prefix: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{:x}-{nanos:x}-{n}", std::process::id())
}

/// Candles walked back from `before`, ascending, with what the pages said.
struct Fetched {
    instrument: Instrument,
    candles: Vec<Candle>,
    at_history_start: bool,
    warning: Option<String>,
}

/// A JSON parameter value as the module's spec wants it.
fn param_value(meta: &Meta, name: &str, v: &Value) -> Result<ParamValue, String> {
    let Some(spec) = meta.params.iter().find(|p| p.id == name) else {
        let names: Vec<&str> = meta.params.iter().map(|p| p.id.as_str()).collect();
        return Err(format!(
            "{} has no parameter {name:?}; its parameters are: {}",
            meta.id,
            if names.is_empty() {
                "none".to_owned()
            } else {
                names.join(", ")
            }
        ));
    };
    let value = match &spec.kind {
        ParamKind::Int { .. } => v.as_i64().map(ParamValue::Int),
        ParamKind::Float { .. } => v.as_f64().map(ParamValue::Float),
        ParamKind::Boolean => v.as_bool().map(ParamValue::Boolean),
        ParamKind::Choice(_) => v.as_str().map(|s| ParamValue::Choice(s.to_owned())),
    };
    value.ok_or_else(|| {
        let want = match spec.kind {
            ParamKind::Int { .. } => "an integer",
            ParamKind::Float { .. } => "a number",
            ParamKind::Boolean => "true or false",
            ParamKind::Choice(_) => "a string",
        };
        format!("parameter {name:?} of {} must be {want}, not {v}", meta.id)
    })
}

fn param_json(v: &ParamValue) -> Value {
    match v {
        ParamValue::Int(i) => json!(i),
        ParamValue::Float(f) => json!(f),
        ParamValue::Boolean(b) => json!(b),
        ParamValue::Choice(c) => json!(c),
    }
}

/// Reads a `.replay` file: an absolute path to a regular file within the app's size cap.
fn read_replay(path: &str) -> Result<Vec<u8>, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("{path:?} is not an absolute path"));
    }
    if p.extension().and_then(|e| e.to_str()) != Some("replay") {
        return Err(format!("{path:?} is not a .replay file"));
    }
    let cannot = |e: std::io::Error| format!("cannot read {path:?}: {e}");
    // Checked before opening: opening a FIFO or a device could block or never end.
    let meta = std::fs::metadata(p).map_err(cannot)?;
    if !meta.is_file() {
        return Err(format!("{path:?} is not a regular file"));
    }
    let too_big = || format!("{path:?} is larger than {} MiB", MAX_FILE_BYTES >> 20);
    if meta.len() > MAX_FILE_BYTES as u64 {
        return Err(too_big());
    }
    let file = std::fs::File::open(p).map_err(cannot)?;
    if !file.metadata().map_err(cannot)?.is_file() {
        return Err(format!("{path:?} is not a regular file"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(cannot)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(too_big());
    }
    Ok(bytes)
}

impl Sandchart {
    pub fn new(engine: Arc<Engine>) -> Self {
        Self {
            engine,
            sync: Arc::default(),
            tool_router: Self::tool_router(),
        }
    }

    /// Downloads the instrument list once per process; after a failure, again only after
    /// [`SYNC_RETRY`]. Returns the error of this call's attempt, if it made one and failed.
    async fn sync_instruments(&self) -> Option<String> {
        let mut st = self.sync.lock().await;
        if st.done || st.last_failure.is_some_and(|t| t.elapsed() < SYNC_RETRY) {
            return None;
        }
        match self.engine.sync_instruments(BINANCE).await {
            Ok(_) => {
                st.done = true;
                None
            }
            Err(e) => {
                st.last_failure = Some(Instant::now());
                Some(format!("cannot refresh the instrument list: {e}"))
            }
        }
    }

    /// The stored instrument `source`/`symbol` (symbol case does not matter), downloading
    /// the instrument list first when it is not known yet.
    async fn instrument(&self, source: &str, symbol: &str) -> Result<Instrument, String> {
        check_name("source", source)?;
        check_name("symbol", symbol)?;
        let find = || {
            let (source, symbol) = (source.to_owned(), symbol.to_owned());
            blocking(&self.engine, move |e| {
                Ok(e.search(&symbol, MAX_SEARCH as usize)?
                    .into_iter()
                    .find(|i| i.id.source == source && i.id.symbol.eq_ignore_ascii_case(&symbol)))
            })
        };
        if let Some(i) = find().await? {
            return Ok(i);
        }
        let failed = if source == BINANCE {
            self.sync_instruments().await
        } else {
            None
        };
        find().await?.ok_or_else(|| {
            let mut m = format!("unknown pair {source}/{symbol}; search_instruments lists them");
            if let Some(f) = failed {
                m = format!("{m} ({f})");
            }
            m
        })
    }

    /// Up to `limit` candles before `before`, newest last, walking back page by page like
    /// the chart does: cached ones first, missing ones from the provider. Stops early at
    /// the start of history, or once a candle at or before `reach` is in.
    async fn fetch(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
        limit: usize,
        before: Option<i64>,
        reach: Option<i64>,
    ) -> Result<Fetched, String> {
        let mut out: Vec<Candle> = Vec::new();
        let mut cursor = before;
        let mut warning = None;
        let mut instrument = None;
        let mut at_history_start = false;
        for _ in 0..MAX_PAGES {
            let page = match self.engine.load_chart(id, tf, cursor).await {
                Ok(page) => page,
                // A later page failed: return what the earlier ones gave.
                Err(e) if instrument.is_some() => {
                    warning.get_or_insert(e.to_string());
                    break;
                }
                Err(e) => return Err(err(e)),
            };
            if let Some(w) = page.warning {
                warning.get_or_insert(w.to_string());
            }
            instrument.get_or_insert(page.instrument);
            at_history_start = page.at_history_start;
            let oldest = page.candles.first().map(|c| c.open_time);
            let mut candles = page.candles;
            candles.append(&mut out);
            out = candles;
            let reached = reach.is_some_and(|t| oldest.is_some_and(|o| o <= t));
            match oldest {
                Some(o) if out.len() < limit && !at_history_start && !reached => cursor = Some(o),
                _ => break,
            }
        }
        let cut = out.len().saturating_sub(limit);
        out.drain(..cut);
        Ok(Fetched {
            instrument: instrument.ok_or("no candles")?,
            candles: out,
            at_history_start,
            warning,
        })
    }
}

#[tool_router]
impl Sandchart {
    #[tool(
        description = "Find pairs by symbol. Returns source, symbol, base, quote, priceScale \
                       (decimal places of a price tick) and qtyScale.",
        annotations(read_only_hint = true)
    )]
    async fn search_instruments(&self, Parameters(p): Parameters<SearchInput>) -> ToolResult {
        let limit = capped("limit", p.limit, 20, MAX_SEARCH)?;
        if p.query.len() > MAX_NAME_BYTES {
            return Err(format!("query must be at most {MAX_NAME_BYTES} bytes"));
        }
        let failed = self.sync_instruments().await;
        let query = p.query;
        let found = blocking(&self.engine, move |e| e.search(&query, limit)).await?;
        if found.is_empty()
            && let Some(f) = failed
        {
            return Err(f);
        }
        let mut out =
            json!({ "instruments": found.iter().map(wire::instrument).collect::<Vec<_>>() });
        if let Some(f) = failed {
            out["warning"] = format!("{f}; showing the cached list").into();
        }
        ok(out)
    }

    #[tool(
        description = "OHLCV candles, oldest first; the last may still be forming. Served \
                       from the local cache, missing ones fetched from the exchange. Prices \
                       are decimal strings; ticks is [open, high, low, close, volume] as \
                       integers.",
        annotations(read_only_hint = true)
    )]
    async fn get_candles(&self, Parameters(p): Parameters<CandlesInput>) -> ToolResult {
        let tf = timeframe(&p.timeframe)?;
        let limit = capped("limit", p.limit, 500, MAX_BARS)?;
        let inst = self.instrument(&p.source, &p.symbol).await?;
        let f = self.fetch(&inst.id, tf, limit, p.before, None).await?;
        let i = &f.instrument;
        ok(json!({
            "instrument": wire::instrument(i),
            "timeframe": tf.code(),
            "candles": f.candles.iter().map(|c| wire::candle(c, i)).collect::<Vec<_>>(),
            "atHistoryStart": f.at_history_start,
            "warning": f.warning,
        }))
    }

    #[tool(
        description = "Indicators that compute_indicator can run: id, name, parameters with \
                       their kind, range and default, and output series.",
        annotations(read_only_hint = true)
    )]
    async fn list_indicators(&self) -> ToolResult {
        let list = self.engine.indicators().await;
        let indicators: Vec<Value> = list
            .indicators
            .iter()
            .map(|i| {
                json!({
                    "id": i.meta.id,
                    "name": i.meta.name,
                    "version": i.meta.version,
                    "description": i.meta.description,
                    "builtin": i.builtin,
                    "repaints": i.repaints,
                    "params": i.meta.params,
                    "series": i.meta.series,
                })
            })
            .collect();
        ok(json!({ "indicators": indicators, "failed": list.failed, "error": list.error }))
    }

    #[tool(
        description = "Runs an indicator in the app's sandbox over the cached bars of a pair \
                       (at most 100 000, refreshed first) and returns its last lastN values \
                       with their bar times. Values are null before the indicator has enough \
                       bars.",
        annotations(read_only_hint = true)
    )]
    async fn compute_indicator(&self, Parameters(p): Parameters<IndicatorInput>) -> ToolResult {
        let tf = timeframe(&p.timeframe)?;
        let last_n = capped("lastN", p.last_n, 200, MAX_BARS)?;
        let list = self.engine.indicators().await;
        let Some(info) = list.indicators.iter().find(|i| i.meta.id == p.id) else {
            let ids: Vec<&str> = list.indicators.iter().map(|i| i.meta.id.as_str()).collect();
            return Err(format!(
                "no indicator {:?}; available: {}",
                p.id,
                ids.join(", ")
            ));
        };
        let meta = &info.meta;
        let given = p.params.unwrap_or_default();
        let params = given
            .iter()
            .map(|(k, v)| Ok((k.clone(), param_value(meta, k, v)?)))
            .collect::<Result<Vec<_>, String>>()?;
        let inst = self.instrument(&p.source, &p.symbol).await?;
        let f = self.fetch(&inst.id, tf, last_n, None, None).await?;
        let (times, computed) = self
            .engine
            .compute_indicator(&inst.id, tf, &meta.id, params.clone(), last_n)
            .await
            .map_err(err)?;
        let used: Map<String, Value> = meta
            .params
            .iter()
            .map(|spec| {
                let v = params
                    .iter()
                    .find(|(k, _)| *k == spec.id)
                    .map_or(&spec.default, |(_, v)| v);
                (spec.id.clone(), param_json(v))
            })
            .collect();
        let series: Vec<Value> = computed
            .series
            .into_iter()
            .map(|s| match s.data {
                SeriesData::Values(v) => json!({
                    "id": s.id,
                    "values": v.into_iter().map(|x| x.is_finite().then_some(x)).collect::<Vec<_>>(),
                }),
                SeriesData::Markers(m) => json!({
                    "id": s.id,
                    "markers": m.into_iter().map(|m| json!({
                        "time": times.get(m.index as usize),
                        "shape": m.shape,
                        "text": m.text,
                    })).collect::<Vec<_>>(),
                }),
            })
            .collect();
        ok(json!({
            "indicator": meta.id,
            "params": used,
            "source": inst.id.source,
            "symbol": inst.id.symbol,
            "timeframe": tf.code(),
            "times": times,
            "series": series,
            "log": (!computed.log.is_empty()).then_some(computed.log),
            "warning": f.warning,
        }))
    }

    #[tool(
        description = "The drawings of a pair, in paint order, with prices in ticks at \
                       priceScale.",
        annotations(read_only_hint = true)
    )]
    async fn list_drawings(&self, Parameters(p): Parameters<PairInput>) -> ToolResult {
        let inst = self.instrument(&p.source, &p.symbol).await?;
        let drawings = self.engine.drawings(&inst.id).await.map_err(err)?;
        ok(json!({
            "instrument": wire::instrument(&inst),
            "drawings": drawings.iter().map(wire::drawing).collect::<Vec<_>>(),
        }))
    }

    #[tool(
        description = "Saves a drawing (new, or replacing the one with the same id) with the \
                       app's rules. Kinds: trend, hline, rect, fib, position, brush, note. The \
                       app shows it when it next loads the pair.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn save_drawing(&self, Parameters(p): Parameters<DrawingInput>) -> ToolResult {
        let inst = self.instrument(&p.source, &p.symbol).await?;
        let d = Drawing {
            id: p.id.unwrap_or_else(|| new_id("mcp")),
            instrument: inst.id,
            price_scale: p.price_scale,
            body: p.body,
            style: p.style.unwrap_or(DEFAULT_STYLE),
            locked: p.locked.unwrap_or(false),
            z: p.z.unwrap_or(0),
            updated_at: 0,
        };
        let saved = self.engine.save_drawing(d).await.map_err(err)?;
        ok(wire::drawing(&saved))
    }

    #[tool(
        description = "Deletes a drawing by id, with the alerts that follow it. An unknown id \
                       is not an error.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn delete_drawing(&self, Parameters(p): Parameters<IdInput>) -> ToolResult {
        self.engine.delete_drawing(&p.id).await.map_err(err)?;
        ok(json!({ "deleted": p.id }))
    }

    #[tool(
        description = "Outcome of a long or short position over the candles of a timeframe \
                       (fetched back from endT to the entry first, at most 5000 bars): status \
                       open, take or stop, exitTime, ambiguous (one bar hit both; counts as \
                       stop), and r.",
        annotations(read_only_hint = true)
    )]
    async fn position_outcome(&self, Parameters(p): Parameters<PositionInput>) -> ToolResult {
        let tf = timeframe(&p.timeframe)?;
        p.position.validate()?;
        let inst = self.instrument(&p.source, &p.symbol).await?;
        // Back from the bar after endT, so an old position is reached however long ago it
        // ended; one that ends from now on reads the newest candles.
        let bar = tf.fixed_ms().unwrap_or(MONTH_MS);
        let before = Some(p.position.end_t.saturating_add(bar)).filter(|&t| t <= now_ms());
        let (entry, limit) = (p.position.entry.t, MAX_BARS as usize);
        let f = self.fetch(&inst.id, tf, limit, before, Some(entry)).await?;
        if !f.at_history_start && f.candles.first().is_some_and(|c| c.open_time > entry) {
            return Err(format!(
                "the entry is more than {MAX_BARS} bars before endT on {}; set endT closer \
                 to the entry or use a longer timeframe",
                tf.code()
            ));
        }
        let mut outcomes = self
            .engine
            .position_outcomes(&inst.id, tf, vec![(String::new(), p.position)])
            .await
            .map_err(err)?;
        let (_, outcome) = outcomes.pop().ok_or("no outcome")?;
        let mut out = json!(outcome);
        out["warning"] = json!(f.warning);
        ok(out)
    }

    #[tool(
        description = "Opens a .replay file the user named (absolute path, at most 32 MiB) \
                       and returns its trades and statistics in R, simulated again from the \
                       file's own candles and commands.",
        annotations(read_only_hint = true)
    )]
    async fn run_replay(&self, Parameters(p): Parameters<ReplayInput>) -> ToolResult {
        let path = p.path;
        let (file, sim) = tokio::task::spawn_blocking(move || {
            let bytes = read_replay(&path)?;
            ReplayFile::from_json(&bytes).map_err(|e| format!("{path:?}: {e}"))
        })
        .await
        .map_err(err)??;
        let scale = file.instrument.price_scale;
        let time = |i: u32| file.candles.get(i as usize).map(|c| c.open_time);
        ok(json!({
            "instrument": wire::instrument(&file.instrument),
            "timeframe": file.timeframe.code(),
            "candles": file.candles.len(),
            "start": file.start,
            "startTime": time(file.start),
            "current": file.current,
            "currentTime": time(file.current),
            "trades": sim.trades.iter().map(|t| wire::trade(t, scale)).collect::<Vec<_>>(),
            "stats": sim.stats,
        }))
    }

    #[tool(
        description = "Every alert, oldest first, active or fired. Alerts fire only while the \
                       Sandchart app is running.",
        annotations(read_only_hint = true)
    )]
    async fn list_alerts(&self) -> ToolResult {
        let alerts = self.engine.alerts().await.map_err(err)?;
        ok(json!({
            "alerts": alerts.iter().map(wire::alert).collect::<Vec<_>>(),
            "note": ALERTS_NOTE,
        }))
    }

    #[tool(
        description = "Arms a price alert or an alert on an hline or trend drawing; it fires \
                       once when the price crosses the level. Alerts fire only while the \
                       Sandchart app is running (it picks this one up within seconds); the \
                       app shows an OS notification.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn set_alert(&self, Parameters(p): Parameters<AlertInput>) -> ToolResult {
        let inst = self.instrument(&p.source, &p.symbol).await?;
        let a = Alert {
            id: p.id.unwrap_or_else(|| new_id("mcp")),
            instrument: inst.id,
            price_scale: p.price_scale,
            kind: p.kind,
            direction: p.direction,
            active: true,
            created_at: 0,
            triggered_at: None,
            triggered_price: None,
        };
        let saved = self.engine.set_alert(a).await.map_err(err)?;
        let mut out = wire::alert(&saved);
        out["note"] = ALERTS_NOTE.into();
        ok(out)
    }

    #[tool(
        description = "Deletes an alert by id. An unknown id is not an error.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn delete_alert(&self, Parameters(p): Parameters<IdInput>) -> ToolResult {
        self.engine.delete_alert(&p.id).await.map_err(err)?;
        ok(json!({ "deleted": p.id }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Sandchart {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "sandchart-mcp",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(INSTRUCTIONS)
    }
}
