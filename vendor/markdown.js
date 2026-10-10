/**
 * Page-side HTML → Markdown for readable extraction. OURS, not upstream.
 * Approach ported from browser-use's markdown_extractor (markdownify +
 * JSON-blob stripping + whitespace compression), reimplemented dependency-
 * free for in-page evaluation. Fixed script: model output never reaches it.
 */
(() => {
  const SKIP_SEL = 'script,style,noscript,template,select,option,svg,canvas,video,audio,iframe,' +
    'header,footer,nav,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"]';
  const hidden = (e) =>
    e.closest('[aria-hidden="true"],[inert]') !== null ||
    (typeof e.getClientRects === 'function' && e.getClientRects().length === 0 &&
      !['BR', 'HR', 'IMG', 'INPUT', 'TEXTAREA'].includes(e.tagName));
  const absUrl = (href) => {
    try {
      const u = new URL(href, location.href);
      if (!['http:', 'https:'].includes(u.protocol)) return null;
      return u.href;
    } catch {
      return null;
    }
  };
  const inline = (node) => {
    let s = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        s += child.textContent;
      } else if (child.nodeType === 1) {
        const e = child;
        if (e.closest(SKIP_SEL)) continue;
        const tag = e.tagName;
        if (tag === 'A') {
          const t = inline(e).replace(/\s+/g, ' ').trim();
          const href = e.getAttribute('href');
          const url = href ? absUrl(href) : null;
          s += t ? (url ? `[${t}](${url})` : t) : '';
        } else if (tag === 'STRONG' || tag === 'B') {
          s += `**${inline(e).replace(/\s+/g, ' ').trim()}**`;
        } else if (tag === 'EM' || tag === 'I') {
          s += `*${inline(e).replace(/\s+/g, ' ').trim()}*`;
        } else if (tag === 'CODE') {
          s += `\`${e.textContent.replace(/\s+/g, ' ').trim()}\``;
        } else if (tag === 'BR') {
          s += '\n';
        } else if (tag === 'IMG') {
          const alt = e.getAttribute('alt');
          if (alt) s += alt;
        } else if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') {
          const t = (e.innerText || e.value || e.getAttribute('value') || e.getAttribute('placeholder') || '').trim();
          if (t) s += `[${t}]`;
        } else {
          s += inline(e);
        }
      }
    }
    return s;
  };
  const lines = [];
  const pushBlock = (s) => {
    const t = String(s).replace(/[ \t]+\n/g, '\n').trim();
    if (t) lines.push(t);
  };
  const walk = (node, depth) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const t = child.textContent.replace(/\s+/g, ' ').trim();
        if (t) lines.push(t);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const e = child;
      if (e.closest(SKIP_SEL)) continue;
      if (hidden(e)) continue;
      const tag = e.tagName;
      if (/^H[1-6]$/.test(tag)) {
        pushBlock(`${'#'.repeat(Number(tag[1]))} ${inline(e).replace(/\s+/g, ' ').trim()}`);
      } else if (tag === 'LI') {
        const nested = [...e.childNodes].some(
          (n) => n.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL'));
        const own = inline({ childNodes: [...e.childNodes].filter(
          (n) => !(n.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL'))) });
        pushBlock(`${'  '.repeat(depth)}- ${own.replace(/\s+/g, ' ').trim()}`);
        if (nested) walk(e, depth + 1);
      } else if (tag === 'UL' || tag === 'OL') {
        walk(e, depth);
      } else if (tag === 'PRE') {
        lines.push('```', e.textContent.replace(/^\n+|\s+$/g, ''), '```');
      } else if (tag === 'BLOCKQUOTE') {
        for (const l of inline(e).split('\n')) {
          const t = l.replace(/\s+/g, ' ').trim();
          if (t) lines.push(`> ${t}`);
        }
      } else if (tag === 'TABLE') {
        for (const tr of e.querySelectorAll('tr')) {
          const cells = [...tr.querySelectorAll('th,td')].map(
            (c) => inline(c).replace(/\s+/g, ' ').trim());
          if (cells.length) lines.push(`| ${cells.join(' | ')} |`);
        }
      } else if (tag === 'TR' || tag === 'TH' || tag === 'TD' || tag === 'TBODY' || tag === 'THEAD') {
        walk(e, depth);
      } else if (tag === 'HR') {
        lines.push('---');
      } else if (tag === 'BR') {
        lines.push('');
      } else if (tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' ||
        tag === 'HEADER' || tag === 'FOOTER' || tag === 'MAIN' || tag === 'NAV' ||
        tag === 'FIGURE' || tag === 'FIGCAPTION' || tag === 'DETAILS' || tag === 'ASIDE') {
        const t = inline(e);
        const parts = t.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
        for (const p of parts) lines.push(p);
        if (parts.length) lines.push('');
      } else {
        walk(e, depth);
      }
    }
  };
  walk(document.body || document.documentElement, 0);
  return lines.join('\n');
})()
