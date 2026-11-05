// Cairn passkey ceremonies (no bundler; an ES module). Uses PublicKeyCredential JSON helpers when present.
import { safeNext as guard } from "./safe-next.js";

(() => {
  const safeNext = (raw, fallback) => guard(raw, fallback, location.origin);
  const enc = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const dec = (s) => {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
  };
  async function post(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
      credentials: "same-origin",
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (j.reauth) {
        location.href = j.reauth;
        throw new Error("Confirm with an existing passkey first…");
      }
      throw new Error(j.error || r.statusText);
    }
    return j;
  }
  const createOpts = (o) =>
    window.PublicKeyCredential?.parseCreationOptionsFromJSON
      ? PublicKeyCredential.parseCreationOptionsFromJSON(o)
      : {
          ...o,
          challenge: dec(o.challenge),
          user: { ...o.user, id: dec(o.user.id) },
          excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: dec(c.id) })),
        };
  const getOpts = (o) =>
    window.PublicKeyCredential?.parseRequestOptionsFromJSON
      ? PublicKeyCredential.parseRequestOptionsFromJSON(o)
      : { ...o, challenge: dec(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: dec(c.id) })) };
  const toJSON = (cred) => {
    if (typeof cred.toJSON === "function") return cred.toJSON();
    const r = cred.response,
      out = {
        id: cred.id,
        rawId: enc(cred.rawId),
        type: cred.type,
        clientExtensionResults: cred.getClientExtensionResults(),
        authenticatorAttachment: cred.authenticatorAttachment,
        response: { clientDataJSON: enc(r.clientDataJSON) },
      };
    if (r.attestationObject) {
      out.response.attestationObject = enc(r.attestationObject);
      out.response.transports = r.getTransports ? r.getTransports() : [];
    }
    if (r.authenticatorData) {
      out.response.authenticatorData = enc(r.authenticatorData);
      out.response.signature = enc(r.signature);
      if (r.userHandle) out.response.userHandle = enc(r.userHandle);
    }
    return out;
  };
  const say = (el, msg, isErr) => {
    const t = el.querySelector("[data-status]") || document.getElementById("status");
    if (t) {
      t.textContent = msg;
      t.className = isErr ? "error" : "muted";
    }
  };
  const formNext = (form, fallback) => safeNext(form.dataset.next || new URLSearchParams(location.search).get("next") || fallback, fallback);

  async function signup(form) {
    const fd = new FormData(form);
    const opts = await post("/auth/signup/options", {
      username: fd.get("username"),
      invite: fd.get("invite") || undefined,
      setupToken: fd.get("setupToken") || undefined,
    });
    const cred = await navigator.credentials.create({ publicKey: createOpts(opts.options) });
    const res = await post("/auth/signup/verify", { challengeId: opts.challengeId, response: toJSON(cred) });
    form.hidden = true;
    const box = document.getElementById("recovery");
    box.querySelector(".codes").textContent = res.recoveryCodes.join("\n");
    box.querySelector("a.continue").href = formNext(form, "/app");
    box.hidden = false;
  }
  async function login(form) {
    const opts = await post("/auth/login/options", {});
    const cred = await navigator.credentials.get({ publicKey: getOpts(opts.options) });
    await post("/auth/login/verify", { challengeId: opts.challengeId, response: toJSON(cred) });
    location.href = formNext(form, "/app");
  }
  async function addPasskey(form) {
    const fd = new FormData(form);
    const opts = await post("/auth/passkey/options", { name: fd.get("name") || "" });
    const cred = await navigator.credentials.create({ publicKey: createOpts(opts.options) });
    await post("/auth/passkey/verify", { challengeId: opts.challengeId, response: toJSON(cred), name: fd.get("name") || "" });
    location.href = "/app/settings/account?msg=Passkey%20added.";
  }
  async function reauth(form) {
    const opts = await post("/auth/reauth/options", {});
    const cred = await navigator.credentials.get({ publicKey: getOpts(opts.options) });
    await post("/auth/reauth/verify", { challengeId: opts.challengeId, response: toJSON(cred) });
    location.href = formNext(form, "/app/settings/account");
  }
  const actions = { signup, login, "add-passkey": addPasskey, reauth };
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest ? e.target.closest("[data-copy]") : null;
    if (!btn) return;
    const el = document.getElementById(btn.dataset.copy);
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.textContent);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Copy failed: select and copy by hand";
    }
  });
  document.addEventListener("submit", async (e) => {
    const form = e.target;
    const fn = actions[form.dataset.passkey];
    if (!fn) return;
    e.preventDefault();
    if (!window.PublicKeyCredential) return say(form, "This browser does not support passkeys.", true);
    say(form, "Waiting for your passkey…");
    try {
      await fn(form);
    } catch (err) {
      say(form, err && err.name === "NotAllowedError" ? "Cancelled." : err.message || String(err), true);
    }
  });
})();
