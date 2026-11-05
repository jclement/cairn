// Progressive enhancement only: the pages work without this file.
(function () {
  "use strict";

  // Copy buttons on code blocks (connect page).
  document.querySelectorAll(".codeblock").forEach(function (block) {
    var btn = block.querySelector(".copy");
    var code = block.querySelector("code");
    if (!btn || !code || !navigator.clipboard) return;
    btn.hidden = false;
    btn.addEventListener("click", function () {
      navigator.clipboard.writeText(code.textContent.trim()).then(function () {
        btn.textContent = "Copied ✓";
        setTimeout(function () { btn.textContent = "Copy"; }, 1600);
      }, function () {
        btn.textContent = "Select & copy";
      });
    });
  });

  // "Seconds of perfect recall on this page" in the ticker.
  var counters = document.querySelectorAll("[data-uptime]");
  if (counters.length) {
    var start = Date.now();
    var tick = function () {
      var s = Math.floor((Date.now() - start) / 1000).toLocaleString();
      counters.forEach(function (el) { el.textContent = s; });
    };
    tick();
    setInterval(tick, 1000);
  }
  // "Real* users": one quote at a time from /landing/quotes.json, crossfading every ~6 s.
  // Without JS the six quotes in the HTML show as a grid. Auto-rotation stops on hover or
  // focus, with the Pause button, and never starts under prefers-reduced-motion.
  var stage = document.querySelector(".ru-stage");
  if (stage && window.fetch) {
    var list = stage.querySelector(".ru-list");
    var controls = stage.querySelector(".ru-controls");
    var nextBtn = stage.querySelector('[data-ru="next"]');
    var pauseBtn = stage.querySelector('[data-ru="pause"]');
    var count = stage.querySelector('[data-ru="count"]');
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var pool = [].map.call(list.querySelectorAll(".ru-item"), function (li) {
      var who = li.querySelector(".ru-who");
      var b = who.querySelector("b");
      return { quote: li.querySelector("blockquote p").textContent, who: b.textContent, role: who.textContent.slice(b.textContent.length + 2) };
    });
    var shuffle = function (a) {
      for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
      return a;
    };
    shuffle(pool);
    var idx = 0, timer = null, paused = false, hovering = false;
    list.innerHTML = '<li class="ru-item"><blockquote><p></p></blockquote><p class="ru-who"><b></b><span></span></p></li>';
    var item = list.firstChild, qEl = item.querySelector("blockquote p"), wEl = item.querySelector(".ru-who b"), rEl = item.querySelector(".ru-who span");
    var render = function () {
      var q = pool[idx % pool.length];
      qEl.textContent = q.quote; wEl.textContent = q.who; rEl.textContent = ", " + q.role;
      count.textContent = (idx % pool.length) + 1 + " of " + pool.length;
    };
    var show = function (step, announce) {
      list.setAttribute("aria-live", announce ? "polite" : "off");
      idx += step;
      if (reduce) { render(); return; }
      item.classList.add("ru-out");
      setTimeout(function () { render(); item.classList.remove("ru-out"); }, 450);
    };
    var schedule = function () {
      clearInterval(timer); timer = null;
      if (!reduce && !paused && !hovering) timer = setInterval(function () { show(1, false); }, 6000);
    };
    stage.parentNode.classList.add("ru-js");
    controls.hidden = false;
    if (reduce) { pauseBtn.hidden = true; }
    render();
    schedule();
    nextBtn.addEventListener("click", function () { show(1, true); schedule(); });
    pauseBtn.addEventListener("click", function () {
      paused = !paused;
      pauseBtn.setAttribute("aria-pressed", String(paused));
      pauseBtn.textContent = paused ? "Play" : "Pause";
      schedule();
    });
    var hold = function () { hovering = true; schedule(); };
    var release = function () { hovering = stage.matches(":hover") || stage.contains(document.activeElement); schedule(); };
    stage.addEventListener("mouseenter", hold);
    stage.addEventListener("mouseleave", function () { hovering = false; release(); });
    stage.addEventListener("focusin", hold);
    stage.addEventListener("focusout", function () { setTimeout(release, 0); });
    fetch(stage.getAttribute("data-quotes"), { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (all) {
        if (!Array.isArray(all) || !all.length) return;
        var seen = {}; pool.forEach(function (q) { seen[q.quote] = 1; });
        var rest = shuffle(all.filter(function (q) { return q && q.quote && !seen[q.quote]; }));
        // Keep what is already on screen first, then the rest of the pool.
        pool = pool.slice(0, idx + 1).concat(rest, pool.slice(idx + 1));
        render();
      })
      .catch(function () {});
  }
})();
