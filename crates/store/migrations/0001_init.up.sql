CREATE TABLE instruments (
    source      TEXT    NOT NULL,
    symbol      TEXT    NOT NULL,
    base        TEXT    NOT NULL,
    quote       TEXT    NOT NULL,
    price_scale INTEGER NOT NULL,
    qty_scale   INTEGER NOT NULL,
    PRIMARY KEY (source, symbol)
);

CREATE TABLE candles (
    source    TEXT    NOT NULL,
    symbol    TEXT    NOT NULL,
    tf        TEXT    NOT NULL,
    open_time INTEGER NOT NULL,
    open      INTEGER NOT NULL,
    high      INTEGER NOT NULL,
    low       INTEGER NOT NULL,
    close     INTEGER NOT NULL,
    volume    INTEGER NOT NULL,
    PRIMARY KEY (source, symbol, tf, open_time)
) WITHOUT ROWID;

CREATE TABLE history_start (
    source    TEXT    NOT NULL,
    symbol    TEXT    NOT NULL,
    tf        TEXT    NOT NULL,
    open_time INTEGER NOT NULL,
    PRIMARY KEY (source, symbol, tf)
);

CREATE TABLE watchlist (
    position INTEGER PRIMARY KEY,
    source   TEXT NOT NULL,
    symbol   TEXT NOT NULL
);
