//! SQLite cache for instruments, candles, history-start markers, the watchlist, the chart
//! indicators and drawings.
//!
//! All prices and volumes are stored as `INTEGER` ticks; floats never touch the database.

mod migrations;

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use sandchart_core::{Candle, Drawing, Instrument, InstrumentId, Timeframe};

/// Errors returned by [`Store`].
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("database schema version {found} is newer than supported version {supported}")]
    SchemaTooNew { found: u32, supported: u32 },
    #[error("limit {0} does not fit the database integer range")]
    LimitTooLarge(usize),
    #[error("a stored drawing cannot be read: {0}")]
    Json(#[from] serde_json::Error),
    #[error("an instrument can hold at most {max} drawings; delete some first")]
    TooManyDrawings { max: usize },
}

/// Most drawings one instrument can hold.
pub const MAX_DRAWINGS_PER_INSTRUMENT: usize = 2000;

/// An installed indicator module, as recorded at install time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredModule {
    pub id: String,
    pub version: String,
    pub sha256: String,
    pub repaints: bool,
    /// Milliseconds since the epoch.
    pub installed_at: i64,
}

/// An indicator on the chart. `params` and `colors` are opaque strings owned by the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredInstance {
    pub instance: String,
    pub module_id: String,
    pub params: String,
    pub colors: String,
    pub hidden: bool,
}

/// The local cache. Wraps a single SQLite connection.
pub struct Store {
    conn: Connection,
}

fn limit_to_i64(limit: usize) -> Result<i64, StoreError> {
    i64::try_from(limit).map_err(|_| StoreError::LimitTooLarge(limit))
}

fn candle_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Candle> {
    Ok(Candle {
        open_time: row.get(0)?,
        open: row.get(1)?,
        high: row.get(2)?,
        low: row.get(3)?,
        close: row.get(4)?,
        volume: row.get(5)?,
    })
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
            candle_from_row,
        )?;
        let mut out: Vec<Candle> = rows.collect::<Result<_, _>>()?;
        out.reverse();
        Ok(out)
    }

    /// Candles with `after < open_time <= until`, ascending.
    /// Runs `f` over the candles with `after < open_time <= until`, ascending, read from the
    /// database one at a time: rows `f` does not take are never fetched. A read error ends
    /// the iterator early and is returned instead of `f`'s result.
    pub fn scan_candles_between<R>(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
        after: i64,
        until: i64,
        f: impl FnOnce(&mut dyn Iterator<Item = Candle>) -> R,
    ) -> Result<R, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT open_time, open, high, low, close, volume FROM candles
             WHERE source = ?1 AND symbol = ?2 AND tf = ?3 AND open_time > ?4 AND open_time <= ?5
             ORDER BY open_time",
        )?;
        let rows = stmt.query_map(
            params![id.source, id.symbol, tf.code(), after, until],
            candle_from_row,
        )?;
        let mut failed = None;
        let mut it = rows.map_while(|r| r.map_err(|e| failed = Some(e)).ok());
        let out = f(&mut it);
        drop(it);
        match failed {
            Some(e) => Err(e.into()),
            None => Ok(out),
        }
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

    pub fn indicator_modules(&self) -> Result<Vec<StoredModule>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, version, sha256, repaints, installed_at
             FROM indicator_modules ORDER BY id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(StoredModule {
                id: row.get(0)?,
                version: row.get(1)?,
                sha256: row.get(2)?,
                repaints: row.get(3)?,
                installed_at: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Inserts a module or replaces the existing row with the same id.
    pub fn upsert_indicator_module(&mut self, m: &StoredModule) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO indicator_modules
                (id, version, sha256, repaints, installed_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![m.id, m.version, m.sha256, m.repaints, m.installed_at],
        )?;
        Ok(())
    }

    /// Removes a module and every chart instance of it, atomically.
    pub fn delete_indicator_module(&mut self, id: &str) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM indicator_instances WHERE module_id = ?1", [id])?;
        tx.execute("DELETE FROM indicator_modules WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn indicator_instances(&self) -> Result<Vec<StoredInstance>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT instance, module_id, params, colors, hidden
             FROM indicator_instances ORDER BY position",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(StoredInstance {
                instance: row.get(0)?,
                module_id: row.get(1)?,
                params: row.get(2)?,
                colors: row.get(3)?,
                hidden: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Replaces every chart instance, preserving the order of `items`.
    pub fn set_indicator_instances(&mut self, items: &[StoredInstance]) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM indicator_instances", [])?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO indicator_instances
                    (position, instance, module_id, params, colors, hidden)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for (position, i) in items.iter().enumerate() {
                stmt.execute(params![
                    position as i64,
                    i.instance,
                    i.module_id,
                    i.params,
                    i.colors,
                    i.hidden
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// The drawings of one instrument in paint order: by `z`, then by id. A row whose body or
    /// style cannot be read (a kind from a later version) is left out and logged; it stays
    /// stored and still counts toward the cap.
    pub fn drawings(&self, id: &InstrumentId) -> Result<Vec<Drawing>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, price_scale, body, style, locked, z, updated_at
             FROM drawings WHERE source = ?1 AND symbol = ?2 ORDER BY z, id",
        )?;
        let rows = stmt.query_map(params![id.source, id.symbol], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u8>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (drawing_id, price_scale, body, style, locked, z, updated_at) = row?;
            // A row this version cannot read (a kind from a later one) is skipped, not fatal.
            let parsed = serde_json::from_str(&body)
                .and_then(|body| serde_json::from_str(&style).map(|style| (body, style)));
            let (body, style) = match parsed {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("drawing {drawing_id} cannot be read: {e}");
                    continue;
                }
            };
            out.push(Drawing {
                id: drawing_id,
                instrument: id.clone(),
                price_scale,
                body,
                style,
                locked,
                z,
                updated_at,
            });
        }
        Ok(out)
    }

    /// Inserts or replaces a drawing by id. Fails when its instrument already holds
    /// [`MAX_DRAWINGS_PER_INSTRUMENT`] other drawings.
    pub fn upsert_drawing(&mut self, d: &Drawing) -> Result<(), StoreError> {
        let body = serde_json::to_string(&d.body)?;
        let style = serde_json::to_string(&d.style)?;
        let tx = self.conn.transaction()?;
        let others: i64 = tx.query_row(
            "SELECT COUNT(*) FROM drawings WHERE source = ?1 AND symbol = ?2 AND id != ?3",
            params![d.instrument.source, d.instrument.symbol, d.id],
            |row| row.get(0),
        )?;
        if others >= limit_to_i64(MAX_DRAWINGS_PER_INSTRUMENT)? {
            return Err(StoreError::TooManyDrawings {
                max: MAX_DRAWINGS_PER_INSTRUMENT,
            });
        }
        tx.execute(
            "INSERT OR REPLACE INTO drawings
                (id, source, symbol, price_scale, body, style, locked, z, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                d.id,
                d.instrument.source,
                d.instrument.symbol,
                d.price_scale,
                body,
                style,
                d.locked,
                d.z,
                d.updated_at
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Removes a drawing; an unknown id is not an error.
    pub fn delete_drawing(&mut self, id: &str) -> Result<(), StoreError> {
        self.conn
            .execute("DELETE FROM drawings WHERE id = ?1", [id])?;
        Ok(())
    }
}
