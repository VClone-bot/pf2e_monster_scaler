// dataloader-aon.js
// Robust AoN importer for static sites (GitHub Pages)

export async function importFromLink(url) {
  const { kind, body } = await fetchAoN(url);
  const out = (kind === "html") ? parseHtml(body) : parseText(body);

  // Minimal sanity: must have a name or level or HP
  if (!out || (!out.name && !isFinite(out.level) && !isFinite(out.hp))) {
    throw new Error("Parse failed");
  }
  return normalize(out);
}

/* ================ Fetch with CORS fallbacks ================ */

async function fetchAoN(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error("Invalid URL"); }

  // 1) Try direct (will usually fail due to CORS)
  try {
    const r = await fetch(u.toString(), { mode: "cors", credentials: "omit" });
    if (r.ok) {
      const ct = r.headers.get("content-type") || "";
      const text = await r.text();
      if (ct.includes("text/html")) return { kind: "html", body: text };
      return { kind: "text", body: text };
    }
  } catch {}

  // 2) CORS-proof text mirror: r.jina.ai (renders HTML to readable text)
  // Important: use http:// for the mirrored target
  const target = "http://" + u.host + u.pathname + (u.search || "");
  const r2 = await fetch("https://r.jina.ai/http/" + encodeURIComponent(target), {
    mode: "cors",
    credentials: "omit"
  });
  if (!r2.ok) throw new Error("Fetch failed via mirror");
  const text2 = await r2.text();
  return { kind: "text", body: text2 };
}

/* ======================= HTML parsing ====================== */

function parseHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const scope = doc.querySelector("#ctl00_MainContent_DetailedOutput") || doc.body;

  const name = pickNameHtml(doc, scope);
  const level = pickNumber(scope, /\bCreature\s+(-?\d+)\b/i);
  const traits = pickTraitsHtml(scope);
  const ac = pickLabeledNumber(scope, /\bAC\b/i);
  const hp = pickLabeledNumber(scope, /\bHP\b/i);
  const speed = pickLabeledLine(scope, /\bSpeed\b/i);
  const attacks = pickAttacks(scope);

  return { name, level, traits, ac, hp, speed, attacks };
}

function pickNameHtml(doc, scope) {
  const h1 = doc.querySelector("h1");
  if (h1?.textContent) {
    const t = clean(h1.textContent);
    // AoN often shows “Name (Creature X)”
    const m = t.match(/^(.+?)\s*\(Creature\s+(-?\d+)\)$/i);
    return m ? m[1] : t;
  }
  const head = scope.querySelector("h1, h2, .title, .page-title, strong, b");
  return head ? clean(head.textContent) : null;
}
function pickNumber(scope, re) {
  const node = findTextNode(scope, re);
  if (!node) return null;
  const m = node.textContent.match(re);
  return m ? parseInt(m[1], 10) : null;
}
function pickTraitsHtml(scope) {
  const links = Array.from(scope.querySelectorAll("a.trait, span.trait, .traits a, .traits span"))
    .map(x => clean(x.textContent)).filter(Boolean);
  if (links.length) return dedup(links);

  const node = findTextNode(scope, /^\s*Traits\s*[:：]/im);
  if (node) {
    const line = node.parentElement?.textContent || node.textContent || "";
    const m = line.match(/Traits\s*[:：]\s*(.+)$/i);
    if (m) return splitTraits(m[1]);
  }
  return [];
}
function pickLabeledNumber(scope, labelRe) {
  const node = findTextNode(scope, labelRe);
  if (!node) return null;
  const line = node.parentElement?.textContent || node.textContent || "";
  const m = line.match(new RegExp(labelRe.source + "\\s*(\\d+)", "i"));
  return m ? parseInt(m[1], 10) : null;
}
function pickLabeledLine(scope, labelRe) {
  const node = findTextNode(scope, labelRe);
  if (!node) return null;
  const line = node.parentElement?.textContent || node.textContent || "";
  const m = line.match(new RegExp(labelRe.source + "\\s*([^\\n\\.]+)"));
  return m ? clean(m[1]) : null;
}
function pickAttacks(scope) {
  const text = (scope.textContent || "");
  return extractAttacksFromText(text);
}

