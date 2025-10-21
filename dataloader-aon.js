// dataloader-aon.js
// Client-side AoN importer for GitHub Pages

// Public API
export async function importFromLink(url) {
  assertAoN(url);
  const html = await fetchWithFallback(url);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const scope = pickScope(doc);

  const name = extractName(scope, doc);
  const level = extractLevel(scope);
  const traits = extractTraits(scope);
  const ac = extractNumberAfter(scope, /\bAC\b/);
  const hp = extractNumberAfter(scope, /\bHP\b/);
  const speed = extractSpeed(scope);
  const attacks = extractAttacks(scope);

  // Basic sanity
  const out = {
    name: name || "Unknown",
    level: Number.isFinite(level) ? level : null,
    traits,
    ac: Number.isFinite(ac) ? ac : null,
    hp: Number.isFinite(hp) ? hp : null,
    speed: speed || null,
    attacks,
  };
  return out;
}

/* ========================= Helpers ========================= */

function assertAoN(url) {
  try {
    const u = new URL(url);
    if (!/aonprd\.com$/i.test(u.hostname)) {
      console.warn("Non-AoN host. Parser may fail.");
    }
  } catch {
    throw new Error("Invalid URL.");
  }
}

async function fetchWithFallback(url) {
  // 1) Try direct CORS fetch
  try {
    const r = await fetch(url, { mode: "cors", credentials: "omit" });
    if (r.ok) return await r.text();
  } catch (_) {}

  // 2) CORS-friendly proxy (stateless)
  // allorigins returns raw content via /raw
  const proxied = "https://api.allorigins.win/raw?url=" + encodeURIComponent(url);
  const r2 = await fetch(proxied, { mode: "cors", credentials: "omit" });
  if (!r2.ok) throw new Error("Fetch failed.");
  return await r2.text();
}

function pickScope(doc) {
  // AoN main content wrapper commonly uses this id
  const main = doc.querySelector("#ctl00_MainContent_DetailedOutput")
            || doc.querySelector("#main")
            || doc.body;
  return main;
}

function extractName(scope, doc) {
  // Prefer page <h1>; fallback: first strong heading-like element
  const h1 = doc.querySelector("h1, .title, .page-title");
  if (h1 && clean(h1.textContent)) return clean(h1.textContent);

  const top = scope.querySelector("h1, h2, h3, strong, b");
  if (top && clean(top.textContent)) return clean(top.textContent);

  // Last resort: look for “Creature X” line and take preceding text in same block
  const creatureLine = findTextNode(scope, /\bCreature\s+(-?\d+)\b/i);
  if (creatureLine) {
    const parent = creatureLine.parentElement;
    const t = parent?.textContent || "";
    const m = t.match(/^(.+?)\s+Creature\s+(-?\d+)/i);
    if (m) return clean(m[1]);
  }
  return null;
}

function extractLevel(scope) {
  // Typical AoN: "Creature X"
  const node = findTextNode(scope, /\bCreature\s+(-?\d+)\b/i);
  if (node) {
    const m = node.textContent.match(/\bCreature\s+(-?\d+)\b/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function extractTraits(scope) {
  // Traits often appear as a comma list near the top, sometimes links with .trait
  const tagLinks = Array.from(scope.querySelectorAll('a.trait, span.trait, .traits a, .traits span'))
    .map(x => clean(x.textContent))
    .filter(Boolean);
  if (tagLinks.length) return dedup(tagLinks);

  // Fallback: find a line starting with “Traits” or parenthesized after name
  const traitsLine = findTextNode(scope, /^\s*Traits\s*[:：]\s*(.+)$/im);
  if (traitsLine) {
    const m = traitsLine.textContent.match(/^\s*Traits\s*[:：]\s*(.+)$/im);
    if (m) return splitTraits(m[1]);
  }

  // Fallback 2: within first paragraph block parentheses
  const firstPara = scope.querySelector("p");
  if (firstPara) {
    const m = firstPara.textContent.match(/\(([^)]+)\)/);
    if (m) return splitTraits(m[1]);
  }
  return [];
}

function extractNumberAfter(scope, labelRe) {
  // e.g., AC 23, HP 120
  const node = findTextNode(scope, labelRe);
  if (!node) return null;
  const text = node.parentElement?.textContent || node.textContent || "";
  const m = text.match(new RegExp(labelRe.source + "\\s*(\\d+)", "i"));
  return m ? parseInt(m[1], 10) : null;
}

function extractSpeed(scope) {
  // Look for “Speed 25 feet” pattern
  const node = findTextNode(scope, /\bSpeed\b/i);
  if (!node) return null;
  const line = node.parentElement?.textContent || node.textContent || "";
  const m = line.match(/\bSpeed\b\s*([^.\n\r]+)/i);
  return m ? clean(m[1]) : null;
}

function extractAttacks(scope) {
  // Parse “Melee … +X (damage)”, “Ranged … +X (damage)”
  const blocks = textBlocks(scope).slice(0, 40); // early content
  const attacks = [];
  const re = /(Melee|Ranged)\s+([^\n\r;•—-]+?)\s+([+−-]\d+)(?:[^(\n\r]*)\(([^)]+)\)/ig;

  for (const blk of blocks) {
    let m;
    while ((m = re.exec(blk)) !== null) {
      attacks.push({
        name: clean(m[2]),
        attack: normalizePlus(m[3]),
        damage: clean(m[4])
      });
    }
  }

  // If none, try simpler “name +X” lines
  if (!attacks.length) {
    const simple = /(Melee|Ranged)\s+([^\n\r;•—-]+?)\s+([+−-]\d+)/ig;
    for (const blk of blocks) {
      let m;
      while ((m = simple.exec(blk)) !== null) {
        attacks.push({ name: clean(m[2]), attack: normalizePlus(m[3]), damage: null });
      }
    }
  }
  return coalesceAttacks(attacks);
}

/* ========================= Utilities ========================= */

function findTextNode(root, regex) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    if (regex.test(node.textContent)) return node;
  }
  return null;
}

function textBlocks(scope) {
  const sels = ["#ctl00_MainContent_DetailedOutput", ".stat-block", ".content", "article", "main", "body"];
  const container = sels.map(s => scope.closest(s) || scope.querySelector(s)).find(Boolean) || scope;
  // Split into manageable lines
  const raw = container.textContent || "";
  return raw.split(/\n{2,}/).map(t => cleanSpaces(t)).filter(Boolean);
}

function clean(txt) {
  return (txt || "").replace(/\s+/g, " ").trim();
}
function cleanSpaces(txt) {
  return (txt || "").replace(/[ \t]+/g, " ").replace(/\r/g, "").trim();
}
function splitTraits(s) {
  return s.split(/[,•;]+/).map(t => clean(t)).filter(Boolean);
}
function dedup(arr) {
  return Array.from(new Set(arr));
}
function normalizePlus(s) {
  // Normalize Unicode minus
  return (s || "").replace("−", "-");
}
function coalesceAttacks(list) {
  // Merge duplicates by name and highest attack bonus if needed
  const map = new Map();
  for (const a of list) {
    const key = a.name.toLowerCase();
    if (!map.has(key)) map.set(key, a);
    else {
      const prev = map.get(key);
      const aNum = parseInt((a.attack || "0").replace(/[+]/, ""), 10);
      const pNum = parseInt((prev.attack || "0").replace(/[+]/, ""), 10);
      map.set(key, aNum > pNum ? a : prev);
    }
  }
  return Array.from(map.values());
}
