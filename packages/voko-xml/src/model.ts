/**
 * The VOKO vocabulary, transcribed from voko-grundo/dtd/vokoxml.dtd (see the
 * Esperanto comments there for the real documentation). This is the complete
 * element and attribute inventory; `inventory()` in walk.ts checks a corpus
 * against it so that nothing upstream adds goes unnoticed.
 */

export const ELEMENTS = [
  // frame
  "vortaro", "prologo", "epilogo", "titolo", "autoro", "alineo", "precipa-parto", "parto", "sekcio",
  // article structure
  "art", "subart", "drv", "var", "subdrv", "snc", "subsnc", "sncref",
  // descriptive elements
  "kap", "rad", "ofc", "fnt", "gra", "vspec", "uzo", "dif", "ekz", "rim", "refgrp", "ref",
  "lstref", "tezrad", "trdgrp", "trd", "ind", "pr", "baz", "mll", "ke", "bld", "mrk", "adm",
  // text styles
  "tld", "klr", "bib", "vrk", "lok", "aut", "frm", "g", "k", "em", "ts", "sup", "sub", "ctl",
  "mis", "url", "mlg", "nom", "nac", "esc",
] as const;
export type ElementName = (typeof ELEMENTS)[number];
export const ELEMENT_SET: ReadonlySet<string> = new Set(ELEMENTS);

/** Declared attributes per element (ATTLIST). Elements absent here declare none. */
export const ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  parto: ["lng"],
  sekcio: ["lit"],
  art: ["mrk"],
  subart: ["mrk"],
  drv: ["mrk"],
  subdrv: ["mrk"],
  snc: ["mrk", "num", "ref"],
  subsnc: ["mrk", "ref"],
  sncref: ["ref"],
  rad: ["var"],
  uzo: ["tip"],
  dif: ["lng", "fnt"],
  ekz: ["mrk"],
  rim: ["num", "mrk"],
  refgrp: ["tip"],
  ref: ["tip", "cel", "lst", "val"],
  lstref: ["lst"],
  tezrad: ["fak"],
  trdgrp: ["lng"],
  trd: ["lng", "fnt", "kod"],
  mll: ["tip"],
  bld: ["lok", "mrk", "tip", "alt", "lrg", "prm"],
  mrk: ["stl", "cel"],
  tld: ["lit", "var"],
  klr: ["tip"],
  frm: ["am"],
  url: ["ref"],
  mlg: ["kod"],
};

/** Structural nodes: the things that carry headwords/senses and that `mrk`s point at. */
export const NODE_KINDS = ["art", "subart", "drv", "subdrv", "snc", "subsnc"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export const NODE_KIND_SET: ReadonlySet<string> = new Set(NODE_KINDS);

export const REF_TYPES = ["vid", "hom", "dif", "sin", "ant", "super", "sub", "prt", "malprt", "lst", "ekz"] as const;
export type RefType = (typeof REF_TYPES)[number];

export const UZO_TYPES = ["fak", "reg", "klr", "stl"] as const;
export type UzoType = (typeof UZO_TYPES)[number];