/* ======================= TEXT parsing ====================== */

function parseText(text) {
  // Header like: "Barghest (Creature 4)"
  let name = null, level = null;

  // First line with “Creature”
  const creatureLine = (text.match(/^.*Creature\s+-?\d+.*$/gmi) || [null])[0];
  if (creatureLine) {
    const m = creatureLine.match(/^(.+?)\s*\(.*?Creature\s+(-?\d+)\)/i) ||
              creatureLine.match(/^(.+?)\s+Creature\s+(-?\d+)/i);
    if (m) { name = clean(m[1]); level = parseInt(m[2], 10); }
  }

  // Traits
  let traits = [];
  const traitsLine = (text.match(/^\s*Traits\s*[:：]\s*(.+)$/gmi) || [null])[0];
  if (traitsLine) {
    const m = traitsLine.match(/Traits\s*[:：]\s*(.+)$/i);
    if (m) traits = splitTraits(m[1]);
  }

  // AC, HP, Speed
  const ac = firstInt(/(^|[^\w])AC\s+(\d+)/i, text);
  const hp = firstInt(/(^|[^\w])HP\s+(\d+)/i, text);
  const speedMatch = text.match(/(^|\n)\s*Speed\s*([^\n]+)/i);
  const speed = speedMatch ? clean(speedMatch[2]) : null;

  // Attacks
  const attacks = extractAttacksFromText(text);

  return { name, level, traits, ac, hp, speed, attacks };
}

/* ========================= Shared utils ==================== */

function extractAttacksFromText(t) {
  const attacks = [];
  const re = /(Melee|Ranged)\s+([^\n\r;•—-]+?)\s+([+−-]\d{1,2})(?:[^(\n\r]*)\(([^)]+)\)/ig;
  let m;
  while ((m = re.exec(t)) !== null) {
    attacks.push({ name: clean(m[2]), attack: normalizePlus(m[3]), damage: clean(m[4]) });
  }
  if (!attacks.length) {
    const simple = /(Melee|Ranged)\s+([^\n\r;•—-]+?)\s+([+−-]\d{1,2})/ig;
    let m2;
    while ((m2 = simple.exec(t)) !== null) {
      attacks.push({ name: clean(m2[2]), attack: normalizePlus(m2[3]), damage: null });
    }
  }
  return coalesceAttacks(attacks);
}

function firstInt(re, text) {
  const m = text.match(re);
  return m ? parseInt(m[2], 10) : null;
}

function findTextNode(root, regex) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n; while ((n = w.nextNode())) { if (regex.test(n.textContent)) return n; }
  return null;
}
function clean(s) { return (s || "").replace(/\s+/g, " ").trim(); }
function splitTraits(s) { return s.split(/[,•;]+/).map(x => clean(x)).filter(Boolean); }
function dedup(a) { return Array.from(new Set(a)); }
function normalizePlus(s) { return (s || "").replace("−", "-"); }
function coalesceAttacks(list) {
  const by = new Map();
  for (const a of list) {
    const k = (a.name || "").toLowerCase();
    if (!by.has(k)) by.set(k, a);
    else {
      const prev = by.get(k);
      const an = parseInt((a.attack || "0").replace("+",""),10);
      const pn = parseInt((prev.attack || "0").replace("+",""),10);
      if (an > pn) by.set(k, a);
    }
  }
  return Array.from(by.values());
}
function normalize(obj) {
  return {
    name: obj.name || "Unknown",
    level: Number.isFinite(obj.level) ? obj.level : null,
    traits: Array.isArray(obj.traits) ? obj.traits : [],
    ac: Number.isFinite(obj.ac) ? obj.ac : null,
    hp: Number.isFinite(obj.hp) ? obj.hp : null,
    speed: obj.speed || null,
    attacks: Array.isArray(obj.attacks) ? obj.attacks : []
  };
}
