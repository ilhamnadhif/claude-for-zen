// Page-side runtime. `installRuntime` is serialized with Function.prototype.toString
// and evaluated inside a WebDriver BiDi *sandbox* (an isolated world: page scripts
// cannot see or tamper with it). It must stay fully self-contained.

/* eslint-disable no-undef */
export function installRuntime() {
  const G = globalThis;
  if (G.__cz && G.__cz.v === 3) return;

  const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const idToRef = new Map();
  const elToId = new WeakMap();
  let nextId = 1;
  const hasWeakRef = typeof WeakRef === "function";

  function idFor(el) {
    let id = elToId.get(el);
    if (!id) {
      id = nextId++;
      elToId.set(el, id);
      idToRef.set(id, hasWeakRef ? new WeakRef(el) : { deref: () => el });
    }
    return id;
  }

  function get(id, tok) {
    if (tok && tok !== token) throw new Error("STALE: the page has navigated or reloaded since this ref was created");
    const ref = idToRef.get(Number(id));
    const el = ref && ref.deref();
    if (!el || !el.isConnected) throw new Error("STALE: element is no longer on the page");
    return el;
  }

  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const q = (s) => JSON.stringify(s);

  const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "title", "base", "br", "wbr"]);
  const INPUT_ROLE = {
    button: "button", submit: "button", reset: "button", image: "button", file: "button", color: "button",
    checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox",
    email: "textbox", tel: "textbox", text: "textbox", url: "textbox", password: "textbox",
    date: "textbox", "datetime-local": "textbox", month: "textbox", time: "textbox", week: "textbox",
  };
  const TAG_ROLE = {
    button: "button", select: null, textarea: "textbox", option: "option", optgroup: "group",
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    nav: "navigation", main: "main", aside: "complementary", form: "form", article: "article",
    dialog: "dialog", ul: "list", ol: "list", menu: "list", li: "listitem", table: "table",
    thead: "rowgroup", tbody: "rowgroup", tfoot: "rowgroup", tr: "row", td: "cell", th: "columnheader",
    label: "label", summary: "button", details: "group", fieldset: "group", legend: "legend",
    p: "paragraph", iframe: "iframe", frame: "iframe", video: "video", audio: "audio", canvas: "canvas",
    progress: "progressbar", meter: "meter", hr: "separator", blockquote: "blockquote", pre: "code",
    figure: "figure", figcaption: "caption", caption: "caption", dl: "list", dt: "term", dd: "definition",
    img: "img", svg: null, header: null, footer: null, section: null, a: null, area: null, input: null,
  };
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option",
    "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem",
  ]);
  const NAME_FROM_CONTENT = new Set([
    "button", "link", "heading", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "cell",
    "columnheader", "rowheader", "label", "checkbox", "radio", "switch", "treeitem", "tooltip", "legend",
    "caption", "term", "listitem", "paragraph", "code", "blockquote",
  ]);

  function roleOf(el) {
    const explicit = clean(el.getAttribute("role")).split(" ")[0];
    if (explicit && explicit !== "none" && explicit !== "presentation") return explicit;
    if (explicit === "none" || explicit === "presentation") return "generic";
    const tag = el.localName;
    if (tag === "a" || tag === "area") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "hidden") return "hidden";
      if (el.hasAttribute("list") && ["text", "search", "email", "tel", "url"].includes(t)) return "combobox";
      return INPUT_ROLE[t] || "textbox";
    }
    if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "img") return el.getAttribute("alt") === "" ? "generic" : "img";
    if (tag === "svg") return el.getAttribute("aria-label") || el.querySelector(":scope > title") ? "img" : "generic";
    if (tag === "header") return el.closest("article,aside,main,nav,section") ? "generic" : "banner";
    if (tag === "footer") return el.closest("article,aside,main,nav,section") ? "generic" : "contentinfo";
    if (tag === "section") return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : "generic";
    const r = TAG_ROLE[tag];
    if (r) return r;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return "textbox";
    return "generic";
  }

  function textContentName(el) {
    let t = "";
    try {
      t = el.innerText;
    } catch {}
    if (!t) t = el.textContent || "";
    t = clean(t);
    if (!t) {
      // icon-only controls: use the first img alt / svg title / aria-label inside
      const inner = el.querySelector("img[alt], svg title, [aria-label]");
      if (inner) t = clean(inner.getAttribute("alt") || inner.getAttribute("aria-label") || inner.textContent);
    }
    return t;
  }

  function nameOf(el, role) {
    const doc = el.ownerDocument;
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = clean(
        labelledby
          .split(/\s+/)
          .map((id) => doc.getElementById(id))
          .filter(Boolean)
          .map((e) => e.textContent)
          .join(" "),
      );
      if (t) return trunc(t, 150);
    }
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return trunc(aria, 150);
    const tag = el.localName;
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && ["button", "submit", "reset"].includes(t)) {
        return trunc(clean(el.value) || (t === "submit" ? "Submit" : t === "reset" ? "Reset" : ""), 150);
      }
      if (tag === "input" && t === "image") return trunc(clean(el.getAttribute("alt") || el.value || "Submit"), 150);
      try {
        if (el.labels && el.labels.length) {
          const lt = clean(Array.from(el.labels).map((l) => l.textContent).join(" "));
          if (lt) return trunc(lt, 150);
        }
      } catch {}
      const title = clean(el.getAttribute("title"));
      if (title) return trunc(title, 150);
      const ph = clean(el.getAttribute("placeholder"));
      if (ph) return trunc(ph, 150);
      return "";
    }
    if (tag === "img" || tag === "area") {
      const alt = clean(el.getAttribute("alt"));
      if (alt) return trunc(alt, 150);
    }
    if (tag === "svg") {
      const t = el.querySelector(":scope > title");
      if (t) return trunc(clean(t.textContent), 150);
    }
    if (tag === "iframe" || tag === "frame") return trunc(clean(el.getAttribute("title") || el.getAttribute("name")), 150);
    if (tag === "fieldset") {
      const lg = el.querySelector(":scope > legend");
      if (lg) return trunc(clean(lg.textContent), 150);
    }
    if (tag === "table") {
      const c = el.querySelector(":scope > caption");
      if (c) return trunc(clean(c.textContent), 150);
    }
    if (tag === "figure") {
      const c = el.querySelector(":scope > figcaption");
      if (c) return trunc(clean(c.textContent), 150);
    }
    if (NAME_FROM_CONTENT.has(role)) {
      const t = textContentName(el);
      if (t) return trunc(t, 150);
    }
    const title = clean(el.getAttribute("title"));
    if (title) return trunc(title, 150);
    return "";
  }

  function hasBox(el) {
    const rects = el.getClientRects();
    for (let i = 0; i < rects.length; i++) if (rects[i].width > 0 && rects[i].height > 0) return true;
    return false;
  }

  function isHidden(el) {
    try {
      if (typeof el.checkVisibility === "function") {
        if (el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
        const st = el.ownerDocument.defaultView.getComputedStyle(el);
        return st.display !== "contents";
      }
      const st = el.ownerDocument.defaultView.getComputedStyle(el);
      return st.display === "none" || st.visibility === "hidden";
    } catch {
      return false;
    }
  }

  let pointerCheckBudget = 0;
  function isPointer(el) {
    if (pointerCheckBudget <= 0) return false;
    pointerCheckBudget--;
    try {
      const win = el.ownerDocument.defaultView;
      if (win.getComputedStyle(el).cursor !== "pointer") return false;
      const p = el.parentElement;
      return !p || win.getComputedStyle(p).cursor !== "pointer";
    } catch {
      return false;
    }
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_ROLES.has(role)) return true;
    const tag = el.localName;
    if (tag === "summary" || tag === "iframe" || tag === "frame") return true;
    if ((tag === "video" || tag === "audio") && el.hasAttribute("controls")) return true;
    if (el.hasAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && parseInt(ti, 10) >= 0) return true;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return true;
    return isPointer(el);
  }

  function shadowOf(el) {
    try {
      if (el.openOrClosedShadowRoot) return el.openOrClosedShadowRoot;
    } catch {}
    return el.shadowRoot || null;
  }

  function childrenOf(node) {
    if (node.nodeType === 1) {
      const sr = shadowOf(node);
      if (sr) return Array.from(sr.childNodes);
      if (node.localName === "slot") {
        const assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) return assigned;
      }
    }
    return Array.from(node.childNodes);
  }

  function* allElements(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === 1) {
        if (SKIP.has(node.localName)) continue;
        yield node;
      }
      const kids = childrenOf(node);
      for (let i = kids.length - 1; i >= 0; i--) if (kids[i].nodeType === 1 || kids[i].nodeType === 11) stack.push(kids[i]);
    }
  }

  function stateParts(el, role, name) {
    const parts = [];
    const tag = el.localName;
    if (role === "link") {
      const raw = el.getAttribute("href") || "";
      if (raw) parts.push(`href=${q(trunc(/^\s*javascript:/i.test(raw) ? "javascript:…" : el.href || raw, 150))}`);
    }
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (!["text", "checkbox", "radio", "button", "submit", "reset"].includes(t)) parts.push(`type=${t}`);
      if (t === "password") {
        if (el.value) parts.push(`value="••••••"`);
      } else if (t === "file") {
        if (el.files && el.files.length) parts.push(`files=${q(Array.from(el.files).map((f) => f.name).join(", "))}`);
      } else if (!["checkbox", "radio", "button", "submit", "reset", "image"].includes(t) && el.value) {
        parts.push(`value=${q(trunc(el.value, 120))}`);
      }
    } else if (tag === "textarea") {
      if (el.value) parts.push(`value=${q(trunc(el.value, 120))}`);
    } else if (tag === "select") {
      const sel = Array.from(el.selectedOptions || []).map((o) => clean(o.label || o.text));
      if (sel.length) parts.push(`value=${q(trunc(sel.join(", "), 120))}`);
    } else if (role === "textbox" && el.isContentEditable) {
      const t = clean(el.innerText);
      if (t) parts.push(`value=${q(trunc(t, 120))}`);
    }
    const ph = clean(el.getAttribute("placeholder"));
    if (ph && ph !== name) parts.push(`placeholder=${q(trunc(ph, 80))}`);
    if (["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)) {
      const checked = tag === "input" ? el.checked : el.getAttribute("aria-checked") === "true";
      parts.push(checked ? "checked" : "unchecked");
    }
    if ((role === "option" || role === "tab" || role === "treeitem") && (el.selected || el.getAttribute("aria-selected") === "true")) parts.push("selected");
    if (role === "heading") parts.push(`level=${el.getAttribute("aria-level") || (/^h([1-6])$/.exec(tag) || [])[1] || 2}`);
    const exp = el.getAttribute("aria-expanded");
    if (exp === "true") parts.push("expanded");
    else if (exp === "false") parts.push("collapsed");
    if (el.getAttribute("aria-pressed") === "true") parts.push("pressed");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    if ((tag === "input" || tag === "textarea") && el.readOnly) parts.push("readonly");
    if (el.required || el.getAttribute("aria-required") === "true") parts.push("required");
    if (el.getAttribute("aria-invalid") === "true") parts.push("invalid");
    if (tag === "iframe" || tag === "frame") {
      const src = el.getAttribute("src");
      if (src) parts.push(`src=${q(trunc(el.src || src, 120))}`);
    }
    if (tag === "img" && !name) {
      const src = el.currentSrc || el.src;
      if (src && !src.startsWith("data:")) parts.push(`src=${q(trunc(src, 120))}`);
    }
    return parts;
  }

  // Name for display: clickable generic elements (div onclick, cursor:pointer) are named by their text.
  function displayName(el, role, interactive) {
    const n = nameOf(el, role);
    if (n || !interactive) return n;
    return trunc(textContentName(el), 150);
  }

  function formatLine(level, el, role, name, extra) {
    const id = idFor(el);
    const parts = stateParts(el, role, name);
    if (extra) parts.push(extra);
    return `${"  ".repeat(level)}- ${role}${name ? " " + q(name) : ""} [@${id}]${parts.length ? " " + parts.join(" ") : ""}`;
  }

  function listOptions(sel, level, out) {
    const opts = Array.from(sel.options || []);
    const max = 40;
    opts.slice(0, max).forEach((o) => {
      const label = clean(o.label || o.text);
      const val = o.value !== label ? ` value=${q(trunc(o.value, 60))}` : "";
      out.push(`${"  ".repeat(level)}- option ${q(trunc(label, 100))} [@${idFor(o)}]${o.selected ? " selected" : ""}${o.disabled ? " disabled" : ""}${val}`);
    });
    if (opts.length > max) out.push(`${"  ".repeat(level)}- … ${opts.length - max} more options`);
  }

  function snapshot(arg) {
    const filter = arg.filter === "interactive" ? "interactive" : "all";
    const maxDepth = Math.max(1, Math.min(arg.depth || 15, 100));
    const maxLines = arg.maxLines || 6000;
    const out = [];
    const frames = [];
    const doc = document;
    pointerCheckBudget = doc.getElementsByTagName("*").length > 20000 ? 0 : 20000;
    let root = doc.body || doc.documentElement;
    if (arg.id) root = get(arg.id, arg.token);
    let truncated = false;

    function visit(node, level) {
      if (out.length >= maxLines) {
        truncated = true;
        return;
      }
      if (node.nodeType === 3) {
        if (filter !== "all") return;
        const t = clean(node.nodeValue);
        if (t && level <= maxDepth) out.push(`${"  ".repeat(level)}- text ${q(trunc(t, 300))}`);
        return;
      }
      if (node.nodeType === 11) {
        for (const c of childrenOf(node)) visit(c, level);
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      const tag = el.localName;
      if (SKIP.has(tag)) return;
      const role = roleOf(el);
      if (role === "hidden") return;
      const interactive = isInteractive(el, role);

      if (filter === "interactive") {
        const hidden = isHidden(el);
        if (hidden) {
          // display:none hides the whole subtree; visibility:hidden children may still be visible.
          try {
            if (el.ownerDocument.defaultView.getComputedStyle(el).display === "none") return;
          } catch {}
        }
        if (!hidden && interactive && hasBox(el)) {
          out.push(formatLine(0, el, role, displayName(el, role, true)));
          if (tag === "select") {
            listOptions(el, 1, out);
            return;
          }
          if (tag === "iframe" || tag === "frame") {
            frames.push(idFor(el));
            out.push(`  @@FRAME:${idFor(el)}@@`);
            return;
          }
        }
        for (const c of childrenOf(el)) visit(c, 0);
        return;
      }

      // filter === "all"
      const name = displayName(el, role, interactive);
      const interesting = role !== "generic" || interactive || !!clean(el.getAttribute("aria-label"));
      if (!interesting) {
        for (const c of childrenOf(el)) visit(c, level);
        return;
      }
      if (level > maxDepth) return;
      const hidden = isHidden(el);
      out.push(formatLine(level, el, role, name, hidden ? "(hidden)" : ""));
      if (hidden) return;
      if (tag === "select") {
        listOptions(el, level + 1, out);
        return;
      }
      if (tag === "iframe" || tag === "frame") {
        frames.push(idFor(el));
        out.push(`${"  ".repeat(level + 1)}@@FRAME:${idFor(el)}@@`);
        return;
      }
      if (["input", "textarea", "img", "svg", "video", "audio", "canvas"].includes(tag)) return;
      // Name came from content: skip plain text children, still descend into elements.
      const nameFromContent = name && NAME_FROM_CONTENT.has(role) && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby");
      for (const c of childrenOf(el)) {
        if (nameFromContent && c.nodeType === 3) continue;
        visit(c, level + 1);
      }
    }

    visit(root, 0);
    return {
      token,
      text: out.join("\n"),
      frames,
      truncated,
      url: location.href,
      title: document.title,
    };
  }

  const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "with", "that", "this", "is", "at", "by", "my", "me", "find", "element", "elements"]);
  const SYNONYMS = {
    button: ["button"], btn: ["button"], link: ["link"], links: ["link"], search: ["searchbox", "textbox", "combobox"],
    input: ["textbox", "searchbox", "combobox", "spinbutton"], field: ["textbox", "searchbox", "combobox", "spinbutton"],
    box: ["textbox", "searchbox", "checkbox", "combobox"], textbox: ["textbox"], textarea: ["textbox"],
    checkbox: ["checkbox"], check: ["checkbox"], radio: ["radio"], dropdown: ["combobox", "listbox", "button"],
    select: ["combobox", "listbox"], menu: ["menu", "menuitem", "menubar", "navigation", "button"],
    tab: ["tab"], tabs: ["tab"], image: ["img"], img: ["img"], picture: ["img"], photo: ["img"], icon: ["img", "button", "link"],
    logo: ["img", "link"], heading: ["heading"], title: ["heading"], header: ["heading", "banner"],
    nav: ["navigation"], navigation: ["navigation"], toggle: ["switch", "checkbox", "button"], switch: ["switch"],
    slider: ["slider"], option: ["option"], dialog: ["dialog"], modal: ["dialog"], form: ["form"], table: ["table"],
    row: ["row"], list: ["list"], item: ["listitem", "option", "menuitem"], frame: ["iframe"], iframe: ["iframe"],
  };

  function find(arg) {
    const query = clean(arg.query).toLowerCase();
    const tokens = query.split(/[^\p{L}\p{N}@._-]+/u).filter((t) => t && !STOP.has(t));
    const results = [];
    const frames = [];
    pointerCheckBudget = document.getElementsByTagName("*").length > 20000 ? 0 : 20000;
    for (const el of allElements(document.body || document.documentElement)) {
      const tag = el.localName;
      if (tag === "iframe" || tag === "frame") frames.push(idFor(el));
      const role = roleOf(el);
      if (role === "hidden") continue;
      const interactive = isInteractive(el, role);
      let direct = "";
      for (const c of el.childNodes) if (c.nodeType === 3) direct += c.nodeValue;
      direct = clean(direct);
      if (!interactive && role === "generic" && !direct) continue;
      const displayName = nameOf(el, role) || trunc(direct, 100);
      const name = displayName.toLowerCase();
      const attrs = clean(
        ["placeholder", "aria-label", "title", "alt", "name", "value", "data-testid", "type"].map((a) => el.getAttribute(a) || "").join(" "),
      ).toLowerCase();
      const idcls = clean(`${el.id || ""} ${typeof el.className === "string" ? el.className : ""}`).toLowerCase();
      const text = (direct || (interactive ? name : "")).toLowerCase();
      let score = 0;
      let matched = 0;
      for (const t of tokens) {
        let s = 0;
        if (name.includes(t)) s = Math.max(s, 3);
        if (attrs.includes(t)) s = Math.max(s, 2);
        if ((SYNONYMS[t] || []).includes(role) || role === t) s = Math.max(s, 2);
        if (tag === t) s = Math.max(s, 2);
        if (idcls.includes(t)) s = Math.max(s, 1);
        if (text.includes(t)) s = Math.max(s, 2);
        if (s) matched++;
        score += s;
      }
      if (!score) continue;
      if (query && name && name.includes(query)) score += 4;
      if (tokens.length > 1 && matched === tokens.length) score += 2;
      if (interactive) score += 1;
      const hidden = isHidden(el) || !hasBox(el);
      if (hidden) score -= 3;
      if (score < 2) continue;
      results.push({ score, el, role, name: displayName, hidden });
    }
    results.sort((a, b) => b.score - a.score);
    const limit = arg.limit || 20;
    return {
      token,
      total: results.length,
      frames,
      matches: results.slice(0, limit).map((r) => ({ score: r.score, line: formatLine(0, r.el, r.role, r.name, r.hidden ? "(hidden)" : "") })),
    };
  }

  function inViewport(rect, win) {
    return rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth;
  }

  function visibleRect(el) {
    const win = el.ownerDocument.defaultView;
    const rects = Array.from(el.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    return rects.find((r) => inViewport(r, win)) || rects[0] || null;
  }

  function describe(el) {
    if (!el) return "nothing";
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      const role = roleOf(cur);
      if (role !== "generic" || isInteractive(cur, role)) {
        const name = nameOf(cur, role);
        return `${role}${name ? " " + q(trunc(name, 80)) : ""}`;
      }
      cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
    }
    const tag = el.localName || "node";
    const t = clean(el.textContent);
    return `<${tag}>${t ? " " + q(trunc(t, 60)) : ""}`;
  }

  function point(arg) {
    const el = get(arg.id, arg.token);
    const win = el.ownerDocument.defaultView;
    let rect = visibleRect(el);
    const fullyVisible = (r) => r && r.top >= 0 && r.left >= 0 && r.bottom <= win.innerHeight && r.right <= win.innerWidth;
    if (!rect || !fullyVisible(rect)) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      rect = visibleRect(el);
    }
    if (!rect) throw new Error("Element has no visible box (it may be hidden or zero-sized)");
    const root = el.getRootNode && el.getRootNode().elementFromPoint ? el.getRootNode() : el.ownerDocument;
    const candidates = [
      [0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.15, 0.15], [0.85, 0.85],
    ];
    const clampX = (x) => Math.min(Math.max(x, 1), win.innerWidth - 2);
    const clampY = (y) => Math.min(Math.max(y, 1), win.innerHeight - 2);
    let first = null;
    for (const [fx, fy] of candidates) {
      const x = clampX(rect.left + rect.width * fx);
      const y = clampY(rect.top + rect.height * fy);
      if (!first) first = { x, y };
      const hit = root.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit) || (hit.localName === "label" && el.labels && Array.from(el.labels).includes(hit)))) {
        return { x, y, target: describe(el) };
      }
    }
    const hit = root.elementFromPoint(first.x, first.y);
    return { x: first.x, y: first.y, target: describe(el), occludedBy: hit ? describe(hit) : null };
  }

  function scrollTo(arg) {
    const el = get(arg.id, arg.token);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return { ok: true, target: describe(el) };
  }

  function frameOffset(arg) {
    const el = get(arg.id, arg.token);
    const win = el.ownerDocument.defaultView;
    if (arg.ensureVisible) {
      const r = el.getBoundingClientRect();
      if (!inViewport(r, win)) el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }
    const r = el.getBoundingClientRect();
    const cs = win.getComputedStyle(el);
    return {
      x: r.left + el.clientLeft + (parseFloat(cs.paddingLeft) || 0),
      y: r.top + el.clientTop + (parseFloat(cs.paddingTop) || 0),
    };
  }

  function fire(el, type) {
    const win = el.ownerDocument.defaultView;
    el.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: type !== "input" && type !== "change" ? true : false }));
  }

  function formInput(arg) {
    const el = get(arg.id, arg.token);
    const value = arg.value;
    const tag = el.localName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const role = roleOf(el);
    if (el.disabled) throw new Error("Element is disabled");
    try {
      el.scrollIntoView({ block: "center", behavior: "instant" });
    } catch {}

    if (tag === "select") {
      const wanted = Array.isArray(value) ? value.map(String) : [String(value)];
      const opts = Array.from(el.options);
      const pick = (w) =>
        opts.find((o) => o.value === w) ||
        opts.find((o) => clean(o.label || o.text) === clean(w)) ||
        opts.find((o) => clean(o.label || o.text).toLowerCase() === clean(w).toLowerCase()) ||
        opts.find((o) => clean(o.label || o.text).toLowerCase().includes(clean(w).toLowerCase()));
      const chosen = wanted.map(pick);
      if (chosen.some((o) => !o)) {
        throw new Error(`No option matching ${q(String(value))}. Options: ${opts.slice(0, 30).map((o) => q(clean(o.label || o.text))).join(", ")}`);
      }
      el.focus();
      if (el.multiple) for (const o of opts) o.selected = chosen.includes(o);
      else el.value = chosen[0].value;
      fire(el, "input");
      fire(el, "change");
      return { ok: true, message: `Selected ${chosen.map((o) => q(clean(o.label || o.text))).join(", ")}` };
    }

    if ((tag === "input" && (type === "checkbox" || type === "radio")) || ["checkbox", "radio", "switch", "menuitemcheckbox"].includes(role)) {
      const want = typeof value === "boolean" ? value : !/^(false|0|off|no|unchecked|)$/i.test(String(value).trim());
      const isChecked = () => (tag === "input" ? el.checked : el.getAttribute("aria-checked") === "true");
      if (isChecked() !== want) {
        if (type === "radio" && !want) throw new Error("A radio button cannot be unchecked directly; select another option instead");
        el.click();
      }
      if (isChecked() !== want && tag === "input") {
        el.checked = want;
        fire(el, "input");
        fire(el, "change");
      }
      return { ok: true, message: `${isChecked() ? "Checked" : "Unchecked"} ${describe(el)}` };
    }

    if (tag === "input" && type === "file") {
      throw new Error("Use the file_upload tool for file inputs");
    }

    if (tag === "input" || tag === "textarea") {
      const str = value == null ? "" : String(value);
      el.focus();
      // Writing through the sandbox's Xray view calls the *native* value setter,
      // bypassing framework overrides, so React/Vue see a real change.
      el.value = str;
      fire(el, "input");
      fire(el, "change");
      return { ok: true, message: `Set ${describe(el)} to ${type === "password" ? '"••••••"' : q(trunc(str, 120))}` };
    }

    if (el.isContentEditable) {
      const str = value == null ? "" : String(value);
      el.focus();
      const doc = el.ownerDocument;
      const sel = doc.defaultView.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      let ok = false;
      try {
        ok = doc.execCommand(str ? "insertText" : "delete", false, str);
      } catch {}
      if (!ok) {
        el.textContent = str;
        fire(el, "input");
      }
      return { ok: true, message: `Set ${describe(el)} to ${q(trunc(str, 120))}` };
    }

    if (role === "slider" || role === "spinbutton") {
      throw new Error("This custom control is not a native input; use computer actions (click/drag/keys) instead");
    }
    throw new Error(`Element ${describe(el)} is not a form field`);
  }

  function pageText(arg) {
    const maxChars = arg.maxChars || 100000;
    const doc = document;
    const pick = () => {
      const article = doc.querySelector("article");
      const main = doc.querySelector("main, [role=main]");
      const len = (e) => (e ? clean(e.innerText).length : 0);
      if (article && len(article) > 500) return article;
      if (main && len(main) > 200) return main;
      return doc.body || doc.documentElement;
    };
    const el = pick();
    let text = "";
    try {
      text = el.innerText || "";
    } catch {}
    if (!text) text = el.textContent || "";
    text = text
      .replace(/[ \t ]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t ]{2,}/g, " ")
      .trim();
    const truncated = text.length > maxChars;
    return {
      title: doc.title,
      url: location.href,
      source: el === doc.body ? "body" : el.localName,
      text: truncated ? text.slice(0, maxChars) : text,
      truncated,
      length: text.length,
    };
  }

  function viewport() {
    const de = document.documentElement;
    return {
      w: innerWidth,
      h: innerHeight,
      dpr: devicePixelRatio || 1,
      sx: scrollX,
      sy: scrollY,
      sw: de ? de.scrollWidth : 0,
      sh: de ? de.scrollHeight : 0,
      vis: document.visibilityState,
      url: location.href,
      title: document.title,
      ready: document.readyState,
    };
  }

  function describeAt(arg) {
    const el = document.elementFromPoint(arg.x, arg.y);
    return { target: describe(el), iframe: !!el && (el.localName === "iframe" || el.localName === "frame") };
  }

  function scrollBy(arg) {
    window.scrollBy({ left: arg.dx || 0, top: arg.dy || 0, behavior: "instant" });
    return viewport();
  }

  function elementOf(arg) {
    return get(arg.id, arg.token);
  }

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; i < 20 && el; i++) {
      const sr = shadowOf(el);
      if (!sr || !sr.elementFromPoint) break;
      const inner = sr.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function contentOffset(el) {
    const win = el.ownerDocument.defaultView;
    const r = el.getBoundingClientRect();
    const cs = win.getComputedStyle(el);
    return {
      x: r.left + el.clientLeft + (parseFloat(cs.paddingLeft) || 0),
      y: r.top + el.clientTop + (parseFloat(cs.paddingTop) || 0),
    };
  }

  // Which iframe (if any) is under this viewport point, and where its content box starts.
  function frameAt(arg) {
    const el = deepElementFromPoint(arg.x, arg.y);
    if (!el || (el.localName !== "iframe" && el.localName !== "frame")) return { id: null };
    const off = contentOffset(el);
    return { id: idFor(el), token, x: off.x, y: off.y };
  }

  // The iframe element that currently holds keyboard focus, if any.
  function activeFrame() {
    let a = document.activeElement;
    for (let i = 0; i < 20 && a; i++) {
      const sr = shadowOf(a);
      if (!sr || !sr.activeElement) break;
      a = sr.activeElement;
    }
    if (!a || (a.localName !== "iframe" && a.localName !== "frame")) return { id: null };
    return { id: idFor(a), token };
  }

  G.__cz = {
    v: 3,
    token,
    snapshot,
    find,
    point,
    scrollTo,
    frameOffset,
    formInput,
    pageText,
    viewport,
    describeAt,
    scrollBy,
    elementOf,
    frameAt,
    activeFrame,
  };
}
