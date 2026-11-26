// MK Prod landing page: nav, mobile menu, scroll reveals, tagline word reveal.
(function () {
  "use strict";
  var doc = document.documentElement;
  doc.classList.add("js");
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ---------- mobile menu ----------
  var toggle = document.querySelector(".menu-toggle");
  var menu = document.getElementById("mobile-menu");
  if (toggle && menu) {
    var items = menu.querySelectorAll("li");
    // 60ms per step, whole sequence capped at 400ms
    var step = Math.min(60, items.length > 1 ? 400 / (items.length - 1) : 60);
    items.forEach(function (li, i) { li.style.setProperty("--i", String(i * step / 60)); });

    var setOpen = function (open) {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      document.body.style.overflow = open ? "hidden" : "";
      if (open) {
        menu.hidden = false;
        requestAnimationFrame(function () { requestAnimationFrame(function () { menu.classList.add("open"); }); });
      } else {
        menu.classList.remove("open");
        setTimeout(function () { if (!menu.classList.contains("open")) menu.hidden = true; }, 300);
      }
    };
    toggle.addEventListener("click", function () { setOpen(toggle.getAttribute("aria-expanded") !== "true"); });
    menu.addEventListener("click", function (e) { if (e.target.closest("a")) setOpen(false); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") { setOpen(false); toggle.focus(); }
    });
    window.matchMedia("(min-width: 821px)").addEventListener("change", function (m) { if (m.matches) setOpen(false); });
  }

  if (!("IntersectionObserver" in window)) {
    document.querySelectorAll(".reveal").forEach(function (el) { el.classList.add("in"); });
    document.querySelectorAll("[data-words]").forEach(function (el) { el.classList.add("static"); });
    return;
  }

  // ---------- scroll reveals (once) ----------
  var revealer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) { entry.target.classList.add("in"); revealer.unobserve(entry.target); }
    });
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.05 });
  document.querySelectorAll(".reveal").forEach(function (el) { revealer.observe(el); });

  // ---------- current section in nav ----------
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav-links a[href^="#"]'));
  var sections = navLinks.map(function (a) { return document.querySelector(a.getAttribute("href")); }).filter(Boolean);
  var hero = document.querySelector(".hero");
  if (hero) sections.unshift(hero);
  var spy = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      navLinks.forEach(function (a) {
        if (a.getAttribute("href") === "#" + entry.target.id) a.setAttribute("aria-current", "true");
        else a.removeAttribute("aria-current");
      });
    });
  }, { rootMargin: "-45% 0px -50% 0px" });
  sections.forEach(function (s) { spy.observe(s); });

  // ---------- tagline: words light up one by one as they cross a trigger line ----------
  document.querySelectorAll("[data-words]").forEach(function (el) {
    var words = el.textContent.trim().split(/\s+/);
    el.setAttribute("aria-label", words.join(" "));
    el.textContent = "";
    words.forEach(function (w, i) {
      var span = document.createElement("span");
      span.className = "w";
      span.setAttribute("aria-hidden", "true");
      span.textContent = w;
      el.appendChild(span);
      if (i < words.length - 1) el.appendChild(document.createTextNode(" "));
    });
    var spans = el.querySelectorAll(".w");
    if (reduce.matches) { spans.forEach(function (s) { s.classList.add("on"); }); return; }

    var ticking = false;
    var update = function () {
      ticking = false;
      var rect = el.getBoundingClientRect();
      var vh = window.innerHeight;
      // progress 0 when the block's top reaches 85% of the viewport, 1 when its bottom reaches 45%
      var start = vh * 0.85, end = vh * 0.45;
      var progress = (start - rect.top) / (start - end + rect.height * 0.6);
      progress = Math.max(0, Math.min(1, progress));
      var lit = Math.round(progress * spans.length);
      for (var i = 0; i < spans.length; i++) spans[i].classList.toggle("on", i < lit);
    };
    var onScroll = function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } };

    // Only listen while the tagline is near the viewport.
    var active = false;
    new IntersectionObserver(function (entries) {
      var visible = entries[0].isIntersecting;
      if (visible && !active) { window.addEventListener("scroll", onScroll, { passive: true }); window.addEventListener("resize", onScroll); active = true; update(); }
      else if (!visible && active) { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); active = false; update(); }
    }, { rootMargin: "20% 0px 20% 0px" }).observe(el);
  });
})();
