// Werkt een stuk DOM bij naar nieuwe HTML zonder alles te vervangen.
// Ongewijzigde knopen blijven staan, zodat scrollpositie, focus, lopende
// animaties en veeggebaren heel blijven en de browser alleen opnieuw
// opmaakt wat echt veranderde.
//
// Kinderen worden gekoppeld op een sleutel (id, data-task-id, data-id, ...)
// en anders op volgorde. Een element met data-busy (bijv. een taak die net
// wordt afgevinkt) of de klasse "swiping"/"dragging" blijft onaangeroerd.

const KEY_ATTRS = ["data-task-id", "id", "data-section-id", "data-day", "data-id", "data-note-items"];

function keyOf(n) {
  if (n.nodeType !== 1) return null;
  for (const a of KEY_ATTRS) {
    const v = n.getAttribute(a);
    if (v != null && v !== "") return n.nodeName + "|" + a + "|" + v;
  }
  return null;
}

function busy(el) {
  return el.hasAttribute("data-busy") || el.classList.contains("swiping") || el.classList.contains("dragging");
}

function syncAttrs(el, from) {
  const want = from.attributes;
  for (let i = el.attributes.length - 1; i >= 0; i--) {
    const name = el.attributes[i].name;
    if (!from.hasAttribute(name)) el.removeAttribute(name);
  }
  for (let i = 0; i < want.length; i++) {
    const { name, value } = want[i];
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
}

function patchNode(old, nw) {
  if (old.nodeType !== 1) {
    if (old.nodeValue !== nw.nodeValue) old.nodeValue = nw.nodeValue;
    return;
  }
  if (busy(old) || old.isEqualNode(nw)) return;
  syncAttrs(old, nw);
  patchChildren(old, nw);
}

function sameKind(a, b) {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName;
}

function patchChildren(parent, from) {
  const oldKids = [...parent.childNodes];
  const keyed = new Map();
  const loose = [];
  for (const n of oldKids) {
    const k = keyOf(n);
    if (k && !keyed.has(k)) keyed.set(k, n); else loose.push(n);
  }
  const used = new Set();
  let li = 0;
  let ref = parent.firstChild;
  for (const nw of [...from.childNodes]) {
    const k = keyOf(nw);
    let match = null;
    if (k) {
      const c = keyed.get(k);
      if (c && sameKind(c, nw) && !used.has(c)) match = c;
    } else {
      while (li < loose.length && used.has(loose[li])) li++;
      if (li < loose.length && sameKind(loose[li], nw)) match = loose[li++];
    }
    if (match) {
      used.add(match);
      patchNode(match, nw);
      if (match !== ref) parent.insertBefore(match, ref);
      ref = match.nextSibling;
    } else {
      parent.insertBefore(nw, ref);
    }
  }
  for (const n of oldKids) if (!used.has(n) && n.parentNode === parent) parent.removeChild(n);
}

// ---------- Bovenste laag in stukken ----------
// HTML parsen kost het meeste tijd. Daarom knippen we de HTML eerst in de
// blokken op het bovenste niveau (secties, kaarten). Blokken die precies
// gelijk zijn aan de vorige keer laten we staan zonder te parsen; alleen
// gewijzigde blokken worden geparsed en bijgewerkt. Werkt omdat views alle
// tekst escapen: een "<" begint altijd een tag.
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const TAG = /<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g;

function splitTop(html) {
  const out = [];
  let depth = 0, start = 0, last = 0, m;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(html))) {
    const [, close, name, selfClose] = m;
    if (depth === 0 && m.index > last) out.push(html.slice(last, m.index)); // tekst tussen blokken
    if (depth === 0) start = m.index;
    if (close) depth--;
    else if (!selfClose && !VOID.has(name.toLowerCase())) depth++;
    if (depth < 0) return null;
    if (depth === 0) { out.push(html.slice(start, TAG.lastIndex)); last = TAG.lastIndex; }
  }
  if (depth !== 0) return null;
  if (last < html.length) out.push(html.slice(last));
  return out;
}

const memo = new WeakMap(); // root -> [{ html, node }]

export function morph(root, html) {
  const chunks = splitTop(html);
  const prev = memo.get(root);
  if (!chunks || !prev || prev.some((p) => p.node.parentNode !== root)) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    patchChildren(root, tpl.content);
    remember(root, chunks);
    return;
  }
  // Ongewijzigde blokken op hun HTML terugvinden.
  const free = new Map();
  for (const p of prev) {
    if (!free.has(p.html)) free.set(p.html, []);
    free.get(p.html).push(p.node);
  }
  const plan = chunks.map((h) => {
    const l = free.get(h);
    return l && l.length ? { html: h, node: l.shift() } : { html: h, node: null };
  });
  const keep = new Set(plan.filter((x) => x.node).map((x) => x.node));
  // Gewijzigde blokken: alleen die parsen, en zo mogelijk een bestaand
  // element met dezelfde sleutel bijwerken.
  const spare = [...root.childNodes].filter((n) => !keep.has(n));
  const spareByKey = new Map();
  for (const n of spare) { const k = keyOf(n); if (k && !spareByKey.has(k)) spareByKey.set(k, n); }
  let si = 0;
  for (const x of plan) {
    if (x.node) continue;
    const tpl = document.createElement("template");
    tpl.innerHTML = x.html;
    const nw = tpl.content.firstChild;
    if (!nw || tpl.content.childNodes.length !== 1) { x.node = tpl.content; x.frag = true; continue; }
    const k = keyOf(nw);
    let old = k ? spareByKey.get(k) : null;
    if (!old) {
      while (si < spare.length && (keep.has(spare[si]) || keyOf(spare[si]))) si++;
      if (si < spare.length && sameKind(spare[si], nw)) old = spare[si++];
    }
    if (old && sameKind(old, nw) && !keep.has(old)) {
      keep.add(old);
      if (k) spareByKey.delete(k);
      patchNode(old, nw);
      x.node = old;
    } else {
      x.node = nw;
    }
  }
  // Op volgorde zetten en de rest weghalen.
  let ref = root.firstChild;
  const placed = new Set();
  for (const x of plan) {
    if (x.frag) { const nodes = [...x.node.childNodes]; root.insertBefore(x.node, ref); nodes.forEach((n) => placed.add(n)); continue; }
    placed.add(x.node);
    if (x.node !== ref) root.insertBefore(x.node, ref);
    ref = x.node.nextSibling;
  }
  for (const n of [...root.childNodes]) if (!placed.has(n)) root.removeChild(n);
  remember(root, chunks);
}

function remember(root, chunks) {
  const nodes = [...root.childNodes];
  if (!chunks || chunks.length !== nodes.length) { memo.delete(root); return; }
  memo.set(root, chunks.map((html, i) => ({ html, node: nodes[i] })));
}

// Na een volledige innerHTML: onthouden welke blokken er nu staan.
export function rememberHtml(root, html) { remember(root, splitTop(html)); }
