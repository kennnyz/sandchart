CREATE TABLE drawings (
    id          TEXT    PRIMARY KEY,
    source      TEXT    NOT NULL,
    symbol      TEXT    NOT NULL,
    price_scale INTEGER NOT NULL,
    body        TEXT    NOT NULL,
    style       TEXT    NOT NULL,
    locked      INTEGER NOT NULL,
    hidden      INTEGER NOT NULL,
    z           INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX drawings_by_instrument ON drawings (source, symbol);
