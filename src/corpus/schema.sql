-- L2: canonical tables mirroring the VOKO XML 1:1. Only what the XML says.
-- Integer PKs; `mrk` kept where the XML has one; `key` = stable path key
-- (art file + kind ordinals) so enrichment tables can reference rows across
-- rebuilds; `xml` = the exact fragment (entities expanded) so anything not
-- yet modelled stays recoverable. See docs/corpus.md.

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE meta_pass (
  pass TEXT PRIMARY KEY, version INTEGER NOT NULL, input_hash TEXT,
  rows INTEGER NOT NULL, ms INTEGER NOT NULL, at TEXT NOT NULL
);

CREATE TABLE art (
  id INTEGER PRIMARY KEY,
  file TEXT NOT NULL UNIQUE,          -- 'san'  (= article key)
  rad TEXT NOT NULL,                  -- 'san'
  rev TEXT, modified TEXT,            -- from the CVS $Id: stamp
  source TEXT NOT NULL,               -- 'fonto' | 'overlay'
  xml TEXT NOT NULL                   -- the whole <art> element
);

-- Structural nodes: art > subart? > drv > subdrv? > snc > subsnc.
CREATE TABLE node (
  id INTEGER PRIMARY KEY,
  art_id INTEGER NOT NULL REFERENCES art(id),
  parent_id INTEGER REFERENCES node(id),
  kind TEXT NOT NULL,                 -- art|subart|drv|subdrv|snc|subsnc
  key TEXT NOT NULL UNIQUE,           -- 'san/drv[0]/snc[1]'
  mrk TEXT,                           -- 'san.0a.saniga' (may be NULL on snc)
  mrk_near TEXT,                      -- own mrk or nearest ancestor's (what old tables key on)
  num TEXT, ref TEXT,
  ord INTEGER NOT NULL,               -- ordinal among same-kind siblings
  kap_id INTEGER                      -- headword: own <kap>, else nearest ancestor's (set after extraction)
);
CREATE INDEX idx_node_art ON node(art_id);
CREATE INDEX idx_node_kap ON node(kap_id);
CREATE INDEX idx_node_mrk ON node(mrk);
CREATE INDEX idx_node_parent ON node(parent_id);
CREATE INDEX idx_node_mrk_near ON node(mrk_near);

-- Headwords. One row per <kap>; variants (<var><kap>) point at their parent kap.
CREATE TABLE kap (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES node(id),
  parent_kap_id INTEGER REFERENCES kap(id),
  txt TEXT NOT NULL,                  -- 'malsanulejo'
  tilde TEXT NOT NULL,                -- 'mal~ulejo'
  norm TEXT NOT NULL,                 -- unicode-lowercased txt
  ofc TEXT,                           -- '*', '1'..'9'
  rad_var TEXT,                       -- <rad var="…"> inside this kap
  ord INTEGER NOT NULL,
  xml TEXT NOT NULL
);
CREATE INDEX idx_kap_node ON kap(node_id);
CREATE INDEX idx_kap_norm ON kap(norm);

CREATE TABLE dif (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES node(id),
  ord INTEGER NOT NULL,
  lng TEXT,
  txt TEXT NOT NULL,                  -- plain text; nested ekz/fnt/trdgrp excluded, inline trd kept
  xml TEXT NOT NULL
);
CREATE INDEX idx_dif_node ON dif(node_id);

-- Examples. owner = the element the <ekz> sits in: node|dif|rim|klr|var|kap.
CREATE TABLE ekz (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES node(id),
  owner_kind TEXT NOT NULL, owner_id INTEGER,
  ord INTEGER NOT NULL,               -- ordinal among ekz of the node (document order)
  key TEXT NOT NULL UNIQUE,           -- '<node key>/ekz[n]'
  mrk TEXT,
  txt TEXT NOT NULL,                  -- citations dropped, tildes expanded
  ind TEXT,                           -- text of <ind>, if any
  xml TEXT NOT NULL
);
CREATE INDEX idx_ekz_node ON ekz(node_id);

