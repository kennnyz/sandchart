//! SQLite cache for instruments, candles, history-start markers and the watchlist.
//!
//! All prices and volumes are stored as `INTEGER` ticks; floats never touch the database.

mod migrations;

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use sandchart_core::{Candle, Instrument, InstrumentId, Timeframe};

/// Errors returned by [`Store`].
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("database schema version {found} is newer than supported version {supported}")]
    SchemaTooNew { found: u32, supported: u32 },
    #[error("limit {0} does not fit the database integer range")]
    LimitTooLarge(usize),
}

/// The local cache. Wraps a single SQLite connection.
pub struct Store {
    conn: Connection,
}

fn limit_to_i64(limit: usize) -> Result<i64, StoreError> {
    i64::try_from(limit).map_err(|_| StoreError::LimitTooLarge(limit))
}

fn instrument_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Instrument> {
    Ok(Instrument {
        id: InstrumentId {
            source: row.get(0)?,
            symbol: row.get(1)?,
        },
        base: row.get(2)?,
        quote: row.get(3)?,
        price_scale: row.get(4)?,
        qty_scale: row.get(5)?,
    })
}

impl Store {
    /// Opens (creating if needed) the database at `path` and applies pending migrations.
    pub fn open(path: &Path) -> Result<Store, StoreError> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        Self::init(conn)
    }

    /// Opens a private in-memory database with the latest schema.
    pub fn open_in_memory() -> Result<Store, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Store, StoreError> {
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        migrations::up(&mut conn)?;
        Ok(Store { conn })
    }

    /// Reverts migrations until the schema version is `version` (0 removes every table).
    pub fn migrate_down_to(&mut self, version: u32) -> Result<(), StoreError> {
        migrations::down_to(&mut self.conn, version)
    }

    pub fn upsert_instruments(&mut self, items: &[Instrument]) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO instruments (source, symbol, base, quote, price_scale, qty_scale)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (source, symbol) DO UPDATE SET
                    base = excluded.base,
                    quote = excluded.quote,
                    price_scale = excluded.price_scale,
                    qty_scale = excluded.qty_scale",
            )?;
            for i in items {
                stmt.execute(params![
                    i.id.source,
                    i.id.symbol,
                    i.base,
                    i.quote,
                    i.price_scale,
                    i.qty_scale
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn instrument(&self, id: &InstrumentId) -> Result<Option<Instrument>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT source, symbol, base, quote, price_scale, qty_scale
                 FROM instruments WHERE source = ?1 AND symbol = ?2",
                params![id.source, id.symbol],
                instrument_from_row,
            )
            .optional()?)
    }

    /// Case-insensitive symbol search: exact match first, then prefix, then substring;
    /// ties are ordered by symbol.
    pub fn search_instruments(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<Instrument>, StoreError> {
        let limit = limit_to_i64(limit)?;
        let q = query.to_lowercase();
        let mut stmt = self.conn.prepare_cached(
            "SELECT source, symbol, base, quote, price_scale, qty_scale
             FROM instruments
             WHERE instr(lower(symbol), ?1) > 0
             ORDER BY CASE
                        WHEN lower(symbol) = ?1 THEN 0
                        WHEN instr(lower(symbol), ?1) = 1 THEN 1
                        ELSE 2
                      END,
                      symbol, source
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![q, limit], instrument_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Inserts candles in one transaction; a candle with an existing `open_time` replaces it.
    pub fn upsert_candles(
        &mut self,
        id: &InstrumentId,
        tf: Timeframe,
        candles: &[Candle],
    ) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT OR REPLACE INTO candles
                    (source, symbol, tf, open_time, open, high, low, close, volume)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;
            for c in candles {
                stmt.execute(params![
                    id.source,
                    id.symbol,
                    tf.code(),
                    c.open_time,
                    c.open,
                    c.high,
                    c.low,
                    c.close,
                    c.volume
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// The `limit` newest candles with `open_time < before` (all when `None`),
    /// returned in ascending `open_time` order.
    pub fn candles_before(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
        before: Option<i64>,
        limit: usize,
    ) -> Result<Vec<Candle>, StoreError> {
        let limit = limit_to_i64(limit)?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT open_time, open, high, low, close, volume FROM candles
             WHERE source = ?1 AND symbol = ?2 AND tf = ?3 AND open_time < ?4
             ORDER BY open_time DESC
             LIMIT ?5",
        )?;
        let rows = stmt.query_map(
            params![
                id.source,
                id.symbol,
                tf.code(),
                before.unwrap_or(i64::MAX),
                limit
            ],
            |row| {
                Ok(Candle {
                    open_time: row.get(0)?,
                    open: row.get(1)?,
                    high: row.get(2)?,
                    low: row.get(3)?,
                    close: row.get(4)?,
                    volume: row.get(5)?,
                })
            },
        )?;
        let mut out: Vec<Candle> = rows.collect::<Result<_, _>>()?;
        out.reverse();
        Ok(out)
    }

    pub fn newest_open_time(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
    ) -> Result<Option<i64>, StoreError> {
        // MAX() over zero rows yields one NULL row, hence Option<i64> inside the row.
        Ok(self.conn.query_row(
            "SELECT MAX(open_time) FROM candles WHERE source = ?1 AND symbol = ?2 AND tf = ?3",
            params![id.source, id.symbol, tf.code()],
            |row| row.get(0),
        )?)
    }

    /// Records the earliest `open_time` the exchange has for this series.
    pub fn set_history_start(
        &mut self,
        id: &InstrumentId,
        tf: Timeframe,
        open_time: i64,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO history_start (source, symbol, tf, open_time)
             VALUES (?1, ?2, ?3, ?4)",
            params![id.source, id.symbol, tf.code(), open_time],
        )?;
        Ok(())
    }

    pub fn history_start(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
    ) -> Result<Option<i64>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT open_time FROM history_start
                 WHERE source = ?1 AND symbol = ?2 AND tf = ?3",
                params![id.source, id.symbol, tf.code()],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Removes every candle and the history-start marker of one series, atomically.
    pub fn delete_series(&mut self, id: &InstrumentId, tf: Timeframe) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        for table in ["candles", "history_start"] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE source = ?1 AND symbol = ?2 AND tf = ?3"),
                params![id.source, id.symbol, tf.code()],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn watchlist(&self) -> Result<Vec<InstrumentId>, StoreError> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT source, symbol FROM watchlist ORDER BY position")?;
        let rows = stmt.query_map([], |row| {
            Ok(InstrumentId {
                source: row.get(0)?,
                symbol: row.get(1)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Replaces the whole watchlist, preserving the order of `ids`.
    pub fn set_watchlist(&mut self, ids: &[InstrumentId]) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM watchlist", [])?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO watchlist (position, source, symbol) VALUES (?1, ?2, ?3)",
            )?;
            for (position, id) in ids.iter().enumerate() {
                stmt.execute(params![position as i64, id.source, id.symbol])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}
