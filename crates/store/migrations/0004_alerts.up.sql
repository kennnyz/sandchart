CREATE TABLE alerts (
    id              TEXT    PRIMARY KEY,
    source          TEXT    NOT NULL,
    symbol          TEXT    NOT NULL,
    price_scale     INTEGER NOT NULL,
    kind            TEXT    NOT NULL CHECK (kind IN ('price', 'drawing')),
    price           INTEGER,
    drawing_id      TEXT,
    direction       TEXT    NOT NULL,
    active          INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    triggered_at    INTEGER,
    triggered_price INTEGER,
    CHECK ((kind = 'price') = (price IS NOT NULL)),
    CHECK ((kind = 'drawing') = (drawing_id IS NOT NULL))
);

CREATE INDEX alerts_by_drawing ON alerts (drawing_id);