CREATE TABLE rim (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES node(id),
  ord INTEGER NOT NULL, num TEXT, mrk TEXT,
  txt TEXT NOT NULL, xml TEXT NOT NULL
);
CREATE INDEX idx_rim_node ON rim(node_id);

-- Translations. owner = node|dif|ekz|klr|bld; grp = ordinal of the enclosing
-- <trdgrp> within the owner (NULL when the <trd> stands alone).
CREATE TABLE trd (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES node(id),
  owner_kind TEXT NOT NULL, owner_id INTEGER,
  lng TEXT NOT NULL,
  grp INTEGER, ord INTEGER NOT NULL,
  txt TEXT NOT NULL,                  -- the translation itself (klr/pr/baz/ofc excluded)
  ind TEXT, baz TEXT, pr TEXT, klr TEXT, ofc TEXT,
  kod TEXT, fnt TEXT,                 -- the trd attributes
  xml TEXT NOT NULL
);
CREATE INDEX idx_trd_node ON trd(node_id);
-- traduko.trd is COALESCE(ind, txt); db.ts matches it case-insensitively
-- (old idx_traduko_lng_trd), so index that exact expression.
CREATE INDEX idx_trd_lng_key ON trd(lng, COALESCE(ind, txt) COLLATE NOCASE);
CREATE INDEX idx_trd_key ON trd(COALESCE(ind, txt) COLLATE NOCASE);

-- Typed references. owner = node|dif|ekz|rim|klr|ke|mrk(bld mark);
-- grp = ordinal of the enclosing <refgrp> (tip inherited from it).
CREATE TABLE ref (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES node(id),
  owner_kind TEXT NOT NULL, owner_id INTEGER,
  tip TEXT,                           -- vid|hom|dif|sin|ant|super|sub|prt|malprt|lst|ekz|NULL
  cel TEXT NOT NULL,
  lst TEXT, val TEXT,
  grp INTEGER, ord INTEGER NOT NULL,
  txt TEXT NOT NULL,
  xml TEXT NOT NULL
);
CREATE INDEX idx_ref_node ON ref(node_id);
CREATE INDEX idx_ref_cel ON ref(cel);

-- Citations. owner = node|kap|ekz|rim.
CREATE TABLE fnt (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES node(id),
  owner_kind TEXT NOT NULL, owner_id INTEGER,
  ord INTEGER NOT NULL,
  bib TEXT, aut TEXT, vrk TEXT, lok TEXT, url TEXT,
  txt TEXT NOT NULL, xml TEXT NOT NULL
);
CREATE INDEX idx_fnt_node ON fnt(node_id);
CREATE INDEX idx_fnt_bib ON fnt(bib);

-- Usage tags. owner = node|ekz|var|dif|rim.
CREATE TABLE uzo (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES node(id),
  owner_kind TEXT NOT NULL, owner_id INTEGER,
  tip TEXT,                           -- fak|reg|klr|stl
  txt TEXT NOT NULL,
  ord INTEGER NOT NULL
);
CREATE INDEX idx_uzo_node ON uzo(node_id);

CREATE TABLE gra (id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL REFERENCES node(id), vspec TEXT, txt TEXT NOT NULL);
CREATE TABLE bld (
  id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL REFERENCES node(id),
  owner_kind TEXT NOT NULL, owner_id INTEGER,
  lok TEXT NOT NULL, mrk TEXT, tip TEXT, alt TEXT, lrg TEXT, prm TEXT, txt TEXT NOT NULL, xml TEXT NOT NULL
);
CREATE TABLE mlg (id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL REFERENCES node(id), kod TEXT, txt TEXT NOT NULL);
CREATE TABLE tezrad (id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL REFERENCES node(id), fak TEXT);
CREATE TABLE lstref (id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL REFERENCES node(id), lst TEXT NOT NULL, txt TEXT NOT NULL);
CREATE TABLE adm (id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL REFERENCES node(id), txt TEXT NOT NULL, xml TEXT NOT NULL);
CREATE TABLE sncref (id INTEGER PRIMARY KEY, node_id INTEGER NOT NULL REFERENCES node(id), owner_kind TEXT NOT NULL, owner_id INTEGER, ref TEXT);

