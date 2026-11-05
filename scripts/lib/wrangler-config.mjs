// Edit the top-level instance values in wrangler.jsonc as text, so comments and layout survive.
// The top-level config comes before `env.local` in the file, so the first occurrence of each key
// is the top-level one. Pure (no Node APIs): the setup script and the tests both use it.

/** Strip // and /* *\/ comments outside strings, for reading JSONC with JSON.parse. */
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      i = i < 0 ? text.length : i + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}

/** First match of `re` that isn't inside a // comment. */
function replaceFirst(text, re, replacement, what) {
  const g = new RegExp(re.source, "g");
  let m = g.exec(text);
  while (m && /\/\//.test(text.slice(text.lastIndexOf("\n", m.index) + 1, m.index))) m = g.exec(text);
  if (!m) throw new Error(`wrangler.jsonc: couldn't find ${what}`);
  return text.slice(0, m.index) + m[0].replace(re, replacement) + text.slice(m.index + m[0].length);
}

const q = (s) => JSON.stringify(s);

/**
 * Set this instance's values: { d1Id, kvId, publicUrl, customDomain (host or null), email (address
 * or ""), openSignup (bool) }. Only the given keys change. Returns the new text, verified to parse
 * and to carry the values at the top level.
 */
export function setInstanceValues(text, v) {
  let t = text;
  if (v.d1Id !== undefined) t = replaceFirst(t, /("database_id"\s*:\s*)"[^"]*"/, `$1${q(v.d1Id)}`, "d1_databases[0].database_id");
  if (v.kvId !== undefined) t = replaceFirst(t, /("kv_namespaces"\s*:\s*\[\s*\{\s*"binding"\s*:\s*"OAUTH_KV"\s*,\s*"id"\s*:\s*)"[^"]*"/, `$1${q(v.kvId)}`, "kv_namespaces[0].id");
  if (v.publicUrl !== undefined) t = replaceFirst(t, /("PUBLIC_URL"\s*:\s*)"[^"]*"/, `$1${q(v.publicUrl)}`, "vars.PUBLIC_URL");
  if (v.email !== undefined) t = replaceFirst(t, /("INBOUND_EMAIL_ADDRESS"\s*:\s*)"[^"]*"/, `$1${q(v.email)}`, "vars.INBOUND_EMAIL_ADDRESS");
  if (v.openSignup !== undefined) t = replaceFirst(t, /("OPEN_SIGNUP"\s*:\s*)"[^"]*"/, `$1${q(v.openSignup ? "true" : "false")}`, "vars.OPEN_SIGNUP");
  if (v.customDomain !== undefined) {
    const routes = v.customDomain ? `[{ "pattern": ${q(v.customDomain)}, "custom_domain": true }]` : "[]";
    t = replaceFirst(t, /("routes"\s*:\s*)\[[^\]]*\]/, `$1${routes}`, "routes");
  }
  // Verify: parses, and the top level now says what we set (env.local untouched).
  const c = parseJsonc(t);
  const check = (cond, what) => {
    if (!cond) throw new Error(`wrangler.jsonc: ${what} didn't take effect at the top level`);
  };
  if (v.d1Id !== undefined) check(c.d1_databases?.[0]?.database_id === v.d1Id, "database_id");
  if (v.kvId !== undefined) check(c.kv_namespaces?.[0]?.id === v.kvId, "kv id");
  if (v.publicUrl !== undefined) check(c.vars?.PUBLIC_URL === v.publicUrl, "PUBLIC_URL");
  if (v.email !== undefined) check(c.vars?.INBOUND_EMAIL_ADDRESS === v.email, "INBOUND_EMAIL_ADDRESS");
  if (v.customDomain !== undefined) check(JSON.stringify(c.routes) === JSON.stringify(v.customDomain ? [{ pattern: v.customDomain, custom_domain: true }] : []), "routes");
  check(c.env?.local?.vars?.PUBLIC_URL === "http://localhost:8787", "env.local (must stay untouched)");
  return t;
}

/** The instance's public URL as configured (top level). */
export function publicUrlOf(text) {
  return parseJsonc(text).vars?.PUBLIC_URL;
}
