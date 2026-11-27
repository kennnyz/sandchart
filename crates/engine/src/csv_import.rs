//! Import of local OHLCV files as the `csv` source.

use std::path::Path;

use sandchart_core::{
    Candle, DecimalError, Instrument, InstrumentId, JS_SAFE_MAX, Timeframe, parse_scaled,
};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::{CSV_SOURCE, Engine, EngineError, lock};

const HEADER: [&str; 6] = ["time", "open", "high", "low", "close", "volume"];

struct Row<'a> {
    time_ms: i64,
    open: &'a str,
    high: &'a str,
    low: &'a str,
    close: &'a str,
    volume: &'a str,
}

fn csv_err(line: usize, msg: impl std::fmt::Display) -> EngineError {
    EngineError::Csv(format!("line {line}: {msg}"))
}

/// Milliseconds as an integer, or an RFC 3339 timestamp.
fn parse_time(s: &str) -> Option<i64> {
    if let Ok(ms) = s.parse::<i64>() {
        return Some(ms);
    }
    let t = OffsetDateTime::parse(s, &Rfc3339).ok()?;
    i64::try_from(t.unix_timestamp_nanos() / 1_000_000).ok()
}

/// Decimal places after dropping trailing zeros (`"1.50"` is 1).
fn decimals(s: &str) -> usize {
    s.split_once('.')
        .map_or(0, |(_, frac)| frac.trim_end_matches('0').len())
}

fn parse_rows(text: &str) -> Result<Vec<Row<'_>>, EngineError> {
    let mut lines = text.lines().enumerate();
    let (_, header) = lines
        .next()
        .ok_or_else(|| EngineError::Csv("the file is empty".into()))?;
    let header = header.trim_start_matches('\u{feff}');
    let names: Vec<String> = header.split(',').map(|c| c.trim().to_lowercase()).collect();
    if names != HEADER {
        return Err(EngineError::Csv(format!(
            "expected the header {}",
            HEADER.join(",")
        )));
    }
    let mut rows = Vec::new();
    for (i, line) in lines {
        if line.trim().is_empty() {
            continue;
        }
        let n = i + 1;
        let cols: Vec<&str> = line.split(',').map(str::trim).collect();
        let [time, open, high, low, close, volume] = cols[..] else {
            return Err(csv_err(n, "expected 6 columns"));
        };
        let time_ms = parse_time(time).ok_or_else(|| csv_err(n, "unreadable time"))?;
        rows.push(Row {
            time_ms,
            open,
            high,
            low,
            close,
            volume,
        });
    }
    if rows.is_empty() {
        return Err(EngineError::Csv("the file has no data rows".into()));
    }
    Ok(rows)
}

fn scale(max_decimals: usize) -> Result<u8, EngineError> {
    u8::try_from(max_decimals).map_err(|_| EngineError::Decimal(DecimalError::Overflow))
}

fn tick(s: &str, scale: u8, line: usize) -> Result<i64, EngineError> {
    let v = parse_scaled(s, scale).map_err(|e| csv_err(line, format!("{s:?}: {e}")))?;
    if v.abs() > JS_SAFE_MAX {
        return Err(csv_err(line, format!("{s:?} is too large")));
    }
    Ok(v)
}

impl Engine {
    /// Imports `path` (header `time,open,high,low,close,volume`, time in ms or RFC 3339)
    /// as instrument `csv/<symbol>` on `tf`.
    ///
    /// Scales are the largest number of decimals seen in the price columns and in the
    /// volume column. When the instrument already exists its scales are kept, so candles
    /// stored earlier stay valid; data needing more decimals is rejected.
    pub fn import_csv(
        &self,
        path: &Path,
        symbol: &str,
        tf: Timeframe,
    ) -> Result<InstrumentId, EngineError> {
        let text = std::fs::read_to_string(path)?;
        let rows = parse_rows(&text)?;
        let id = InstrumentId {
            source: CSV_SOURCE.to_owned(),
            symbol: symbol.to_owned(),
        };

        let mut store = lock(&self.shared.store);
        let (price_scale, qty_scale) = match store.instrument(&id)? {
            Some(existing) => (existing.price_scale, existing.qty_scale),
            None => {
                let price = rows
                    .iter()
                    .flat_map(|r| [r.open, r.high, r.low, r.close])
                    .map(decimals)
                    .max()
                    .unwrap_or(0);
                let qty = rows.iter().map(|r| decimals(r.volume)).max().unwrap_or(0);
                (scale(price)?, scale(qty)?)
            }
        };

        let mut candles = Vec::with_capacity(rows.len());
        for (i, r) in rows.iter().enumerate() {
            let line = i + 2; // header is line 1; blank lines are rare enough to ignore here
            candles.push(Candle {
                open_time: r.time_ms,
                open: tick(r.open, price_scale, line)?,
                high: tick(r.high, price_scale, line)?,
                low: tick(r.low, price_scale, line)?,
                close: tick(r.close, price_scale, line)?,
                volume: tick(r.volume, qty_scale, line)?,
            });
        }
        candles.sort_by_key(|c| c.open_time);

        store.upsert_instruments(&[Instrument {
            id: id.clone(),
            base: symbol.to_owned(),
            quote: String::new(),
            price_scale,
            qty_scale,
        }])?;
        store.upsert_candles(&id, tf, &candles)?;
        Ok(id)
    }
}