-- Lookup lists from voko-grundo/cfg (vendored in packages/voko-xml/data/cfg)
-- and revo-fonto/cfg/bibliogr.xml.
CREATE TABLE lng (kodo TEXT PRIMARY KEY, nomo TEXT NOT NULL, flago TEXT);
CREATE TABLE fako (kodo TEXT PRIMARY KEY, nomo TEXT NOT NULL, vinjeto TEXT);
CREATE TABLE stilo (kodo TEXT PRIMARY KEY, nomo TEXT NOT NULL);
CREATE TABLE mallongigo (mll TEXT PRIMARY KEY, nomo TEXT NOT NULL);
CREATE TABLE bib (
  mll TEXT PRIMARY KEY, tip TEXT, tit TEXT, url TEXT, aut TEXT, trd TEXT, ald TEXT,
  eld TEXT,                           -- JSON array of {nom,lok,dat,nro,isbn}
  xml TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Compatibility views: the shape src/db.ts queries today (upstream's
-- revo-skemo.sql). Keyed on mrk_near, i.e. sense-level rows attach to the
-- nearest marked ancestor exactly as upstream's index does.
CREATE VIEW nodo AS
  SELECT n.mrk AS mrk, a.file AS art, k.txt AS kap, n.num AS num, k.norm AS kap_norm
  FROM node n
  JOIN art a ON a.id = n.art_id
  JOIN kap k ON k.id = n.kap_id
  WHERE n.mrk IS NOT NULL AND n.kind <> 'art';

CREATE VIEW var AS
  -- an article-level variant (<art><kap>…<var>) has no mrk of its own;
  -- upstream files it under the article's first derivation
  SELECT COALESCE(n.mrk_near,
           (SELECT d.mrk FROM node d WHERE d.art_id = n.art_id AND d.kind = 'drv'
              AND d.mrk IS NOT NULL ORDER BY d.id LIMIT 1)) AS mrk, k.txt AS kap, k.rad_var AS var, k.norm AS kap_norm
  FROM kap k JOIN node n ON n.id = k.node_id
  WHERE k.parent_kap_id IS NOT NULL;

CREATE VIEW traduko AS
  -- rowid = trd.id = fts_trd.rowid, so db.ts's fts_trd→traduko joins work unchanged.
  -- trd = the <ind> (index form) when the translation marks one, as upstream:
  -- "nőstény <ind>méh</ind>" is found as "méh"; txt keeps the full text.
  -- ind is exposed as well: a row that has one is filed *under* its index form
  -- rather than being it, which is what ranking a search hit turns on.
  SELECT t.id AS rowid, n.mrk_near AS mrk, t.lng AS lng, COALESCE(t.ind, t.txt) AS trd,
         CASE WHEN t.pr IS NULL THEN t.txt ELSE t.txt || ' ' || t.pr END AS txt,
         t.ind AS ind
  FROM trd t JOIN node n ON n.id = t.node_id
  -- upstream leaves out translations of example sentences (proverbs etc.);
  -- they stay in trd for tools that want them
  WHERE n.mrk_near IS NOT NULL AND t.owner_kind <> 'ekz';

CREATE VIEW referenco AS
  SELECT n.mrk_near AS mrk, r.cel AS cel, COALESCE(r.tip, '') AS tip
  FROM ref r JOIN node n ON n.id = r.node_id
  WHERE n.mrk_near IS NOT NULL;

CREATE VIEW uzo_compat AS
  -- upstream names the fak tip 'uzo' and has no klr/reg rows.
  SELECT n.mrk_near AS mrk, CASE u.tip WHEN 'fak' THEN 'uzo' ELSE u.tip END AS tip, u.txt AS uzo
  FROM uzo u JOIN node n ON n.id = u.node_id
  WHERE n.mrk_near IS NOT NULL AND u.tip IN ('fak', 'stl') AND u.owner_kind <> 'ekz';

CREATE VIEW artikolo AS
  SELECT file AS mrk, xml AS txt FROM art;
