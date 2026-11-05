// Parody easter eggs (loaded only when Serious mode is off). Nothing here is needed to use Cairn.
(() => {
  // Konami code toggles "Rated M for Memory" mode for this tab.
  const code = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
  let pos = 0;
  const KEY = "cairn-rated-m";
  const store = {
    get: () => {
      try {
        return sessionStorage.getItem(KEY) === "1";
      } catch {
        return false;
      }
    },
    set: (on) => {
      try {
        if (on) sessionStorage.setItem(KEY, "1");
        else sessionStorage.removeItem(KEY);
      } catch {
        /* storage blocked: the mode just won't survive navigation */
      }
    },
  };

  function ratedM(on) {
    document.documentElement.classList.toggle("rated-m", on);
    document.querySelector(".rated-m-banner")?.remove();
    store.set(on);
    if (!on) return;
    const banner = document.createElement("div");
    banner.className = "rated-m-banner";
    banner.setAttribute("role", "status");
    const badge = document.createElement("span");
    badge.className = "rated-m-badge";
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = "M";
    const text = document.createElement("p");
    text.textContent = "Rated M for Memory. Contains intense recall, mild markdown and scenes of extreme linking.";
    const off = document.createElement("button");
    off.type = "button";
    off.className = "secondary";
    off.textContent = "I'm not ready";
    off.addEventListener("click", () => ratedM(false));
    banner.append(badge, text, off);
    document.body.append(banner);
  }

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    pos = k === code[pos] ? pos + 1 : k === code[0] ? 1 : 0;
    if (pos === code.length) {
      pos = 0;
      ratedM(!document.documentElement.classList.contains("rated-m"));
    }
  });
  if (store.get()) ratedM(true);

  // Absurd loading copy on the button that submitted a form (unless a script took over the submit).
  const lines = [
    "Consulting the stones…",
    "Stacking rocks…",
    "Reticulating cairns…",
    "Asking the elephant…",
    "Indexing your vibes…",
    "Remembering harder…",
    "Aligning the markdown…",
    "Synergising recall…",
  ];
  document.addEventListener("submit", (e) => {
    const b = e.submitter;
    if (e.defaultPrevented || !(b instanceof HTMLButtonElement) || b.classList.contains("danger")) return;
    b.dataset.label = b.textContent;
    b.textContent = lines[Math.floor(Math.random() * lines.length)];
    e.target.setAttribute("aria-busy", "true");
  });
  // Coming back with the Back button restores the page from cache: put the labels back.
  window.addEventListener("pageshow", () => {
    for (const b of document.querySelectorAll("button[data-label]")) {
      b.textContent = b.dataset.label;
      delete b.dataset.label;
      b.closest("form")?.removeAttribute("aria-busy");
    }
  });
})();
