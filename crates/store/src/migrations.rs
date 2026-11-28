//! Embedded schema migrations, versioned through `PRAGMA user_version`.

use rusqlite::Connection;

use crate::{StoreError, write};

struct Migration {
    up: &'static str,
    down: &'static str,
}

/// Index `i` holds the migration that moves the schema from version `i` to `i + 1`.
const MIGRATIONS: &[Migration] = &[
    Migration {
        up: include_str!("../migrations/0001_init.up.sql"),
        down: include_str!("../migrations/0001_init.down.sql"),
    },
    Migration {
        up: include_str!("../migrations/0002_indicators.up.sql"),
        down: include_str!("../migrations/0002_indicators.down.sql"),
    },
    Migration {
        up: include_str!("../migrations/0003_drawings.up.sql"),
        down: include_str!("../migrations/0003_drawings.down.sql"),
    },
    Migration {
        up: include_str!("../migrations/0004_alerts.up.sql"),
        down: include_str!("../migrations/0004_alerts.down.sql"),
    },
    Migration {
        up: include_str!("../migrations/0005_drawing_hidden.up.sql"),
        down: include_str!("../migrations/0005_drawing_hidden.down.sql"),
    },
];

fn user_version(conn: &Connection) -> Result<u32, StoreError> {
    Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

fn set_user_version(conn: &Connection, version: u32) -> Result<(), StoreError> {
    // PRAGMA arguments cannot be bound; `version` is a `u32`, so formatting is safe.
    conn.execute_batch(&format!("PRAGMA user_version = {version};"))?;
    Ok(())
}

fn latest() -> u32 {
    // The migration list is a small compile-time constant.
    u32::try_from(MIGRATIONS.len()).unwrap_or(u32::MAX)
}

/// Applies every pending migration in one write transaction. The version is read inside
/// it, so a second process opening the same old file at the same time waits and then finds
/// the work done instead of applying a migration twice. With `upgrade` false only a
/// brand-new file (version 0) is migrated; an older schema is refused and left as it is.
pub(crate) fn up(conn: &mut Connection, upgrade: bool) -> Result<(), StoreError> {
    let tx = write(conn)?;
    let current = user_version(&tx)?;
    if current > latest() {
        return Err(StoreError::SchemaTooNew {
            found: current,
            supported: latest(),
        });
    }
    if current == latest() {
        return Ok(());
    }
    if !upgrade && current != 0 {
        return Err(StoreError::SchemaTooOld {
            found: current,
            supported: latest(),
        });
    }
    for migration in &MIGRATIONS[current as usize..] {
        tx.execute_batch(migration.up)?;
    }
    set_user_version(&tx, latest())?;
    tx.commit()?;
    Ok(())
}

/// Reverts migrations, newest first, until the schema is at `target`.
pub(crate) fn down_to(conn: &mut Connection, target: u32) -> Result<(), StoreError> {
    let current = user_version(conn)?;
    if current > latest() {
        return Err(StoreError::SchemaTooNew {
            found: current,
            supported: latest(),
        });
    }
    for index in (target as usize..current as usize).rev() {
        let tx = write(conn)?;
        tx.execute_batch(MIGRATIONS[index].down)?;
        set_user_version(&tx, index as u32)?;
        tx.commit()?;
    }
    Ok(())
}
