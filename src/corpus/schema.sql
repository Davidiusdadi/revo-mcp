-- What a build writes before the articles: the build's own records and the
-- lookup lists. The articles themselves are layer L1, one table per element
-- (src/corpus/documents.ts); the tables derived from them belong to the passes
-- (src/corpus/passes). See docs/corpus.md.

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE meta_pass (
  pass TEXT PRIMARY KEY, version INTEGER NOT NULL, input_hash TEXT,
  rows INTEGER NOT NULL, ms INTEGER NOT NULL, at TEXT NOT NULL
);

-- Lookup lists from voko-grundo/cfg (vendored in packages/voko-xml/data/cfg)
-- and revo-fonto/cfg/bibliogr.xml. `bibliogr` is not `bib`: that name is the
-- table of the <bib> element.
CREATE TABLE lng (kodo TEXT PRIMARY KEY, nomo TEXT NOT NULL, flago TEXT);
CREATE TABLE fako (kodo TEXT PRIMARY KEY, nomo TEXT NOT NULL, vinjeto TEXT);
CREATE TABLE stilo (kodo TEXT PRIMARY KEY, nomo TEXT NOT NULL);
CREATE TABLE mallongigo (mll TEXT PRIMARY KEY, nomo TEXT NOT NULL);
CREATE TABLE bibliogr (
  mll TEXT PRIMARY KEY, tip TEXT, tit TEXT, url TEXT, aut TEXT, trd TEXT, ald TEXT,
  eld TEXT                            -- JSON array of {nom,lok,dat,nro,isbn}
);
