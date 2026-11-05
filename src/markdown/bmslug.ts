// Basic Memory's permalink for a file path, so notes imported from Basic Memory keep the addresses
// Basic Memory gave them (memory:// URLs and permalinks people and agents remember). Written from
// Basic Memory's documented behaviour (generate_permalink's docstring and examples) and checked
// against Jeff's live notes; not copied from its AGPL code.
//
// The rule: NFC; drop a known file extension; transliterate to ASCII; split camelCase ("iOS" →
// "i-os"); lower-case; "_" → "-"; drop apostrophes; anything but [a-z0-9/-.] → "-"; collapse runs
// of "-"; trim "-" from each path segment. Periods survive ("version-2.0.0"). Paths with CJK keep
// their ideographs, with "-" between CJK and Latin runs and full-width punctuation removed.
//
// Transliteration approximates Python's unidecode: accents stripped via NFKD, a table for common
// punctuation, ligatures and Cyrillic, and anything else non-ASCII (emoji…) dropped, as unidecode
// does. Scripts outside those (Greek, Arabic…) may differ from Basic Memory's.

const EXT = /\.(md|markdown|mdown|mkd|txt|html?|json|csv|pdf|png|jpe?g|gif|webp|svg)$/i;

const TABLE: Record<string, string> = {
  "—": "--", // em dash
  "–": "-", // en dash
  "‒": "-",
  "―": "--",
  "‐": "-",
  "‑": "-",
  "‘": "'",
  "’": "'",
  "‚": ",",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": ",,",
  "…": "...",
  "•": "*",
  "·": "*",
  " ": " ",
  ß: "ss",
  Æ: "AE",
  æ: "ae",
  Ø: "O",
  ø: "o",
  Œ: "OE",
  œ: "oe",
  Ł: "L",
  ł: "l",
  Đ: "D",
  đ: "d",
  Þ: "Th",
  þ: "th",
  Ð: "D",
  ð: "d",
  "×": "x",
  "÷": "/",
  "©": "(c)",
  "®": "(r)",
  "™": "(tm)",
  "€": "EUR",
  "£": "PS",
  "¥": "Y=",
  "°": "deg",
  "±": "+-",
  "«": "<<",
  "»": ">>",
  "¿": "?",
  "¡": "!",
};

const CYRILLIC =
  "А A Б B В V Г G Д D Е E Ё E Ж Zh З Z И I Й I К K Л L М M Н N О O П P Р R С S Т T У U Ф F Х Kh Ц Ts Ч Ch Ш Sh Щ Shch Ъ ' Ы Y Ь ' Э E Ю Iu Я Ia";
{
  const parts = CYRILLIC.split(" ");
  for (let i = 0; i < parts.length; i += 2) {
    TABLE[parts[i]] = parts[i + 1];
    TABLE[parts[i].toLowerCase()] = parts[i + 1].toLowerCase();
  }
}

/** One character as unidecode would write it in ASCII (possibly empty). */
function ascii(ch: string): string {
  if (ch.charCodeAt(0) < 0x80) return ch;
  const t = TABLE[ch];
  if (t !== undefined) return t;
  const stripped = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  for (let i = 0; i < stripped.length; i++) if (stripped.charCodeAt(i) >= 0x80) return "";
  return stripped;
}

const isCjk = (c: string) => (c >= "一" && c <= "鿿") || (c >= "　" && c <= "〿") || (c >= "㐀" && c <= "䶿");
const isFullwidth = (c: string) => c >= "＀" && c <= "￯";

/** Basic Memory's permalink for a project-relative file path (no project prefix). */
export function bmPermalink(filePath: string): string {
  const path = filePath.normalize("NFC").replace(/\\/g, "/");
  const base = path.replace(EXT, "");
  const chars = [...base];
  let clean: string;
  if (chars.some((c) => isCjk(c) || isFullwidth(c))) {
    let s = "";
    for (const c of chars) {
      if (isCjk(c)) s += c;
      else if (isFullwidth(c)) continue;
      else s += ascii(c);
    }
    const cjk = "\\u4e00-\\u9fff\\u3000-\\u303f\\u3400-\\u4dbf";
    s = s.replace(new RegExp(`([${cjk}])([a-zA-Z0-9])`, "gu"), "$1-$2").replace(new RegExp(`([a-zA-Z0-9])([${cjk}])`, "gu"), "$1-$2");
    s = s.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
    s = [...s].map((c) => (c.charCodeAt(0) < 0x80 ? c.toLowerCase() : c)).join("");
    s = s.replace(/_/g, "-").replace(/'/g, "");
    clean = s.replace(new RegExp(`[^a-z0-9${cjk}/\\-.]`, "gu"), "-");
  } else {
    let s = chars.map(ascii).join("");
    s = s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    s = s.replace(/_/g, "-").replace(/'/g, "");
    clean = s.replace(/[^a-z0-9/\-.]/g, "-");
  }
  clean = clean.replace(/-+/g, "-");
  return clean
    .split("/")
    .map((seg) => seg.replace(/^-+|-+$/g, ""))
    .join("/");
}
