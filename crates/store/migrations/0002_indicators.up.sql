CREATE TABLE indicator_modules (
    id           TEXT    PRIMARY KEY,
    version      TEXT    NOT NULL,
    sha256       TEXT    NOT NULL,
    repaints     INTEGER NOT NULL,
    installed_at INTEGER NOT NULL
);

CREATE TABLE indicator_instances (
    position   INTEGER PRIMARY KEY,
    instance   TEXT NOT NULL UNIQUE,
    module_id  TEXT NOT NULL,
    params     TEXT NOT NULL,
    colors     TEXT NOT NULL,
    hidden     INTEGER NOT NULL
);
