/**
 * Shadow-DOM supplement to vendor/snapshot.js. OURS, not upstream.
 *
 * Mirrors the element logic of vendor/snapshot.js at pinned commit
 * 1231850a (selector set, role(), name(), visibility, editable/value
 * branches). If vendor/snapshot.js is re-vendored, sync this file's
 * ELEMENT LOGIC section with it.
 *
 * Shares the live window.__jevFast cache (ids WeakMap, nodes Map, next
 * counter, guard fn) so supplement nodes join the same identity space and
 * get freshness guards for free. Runs in each frame after snapshot.js.
 * Open shadow roots only — closed roots are unreadable from page JS.
 */
(() => {
  const cache = window.__jevFast;
  if (!cache) return [];
  const identity = (e) => {
    if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
    const id = cache.ids.get(e);
    cache.nodes.set(id, e);
    return id;
  };
  for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);

  /* ---- ELEMENT LOGIC (mirrors vendor/snapshot.js) ---- */
  const safe = (e) => !['password', 'file', 'hidden'].includes(e.type);
  const visible = (e) => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const root = e.getRootNode();
    const byId = (id) => {
      if (!id) return null;
      if (root instanceof ShadowRoot) return root.getElementById(id);
      return document.getElementById(id);
    };
    const referenced = (e.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => name(byId(id), seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName === 'INPUT' ? '' : [...e.childNodes].map((n) => n.nodeType === 3 ? n.textContent :
        n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
    'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map((role) => '[role="' + role + '"]').join(',');
  const role = (e) => {
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(e.type)) return e.type;
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  /* ---- end ELEMENT LOGIC ---- */

  const actions = [];
  // Per-run registrations only: the shared cache persists across observes,
  // so it must NEVER gate emission (that hides everything after run one).
  // Snapshot's entries are filtered adapter-side by node instead.
  const emitted = new Set();
  const hasControlWithin = (e, depth) => {
    if (depth <= 0) return false;
    for (const c of e.children) {
      if (c.tagName && ['INPUT', 'SELECT', 'TEXTAREA'].includes(c.tagName)) return true;
      if (hasControlWithin(c, depth - 1)) return true;
    }
    return false;
  };
  const visit = (root, inShadow) => {
    // File inputs (snapshot.js excludes them): upload targets.
    for (const e of root.querySelectorAll('input[type=file]')) {
      if (emitted.has(e)) continue;
      if (!visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
      const rr = e.getBoundingClientRect();
      if (rr.width <= 0 || rr.height <= 0) continue;
      emitted.add(e);
      actions.push({ node: identity(e), role: 'button',
        label: (name(e) || 'Choose file') + ' [upload]' + (inShadow ? ' [in shadow]' : ''), kind: 'upload', value: '',
        rect: { x: rr.x, y: rr.y, w: rr.width, h: rr.height } });
    }
    // Non-semantic clickables snapshot.js skips: [onclick] elements and
    // labels wrapping a control (Ant-style). emitted set dedupes within a run.
    for (const e of root.querySelectorAll('[onclick],label:not([for])')) {
      if (emitted.has(e)) continue;
      if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
      let label = null;
      if (e.tagName === 'LABEL' && hasControlWithin(e, 2)) {
        const inner = e.querySelector('input,select,textarea');
        label = (name(inner) || name(e) || 'option') + ' [in label]' + (inShadow ? ' [in shadow]' : '');
      } else if (e.hasAttribute('onclick')) {
        label = (name(e) || (e.textContent || '').trim().slice(0, 80) || 'clickable') + (inShadow ? ' [in shadow]' : '');
      } else continue;
      const rr = e.getBoundingClientRect(), cx = rr.x + rr.width / 2, cy = rr.y + rr.height / 2;
      if (rr.width <= 0 || rr.height <= 0 || cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) continue;
      emitted.add(e);
      actions.push({ node: identity(e), role: 'button', label, kind: 'click', value: '',
        rect: { x: rr.x, y: rr.y, w: rr.width, h: rr.height } });
    }
    // Pointer-cursor controls with no semantics at all (YouTube's ...more,
    // expander containers, chips, custom-element buttons). Leaf-ish elements
    // qualify directly; larger containers qualify when short-texted and
    // bounded (a pointer cursor IS the site's clickability signal — clicking
    // a card navigates to the card, which is faithful, not misleading).
    for (const e of root.querySelectorAll('div,span,button,a')) {
      if (emitted.has(e)) continue;
      let t = '';
      try {
        t = (e.textContent || '').trim().replace(/\s+/g, ' ');
        if (t.length < 1 || t.length > 300) continue;
        const kids = [...e.children].filter((c) => ((c.textContent || '').trim().length > 0));
        if (kids.length > 1 && t.length > 80) continue;
        if (getComputedStyle(e).cursor !== 'pointer') continue;
      } catch (err) { continue; }
      if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
      const rr = e.getBoundingClientRect(), cx = rr.x + rr.width / 2, cy = rr.y + rr.height / 2;
      if (rr.width <= 0 || rr.height <= 0 || rr.width * rr.height > 400000) continue;
      if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) continue;
      emitted.add(e);
      actions.push({ node: identity(e), role: 'button',
        label: t.slice(0, 80) + (inShadow ? ' [in shadow]' : ''), kind: 'click', value: '',
        rect: { x: rr.x, y: rr.y, w: rr.width, h: rr.height } });
    }
    for (const e of root.querySelectorAll(selector)) {
      if (e.shadowRoot) visit(e.shadowRoot, true);
      if (emitted.has(e)) continue;
      if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
      const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, rname = role(e);
      if (!rname || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
      const base = {
        node: identity(e), role: rname, label: (name(e) || rname) + (inShadow ? ' [in shadow]' : ''),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      };
      for (const key of ['checked', 'selected', 'expanded']) {
        const value = e.getAttribute('aria-' + key);
        if (value !== null) base[key] = value;
      }
      if (['checkbox', 'radio'].includes(e.type)) base.checked = String(e.checked);
      if (e.tagName === 'SELECT') {
        for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
          emitted.add(e);
          actions.push({ ...base, kind: 'select', value: o.value,
            current_value: [...e.selectedOptions].map((o) => o.label).join(', '), label: base.label + ' → ' + o.label });
      } else {
        const editable = !e.readOnly && e.getAttribute('aria-readonly') !== 'true' &&
          (['textbox', 'searchbox', 'spinbutton'].includes(rname) ||
            (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
        const value = 'value' in e ? String(e.value) :
          e.isContentEditable || rname === 'combobox' ? e.innerText.trim() : '';
        emitted.add(e);
        actions.push({ ...base, kind: editable ? 'fill' : 'click', value });
        if (editable) actions.push({ ...base, kind: 'click', value, label: 'Open ' + base.label });
      }
    }
    // Nested hosts one level deeper are visited via their own query above
    // when their host matches; recurse explicitly for non-matching hosts.
    for (const e of root.querySelectorAll('*')) {
      if (e.shadowRoot && !e.matches(selector)) visit(e.shadowRoot, true);
    }
  };
  visit(document, false);
  return actions;
})()
