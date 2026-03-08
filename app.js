/* ═══════════════════════════════════════════════════════
   app.js — Memory Graph Explorer
   Reads: data/graph.json  (built by graph.py)
   ═══════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────
const S = {
  graph: null,          // raw graph.json
  nodeMap: new Map(),   // id → node
  edgeMap: new Map(),   // id → edge
  evidenceMap: new Map(),// source_id → evidence item
  sim: null,
  frozen: false,
  zoom: null,
  currentTab: "graph",
  selectedId: null,
  selectedKind: null,   // "node"|"edge"|"evidence"|"merge"
  filterRelation: "all",
  showLabels: true,
  showOrphans: false,
  entityTypeFilter: "all",
  searchQuery: "",
  undoSet: new Set(),   // indices of merges that have been undone
};

// ── DOM refs ───────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Boot ───────────────────────────────────────────────────
async function boot() {
  const params = new URLSearchParams(location.search);
  const url = params.get("data") || "./data/graph.json";
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S.graph = await res.json();
  } catch(e) {
    // Try to load resolved_memories.json as fallback and transform it
    try {
      const r2 = await fetch("./data/resolved_memories.json");
      const raw = await r2.json();
      S.graph = transformResolvedMemories(raw);
    } catch(e2) {
      $("loading-overlay").innerHTML = `<p style="color:var(--accent2)">Could not load graph.json or resolved_memories.json.<br/>Run graph.py first.</p>`;
      return;
    }
  }

  indexData();
  populateStats();
  buildRelationFilter();
  buildEntityTypeChips();
  renderEntityList();
  renderEvidenceList();
  renderMergeList();
  initGraph();
  wireUI();
    // On boot, sync undo state with the persistent blocklist
  try {
    const blRes = await fetch("/api/blocklist");
    const blocklist = await blRes.json();
    const blocked = new Set(blocklist.map(e => `${e.alias}||${e.canonical}`));
    S.graph.merges.forEach((m, i) => {
    if (blocked.has(`${m.alias}||${m.canonical}`)) S.undoSet.add(i);
    });
    const count = S.undoSet.size;
    $("undo-count").textContent = count;
    $("undo-notice").classList.toggle("hidden", count === 0);
  } catch(e) { /* server not running or no blocklist yet */ }
  $("loading-overlay").classList.add("hidden");
}

// ── Fallback transformer ───────────────────────────────────
function transformResolvedMemories(claims) {
  const nodeSet = new Set();
  const edges = [];
  claims.forEach((c, i) => {
    nodeSet.add(c.source);
    nodeSet.add(c.target);
    const evidence = (c.proof_timeline || []).map(p => ({
      source_id: p.source_id || "",
      exact_quote: p.exact_quote || "",
      timestamp: p.timestamp || "",
      context_location: p.context_location || ""
    }));
    edges.push({
      id: `e${i}`, source: c.source, target: c.target,
      action: c.action || "related_to",
      first_seen: c.first_seen || "",
      proof_count: c.total_independent_proofs || evidence.length,
      evidence
    });
  });
  const nodes = Array.from(nodeSet).map(id => ({ id, label: id, type: "Entity", degree: 0, aliases: [] }));
  // calc degree
  edges.forEach(e => {
    const s = nodes.find(n=>n.id===e.source), t = nodes.find(n=>n.id===e.target);
    if(s) s.degree++; if(t) t.degree++;
  });
  // build evidence index
  const evIdx = {};
  edges.forEach(e => {
    e.evidence.forEach(ev => {
      if(!ev.source_id) return;
      if(!evIdx[ev.source_id]) evIdx[ev.source_id] = {source_id: ev.source_id, edge_ids: [], quotes: [], timestamp: ev.timestamp};
      if(!evIdx[ev.source_id].edge_ids.includes(e.id)) evIdx[ev.source_id].edge_ids.push(e.id);
      if(!evIdx[ev.source_id].quotes.find(q=>q.quote===ev.exact_quote))
        evIdx[ev.source_id].quotes.push({quote: ev.exact_quote, location: ev.context_location, timestamp: ev.timestamp});
    });
  });
  return {
    meta: { node_count: nodes.length, edge_count: edges.length, evidence_count: Object.keys(evIdx).length, merge_count: 0, built_at: new Date().toISOString() },
    nodes, edges,
    evidence: Object.values(evIdx),
    merges: []
  };
}

// ── Index data ─────────────────────────────────────────────
function indexData() {
  S.graph.nodes.forEach(n => S.nodeMap.set(n.id, n));
  S.graph.edges.forEach(e => S.edgeMap.set(e.id, e));
  S.graph.evidence.forEach(ev => S.evidenceMap.set(ev.source_id, ev));
}

// ── Stats ──────────────────────────────────────────────────
function populateStats() {
  const m = S.graph.meta;
  $("s-nodes").textContent    = m.node_count;
  $("s-edges").textContent    = m.edge_count;
  $("s-evidence").textContent = m.evidence_count;
  $("s-merges").textContent   = m.merge_count;
}

// ── Relation filter ────────────────────────────────────────
function buildRelationFilter() {
  const relations = [...new Set(S.graph.edges.map(e => e.action))].sort();
  const sel = $("filter-relation");
  relations.forEach(r => {
    const opt = document.createElement("option");
    opt.value = r; opt.textContent = r;
    sel.appendChild(opt);
  });
}

// ── Entity type chips ──────────────────────────────────────
function buildEntityTypeChips() {
  const types = [...new Set(S.graph.nodes.map(n => n.type || "Entity"))].sort();
  const wrap = $("entity-type-chips");
  wrap.innerHTML = "";
  ["all", ...types].forEach(t => {
    const chip = document.createElement("div");
    chip.className = "chip" + (t === "all" ? " active" : "");
    chip.textContent = t === "all" ? "All" : t;
    chip.dataset.type = t;
    chip.addEventListener("click", () => {
      S.entityTypeFilter = t;
      wrap.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c.dataset.type === t));
      renderEntityList();
    });
    wrap.appendChild(chip);
  });
}

// ── Entity list ────────────────────────────────────────────
function renderEntityList(query = "") {
  const q = ($("entity-search").value || query).toLowerCase().trim();
  let nodes = S.graph.nodes.filter(n => {
    if (S.entityTypeFilter !== "all" && n.type !== S.entityTypeFilter) return false;
    if (!q) return true;
    return n.label.toLowerCase().includes(q) || (n.aliases||[]).some(a=>a.toLowerCase().includes(q));
  });
  nodes = nodes.sort((a,b) => b.degree - a.degree);

  const list = $("entity-list");
  list.innerHTML = "";
  if (!nodes.length) { list.innerHTML = `<div style="color:var(--ink3);font-size:12px;padding:8px">No entities found</div>`; return; }
  nodes.slice(0, 300).forEach(n => {
    const row = document.createElement("div");
    row.className = "list-row" + (S.selectedId === n.id ? " active" : "");
    row.innerHTML = `<div class="lr-label">${highlight(n.label, q)}</div>
      <div class="lr-sub">${n.type || "Entity"} · degree ${n.degree}${n.aliases.length ? ` · aliases: ${n.aliases.slice(0,2).join(", ")}` : ""}</div>`;
    row.addEventListener("click", () => { selectNode(n.id); focusNodeOnGraph(n.id); });
    list.appendChild(row);
  });
}

// ── Evidence list ──────────────────────────────────────────
function renderEvidenceList(query = "") {
  const q = ($("evidence-search").value || query).toLowerCase().trim();
  let items = S.graph.evidence;
  if (q) items = items.filter(ev =>
    ev.source_id.toLowerCase().includes(q) ||
    (ev.quotes||[]).some(qt => qt.quote.toLowerCase().includes(q))
  );
  items = items.sort((a,b) => (b.edge_ids||[]).length - (a.edge_ids||[]).length);

  const list = $("evidence-list");
  list.innerHTML = "";
  if (!items.length) { list.innerHTML = `<div style="color:var(--ink3);font-size:12px;padding:8px">No evidence found</div>`; return; }
  items.slice(0, 300).forEach(ev => {
    const row = document.createElement("div");
    row.className = "list-row" + (S.selectedId === ev.source_id ? " active" : "");
    const preview = ev.quotes && ev.quotes[0] ? truncate(ev.quotes[0].quote, 80) : "No quote";
    row.innerHTML = `<div class="lr-label">${highlight(escHtml(ev.source_id), q)}</div>
      <div class="lr-sub">${highlight(escHtml(preview), q)}</div>`;
    row.addEventListener("click", () => selectEvidence(ev.source_id));
    list.appendChild(row);
  });
}

// ── Merges list ────────────────────────────────────────────
function renderMergeList() {
  const list = $("merges-list");
  list.innerHTML = "";
  const merges = S.graph.merges || [];
  if (!merges.length) {
    list.innerHTML = `<div style="color:var(--ink3);font-size:12px;padding:8px">No merges recorded</div>`;
    return;
  }
  merges.forEach((m, i) => {
    const undone = S.undoSet.has(i);
    const row = document.createElement("div");
    row.className = "list-row" + (undone ? " merge-undone" : "");
    row.style.cssText = undone ? "opacity:0.45;border-color:var(--accent2)" : "";
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="flex:1;min-width:0">
          <div class="lr-label" style="${undone?"text-decoration:line-through;color:var(--ink3)":""}">${escHtml(m.alias)} → ${escHtml(m.canonical)}</div>
          <div class="lr-sub">${escHtml(m.type)} · ${escHtml(m.reason)}</div>
        </div>
        <button class="undo-btn" data-idx="${i}" style="flex-shrink:0">${undone ? "↩ Restore" : "✕ Undo"}</button>
      </div>`;
    row.querySelector(".undo-btn").addEventListener("click", e => { e.stopPropagation(); toggleUndoMerge(i); });
    row.addEventListener("click", () => selectMerge(i));
    list.appendChild(row);
  });
}

function toggleUndoMerge(idx) {
  if (S.undoSet.has(idx)) {
    S.undoSet.delete(idx);
  } else {
    S.undoSet.add(idx);
  }
  const count = S.undoSet.size;
  $("undo-count").textContent = count;
  $("undo-notice").classList.toggle("hidden", count === 0);
  renderMergeList();
  // Re-render drawer if this merge is currently shown
  if (S.selectedKind === "merge" && S.selectedId === idx) {
    openDrawer("merge", `${S.graph.merges[idx].alias} → ${S.graph.merges[idx].canonical}`, renderMergeDrawer(S.graph.merges[idx], idx));
  }
}

// ── D3 Graph ───────────────────────────────────────────────
function initGraph() {
  const svg = d3.select("#graph-svg");
  const g = d3.select("#zoom-group");

  // Zoom behaviour
  S.zoom = d3.zoom()
    .scaleExtent([0.05, 5])
    .on("zoom", ev => g.attr("transform", ev.transform));
  svg.call(S.zoom);

  // Filter edges by relation
  const visibleEdges = () => S.graph.edges.filter(e =>
    S.filterRelation === "all" || e.action === S.filterRelation
  );

  const visibleNodes = () => {
    const connectedIds = new Set();
    visibleEdges().forEach(e => { connectedIds.add(e.source); connectedIds.add(e.target); });
    return S.graph.nodes.filter(n => S.showOrphans || connectedIds.has(n.id));
  };

  function buildSim(nodes, edges) {
    // Clone to avoid d3 mutating original objects
    const ns = nodes.map(n => ({ ...n }));
    const es = edges.map(e => ({ ...e, source: e.source, target: e.target }));

    if (S.sim) S.sim.stop();

    S.sim = d3.forceSimulation(ns)
      .force("link", d3.forceLink(es).id(d => d.id).distance(120).strength(0.4))
      .force("charge", d3.forceManyBody().strength(-280))
      .force("center", d3.forceCenter(
        $("graph-svg").clientWidth / 2,
        $("graph-svg").clientHeight / 2
      ))
      .force("collision", d3.forceCollide(28))
      .alphaDecay(0.025);

    return { ns, es };
  }

  function render() {
    const nodes = visibleNodes();
    const edges = visibleEdges();
    const { ns, es } = buildSim(nodes, edges);

    // Build lookups for fast access during tick
    const nodeById = new Map(ns.map(n => [n.id, n]));

    // ── Edges ────────────────────────────────────────
    const edgesG = d3.select("#edges-g");
    edgesG.selectAll("*").remove();
    const edgeLines = edgesG.selectAll("line")
      .data(es, d => d.id)
      .join("line")
      .attr("class", "edge-line")
      .on("click", (ev, d) => { ev.stopPropagation(); selectEdge(d.id); });

    // ── Edge labels ───────────────────────────────────
    const elG = d3.select("#edge-labels-g");
    elG.selectAll("*").remove();
    const edgeLabels = elG.selectAll("text")
      .data(es, d => d.id)
      .join("text")
      .attr("class", "edge-label")
      .text(d => d.action);

    // ── Nodes ─────────────────────────────────────────
    const nodesG = d3.select("#nodes-g");
    nodesG.selectAll("*").remove();

    const typeColor = d3.scaleOrdinal()
      .domain(["PERSON","PROJECT","ORGANIZATION","Entity"])
      .range(["#e8a96a","#e07070","#7ec8a4","#b48eff"]);

    const nodeCircles = nodesG.selectAll("circle")
      .data(ns, d => d.id)
      .join("circle")
      .attr("class", "node-circle")
      .attr("r", d => 6 + Math.min(Math.sqrt(d.degree || 1) * 3, 20))
      .attr("fill", d => typeColor(d.type || "Entity") + "22")
      .attr("stroke", d => typeColor(d.type || "Entity"))
      .call(d3.drag()
        .on("start", (ev, d) => { if (!ev.active) S.sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag",  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
        .on("end",   (ev, d) => { if (!ev.active) S.sim.alphaTarget(0); if (!S.frozen) { d.fx = null; d.fy = null; } })
      )
      .on("click", (ev, d) => { ev.stopPropagation(); selectNode(d.id); });

    // ── Node labels ───────────────────────────────────
    const nlG = d3.select("#node-labels-g");
    nlG.selectAll("*").remove();
    const nodeLabels = nlG.selectAll("text")
      .data(ns, d => d.id)
      .join("text")
      .attr("class", "node-label")
      .text(d => truncate(d.label, 18));

    // ── Tick ──────────────────────────────────────────
    S.sim.on("tick", () => {
      edgeLines
        .attr("x1", d => (typeof d.source === "object" ? d.source : nodeById.get(d.source))?.x || 0)
        .attr("y1", d => (typeof d.source === "object" ? d.source : nodeById.get(d.source))?.y || 0)
        .attr("x2", d => (typeof d.target === "object" ? d.target : nodeById.get(d.target))?.x || 0)
        .attr("y2", d => (typeof d.target === "object" ? d.target : nodeById.get(d.target))?.y || 0);

      edgeLabels
        .attr("x", d => {
          const sx = (typeof d.source === "object" ? d.source : nodeById.get(d.source))?.x || 0;
          const tx = (typeof d.target === "object" ? d.target : nodeById.get(d.target))?.x || 0;
          return (sx + tx) / 2;
        })
        .attr("y", d => {
          const sy = (typeof d.source === "object" ? d.source : nodeById.get(d.source))?.y || 0;
          const ty = (typeof d.target === "object" ? d.target : nodeById.get(d.target))?.y || 0;
          return (sy + ty) / 2 - 5;
        })
        .classed("hidden", !S.showLabels);

      nodeCircles
        .attr("cx", d => d.x)
        .attr("cy", d => d.y);

      nodeLabels
        .attr("x", d => d.x)
        .attr("y", d => d.y + (6 + Math.min(Math.sqrt(d.degree||1)*3, 20)) + 4)
        .classed("hidden", !S.showLabels);
    });

    // Click on background clears selection
    d3.select("#graph-svg").on("click", () => clearSelection());

    // Store refs for highlight updates
    S._edgeLines    = edgeLines;
    S._edgeLab      = edgeLabels;
    S._nodeCircles  = nodeCircles;
    S._nodeLabels   = nodeLabels;
    S._nodeById_d3  = nodeById;
  }

  render();
  S._render = render; // expose for filter changes

  // Fit view
  setTimeout(fitView, 600);
}

function fitView() {
  const svg = $("graph-svg");
  const w = svg.clientWidth, h = svg.clientHeight;
  d3.select("#graph-svg").transition().duration(500)
    .call(S.zoom.transform, d3.zoomIdentity.translate(w/2, h/2).scale(0.6).translate(-w/2, -h/2));
}

function focusNodeOnGraph(nodeId) {
  if (!S._nodeCircles) return;
  S._nodeCircles.each(function(d) {
    if (d.id === nodeId && d.x !== undefined) {
      const svg = $("graph-svg");
      const w = svg.clientWidth, h = svg.clientHeight;

      // Get the current zoom transform so we respect existing scale
      const current = d3.zoomTransform(svg);

      const sidebarW = 280;
      const drawerW  = $("drawer").classList.contains("hidden") ? 0 : 400;
      // True center of the visible area between sidebar and drawer
      const visibleCenterX = sidebarW + (w - sidebarW - drawerW) / 2;
      const visibleCenterY = h / 2;

      d3.select("#graph-svg").transition().duration(500)
        .call(S.zoom.transform, d3.zoomIdentity
          .translate(visibleCenterX - d.x * current.k, visibleCenterY - d.y * current.k)
          .scale(current.k));  // preserve current zoom level, don't force 1.2x
    }
  });
}

// ── Selection ──────────────────────────────────────────────
function selectNode(nodeId) {
  S.selectedId = nodeId;
  S.selectedKind = "node";
  const node = S.nodeMap.get(nodeId);
  if (!node) return;

  // Highlight graph
  highlightNode(nodeId);

  // Open drawer
  openDrawer("node", node.label, renderNodeDrawer(node));
  updateListActiveState();
}

function selectEdge(edgeId) {
  S.selectedId = edgeId;
  S.selectedKind = "edge";
  const edge = S.edgeMap.get(edgeId);
  if (!edge) return;
  switchTab("graph");
  highlightEdge(edgeId);
  if (S._nodeCircles) {
    S._nodeCircles.attr("opacity", d =>
      d.id === edge.source || d.id === edge.target ? 1 : 0.15
    );
  }
  focusEdgeOnGraph(edge);
  openDrawer("edge", `${edge.source} → ${edge.target}`, renderEdgeDrawer(edge));
}

function focusEdgeOnGraph(edge) {
  if (!S._nodeCircles) return;
  let sx, sy, tx, ty;
  S._nodeCircles.each(function(d) {
    if (d.id === edge.source) { sx = d.x; sy = d.y; }
    if (d.id === edge.target) { tx = d.x; ty = d.y; }
  });
  if (sx === undefined || tx === undefined) return;
  const svg = $("graph-svg");
  const w = svg.clientWidth, h = svg.clientHeight;
  const mx = (sx + tx) / 2, my = (sy + ty) / 2;

  const current = d3.zoomTransform(svg);

  const sidebarW = 280;
  const drawerW  = 400; // drawer is always open when focusing an edge
  const visibleCenterX = sidebarW + (w - sidebarW - drawerW) / 2;
  const visibleCenterY = h / 2;

  d3.select("#graph-svg").transition().duration(500)
    .call(S.zoom.transform, d3.zoomIdentity
      .translate(visibleCenterX - mx * current.k, visibleCenterY - my * current.k)
      .scale(current.k));
}
function selectEvidence(sourceId) {
  S.selectedId = sourceId;
  S.selectedKind = "evidence";
  const ev = S.evidenceMap.get(sourceId);
  if (!ev) return;
  openDrawer("evidence", sourceId, renderEvidenceDrawer(ev));
  switchTab("evidence");
  renderEvidenceList();
  requestAnimationFrame(() => {
    const active = $("evidence-list").querySelector(".list-row.active");
    if (active) active.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function selectMerge(idx) {
  S.selectedId = idx;
  S.selectedKind = "merge";
  const m = S.graph.merges[idx];
  if (!m) return;
  openDrawer("merge", `${m.alias} → ${m.canonical}`, renderMergeDrawer(m, idx));
}

function clearSelection() {
  S.selectedId = null;
  S.selectedKind = null;
  closeDrawer();
  if (S._edgeLines) S._edgeLines.classed("highlighted", false).classed("dimmed", false);
  if (S._nodeCircles) S._nodeCircles.attr("opacity", 1);
}

// ── Graph highlighting ──────────────────────────────────────
function highlightNode(nodeId) {
  if (!S._edgeLines || !S._nodeCircles) return;
  const connected = new Set([nodeId]);
  S.graph.edges.forEach(e => {
    if (e.source === nodeId || e.target === nodeId) {
      connected.add(e.source);
      connected.add(e.target);
    }
  });
  S._nodeCircles.attr("opacity", d => connected.has(d.id) ? 1 : 0.15);
  S._edgeLines
    .classed("highlighted", d => d.source === nodeId || d.target === nodeId ||
      (typeof d.source === "object" && (d.source.id === nodeId || d.target.id === nodeId)))
    .classed("dimmed", d => {
      const s = typeof d.source === "object" ? d.source.id : d.source;
      const t = typeof d.target === "object" ? d.target.id : d.target;
      return s !== nodeId && t !== nodeId;
    });
}

function highlightEdge(edgeId) {
  if (!S._edgeLines) return;
  S._edgeLines
    .classed("highlighted", d => d.id === edgeId)
    .classed("dimmed", d => d.id !== edgeId);
}

// ── Drawer renderers ───────────────────────────────────────
function renderNodeDrawer(node) {
  const edges = S.graph.edges.filter(e => e.source === node.id || e.target === node.id);
  const outgoing = edges.filter(e => e.source === node.id);
  const incoming = edges.filter(e => e.target === node.id);

  // ── Merge context: was this node absorbed from aliases? ──
  const mergesInvolving = (S.graph.merges || []).map((m,i) => ({...m, idx:i})).filter(m =>
    m.canonical === node.id || m.canonical === node.label ||
    m.alias === node.id || m.alias === node.label
  );
  const absorbedFrom = mergesInvolving.filter(m => m.canonical === node.id || m.canonical === node.label);
  const mergedInto   = mergesInvolving.filter(m => m.alias === node.id || m.alias === node.label);

  // ── All evidence directly attached to this node's edges ──
  const allEvidence = [];
  const seenQuotes = new Set();
  edges.forEach(e => {
    (e.evidence || []).forEach(ev => {
      const key = ev.source_id + "||" + ev.exact_quote;
      if (!seenQuotes.has(key)) {
        seenQuotes.add(key);
        allEvidence.push({ ...ev, edgeAction: e.action, edgeSrc: e.source, edgeTgt: e.target, edgeId: e.id });
      }
    });
  });

  const aliasHtml = node.aliases && node.aliases.length
    ? node.aliases.map(a => `<span style="font-family:var(--mono);font-size:11px;color:var(--ink3);background:var(--bg3);padding:2px 7px;border-radius:4px;border:1px solid var(--border2)">${escHtml(a)}</span>`).join(" ")
    : `<span style="color:var(--ink3)">None</span>`;

  const makeNeighborRow = (e, isOut) => {
    const otherId = isOut ? e.target : e.source;
    const other = S.nodeMap.get(otherId);
    const label = other ? other.label : otherId;
    return `<div class="neighbor-row" data-node="${escHtml(otherId)}">
      <span class="neighbor-action">${escHtml(e.action)}</span>
      <span class="arrow-dir">${isOut ? "→" : "←"}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis">${escHtml(truncate(label,28))}</span>
      <span style="font-size:10px;color:var(--ink3);font-family:var(--mono)">${e.proof_count||0}p</span>
    </div>`;
  };

  const mergeAbsorbedHtml = absorbedFrom.length ? `
    <div class="d-section">
      <div class="d-label">Absorbed From (${absorbedFrom.length} aliases)</div>
      <div class="d-card" style="padding:8px">
        ${absorbedFrom.map(m => `
          <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
            <span style="font-family:var(--mono);font-size:11px;color:var(--accent2)">${escHtml(m.alias)}</span>
            <span style="font-size:10px;color:var(--ink3);flex:1">${escHtml(m.reason)}</span>
            <span style="font-size:10px;cursor:pointer;color:var(--accent3)" data-merge-idx="${m.idx}">view →</span>
          </div>`).join("")}
      </div>
    </div>` : "";

  const mergedIntoHtml = mergedInto.length ? `
    <div class="d-section">
      <div class="d-label" style="color:var(--accent2)">⚠ This node was merged into another</div>
      <div class="d-card" style="border-color:rgba(224,112,112,0.3)">
        ${mergedInto.map(m => `
          <div style="display:flex;align-items:center;gap:8px;padding:3px 0">
            <span style="font-size:11px;color:var(--ink2)">Canonical:</span>
            <span style="font-family:var(--mono);font-size:12px;color:var(--accent);cursor:pointer" data-node="${escHtml(m.canonical)}">${escHtml(m.canonical)} →</span>
          </div>
          <div style="font-size:10px;color:var(--ink3);margin-top:2px">${escHtml(m.reason)}</div>`).join("")}
      </div>
    </div>` : "";

  const evidenceHtml = allEvidence.length ? `
    <div class="d-section">
      <div class="d-label">Evidence this entity exists (${allEvidence.length} quote${allEvidence.length!==1?"s":""})</div>
      ${allEvidence.slice(0,12).map(ev => `
        <div class="quote-card" style="margin-bottom:8px">
          <div style="font-size:10px;color:var(--accent3);font-family:var(--mono);margin-bottom:4px;font-style:normal">
            via: <span style="cursor:pointer" data-edge="${escHtml(ev.edgeId)}">${escHtml(ev.edgeSrc)} ${escHtml(ev.edgeAction)} ${escHtml(ev.edgeTgt)}</span>
          </div>
          "${escHtml(ev.exact_quote)}"
          <div class="quote-meta">
            <span style="cursor:pointer;color:var(--accent3)" data-evidence="${escHtml(ev.source_id)}">${escHtml(ev.source_id)}</span>
            · ${escHtml(ev.context_location||"")} · ${escHtml(ev.timestamp||"")}
          </div>
        </div>`).join("")}
      ${allEvidence.length > 12 ? `<div style="font-size:11px;color:var(--ink3);text-align:center;padding:4px">+${allEvidence.length-12} more — click individual edges to see all</div>` : ""}
    </div>` : `<div class="d-section"><div class="d-label">Evidence</div><div class="d-card"><span style="color:var(--ink3);font-size:12px">No direct evidence found for this node.</span></div></div>`;

  return `
    <div class="d-section">
      <div class="d-label">Entity</div>
      <div class="d-card">
        <div class="d-row"><span class="d-row-k">Type</span><span class="d-row-v">${escHtml(node.type||"Entity")}</span></div>
        <div class="d-row"><span class="d-row-k">Degree</span><span class="d-row-v">${node.degree}</span></div>
        <div class="d-row"><span class="d-row-k">Aliases</span><span class="d-row-v" style="display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end">${aliasHtml}</span></div>
      </div>
    </div>
    ${mergedIntoHtml}
    ${mergeAbsorbedHtml}
    ${evidenceHtml}
    ${outgoing.length ? `
    <div class="d-section">
      <div class="d-label">Outgoing (${outgoing.length})</div>
      <div class="d-card" style="padding:4px 8px">
        ${outgoing.map(e=>makeNeighborRow(e,true)).join("")}
      </div>
    </div>` : ""}
    ${incoming.length ? `
    <div class="d-section">
      <div class="d-label">Incoming (${incoming.length})</div>
      <div class="d-card" style="padding:4px 8px">
        ${incoming.map(e=>makeNeighborRow(e,false)).join("")}
      </div>
    </div>` : ""}
  `;
}

function renderEdgeDrawer(edge) {
  const srcNode = S.nodeMap.get(edge.source);
  const tgtNode = S.nodeMap.get(edge.target);
  const evidenceHtml = (edge.evidence || []).slice(0,10).map(ev => `
    <div class="quote-card" style="margin-bottom:8px">
      "${escHtml(ev.exact_quote)}"
      <div class="quote-meta">
        <span style="color:var(--accent3);cursor:pointer" data-evidence="${escHtml(ev.source_id)}">${escHtml(ev.source_id)}</span>
        · ${escHtml(ev.context_location||"")} · ${escHtml(ev.timestamp||"")}
      </div>
    </div>`).join("") || `<div style="color:var(--ink3);font-size:12px">No evidence linked</div>`;

  const confVal = Math.round((edge.confidence||0.85)*100);

  return `
    <div class="d-section">
      <div class="d-label">Relationship</div>
      <div class="d-card">
        <div class="d-row"><span class="d-row-k">Action</span><span class="d-row-v" style="color:var(--accent2)">${escHtml(edge.action)}</span></div>
        <div class="d-row"><span class="d-row-k">From</span><span class="d-row-v" style="cursor:pointer;color:var(--accent)" data-node="${escHtml(edge.source)}">${escHtml(srcNode?srcNode.label:edge.source)}</span></div>
        <div class="d-row"><span class="d-row-k">To</span><span class="d-row-v" style="cursor:pointer;color:var(--accent)" data-node="${escHtml(edge.target)}">${escHtml(tgtNode?tgtNode.label:edge.target)}</span></div>
        <div class="d-row"><span class="d-row-k">First seen</span><span class="d-row-v">${escHtml(edge.first_seen||"—")}</span></div>
        <div class="d-row"><span class="d-row-k">Last seen</span><span class="d-row-v">${escHtml(edge.last_seen||"—")}</span></div>
        <div class="d-row"><span class="d-row-k">Proof count</span><span class="d-row-v">${edge.proof_count||0}</span></div>
      </div>
    </div>
    <div class="d-section">
      <div class="d-label">Confidence</div>
      <div class="d-card">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px">
          <span style="color:var(--ink2)">LLM self-score</span>
          <span style="color:var(--accent);font-family:var(--mono)">${confVal}%</span>
        </div>
        <div class="conf-bar-wrap"><div class="conf-bar-fill" style="width:${confVal}%"></div></div>
        <div style="font-size:10px;color:var(--ink3);margin-top:6px">Note: LLM confidence is self-reported and not calibrated.</div>
      </div>
    </div>
    <div class="d-section">
      <div class="d-label">Evidence (${(edge.evidence||[]).length})</div>
      ${evidenceHtml}
    </div>
  `;
}

function renderEvidenceDrawer(ev) {
  const linkedEdges = (ev.edge_ids || []).map(eid => {
    const e = S.edgeMap.get(eid);
    return e ? `<span class="edge-pill" data-edge="${escHtml(eid)}">${escHtml(e.source)} ${escHtml(e.action)} ${escHtml(e.target)}</span>` : "";
  }).join("");

  const quotesHtml = (ev.quotes || []).slice(0,8).map(q => `
    <div class="quote-card" style="margin-bottom:8px">
      "${escHtml(q.quote)}"
      <div class="quote-meta">${escHtml(q.location||"")} · ${escHtml(q.timestamp||"")}</div>
    </div>`).join("") || `<div style="color:var(--ink3);font-size:12px">No quotes</div>`;

  return `
    <div class="d-section">
      <div class="d-label">Source ID</div>
      <div class="d-card" style="font-family:var(--mono);font-size:11px;word-break:break-all">${escHtml(ev.source_id)}</div>
    </div>
    <div class="d-section">
      <div class="d-label">Timestamp</div>
      <div class="d-card" style="font-family:var(--mono);font-size:12px">${escHtml(ev.timestamp||"Unknown")}</div>
    </div>
    <div class="d-section">
      <div class="d-label">Quotes (${(ev.quotes||[]).length})</div>
      ${quotesHtml}
    </div>
    <div class="d-section">
      <div class="d-label">Linked Claims (${(ev.edge_ids||[]).length})</div>
      <div class="edge-pills">${linkedEdges || `<span style="color:var(--ink3);font-size:12px">None</span>`}</div>
    </div>
  `;
}

function renderMergeDrawer(m, idx) {
  const undone = S.undoSet.has(idx);

  // ── Find evidence using original_sources / original_targets ──────────────
  // These arrays are written by resolve.py and contain the raw names as they
  // appeared in the source text before canonicalization — works on existing data.
  const aliasLower  = m.alias.toLowerCase().trim();
  const canonLower  = m.canonical.toLowerCase().trim();

  // Claims where the alias name was used as source or target
  const aliasClaims = S.graph.edges.filter(e =>
    (e.original_sources || []).some(n => n.toLowerCase().trim() === aliasLower) ||
    (e.original_targets || []).some(n => n.toLowerCase().trim() === aliasLower)
  );

  // Claims where the canonical name was used (excluding ones also in alias claims)
  const aliasEdgeIds = new Set(aliasClaims.map(e => e.id));
  const canonClaims  = S.graph.edges.filter(e =>
    !aliasEdgeIds.has(e.id) && (
      (e.original_sources || []).some(n => n.toLowerCase().trim() === canonLower) ||
      (e.original_targets || []).some(n => n.toLowerCase().trim() === canonLower)
    )
  );

  // Claims found under both names (the merge actually collapsed these)
  const sharedClaims = S.graph.edges.filter(e =>
    aliasEdgeIds.has(e.id) && (
      (e.original_sources || []).some(n => n.toLowerCase().trim() === canonLower) ||
      (e.original_targets || []).some(n => n.toLowerCase().trim() === canonLower)
    )
  );

  const makeClaimRow = (edge) => {
    const quotes = (edge.evidence || []).slice(0, 2);
    const quotesHtml = quotes.map(ev => `
      <div class="merge-proof-quote">"${escHtml(truncate(ev.exact_quote, 120))}"</div>
      <div class="merge-proof-meta">
        <span data-evidence="${escHtml(ev.source_id)}" style="cursor:pointer;color:var(--accent3)">${escHtml(ev.source_id)}</span>
        · ${escHtml(ev.context_location || "")} · ${escHtml(ev.timestamp || "")}
      </div>`).join("") || `<div style="color:var(--ink3);font-size:11px;font-style:italic">No quotes on this claim</div>`;

    return `
      <div class="merge-proof-card" style="margin-bottom:8px">
        <div class="merge-proof-name" style="margin-bottom:6px">
          <span data-edge="${escHtml(edge.id)}" style="cursor:pointer;color:var(--ink2)">
            ${escHtml(edge.source)} <span style="color:var(--accent2)">${escHtml(edge.action)}</span> ${escHtml(edge.target)}
          </span>
          <span style="font-family:var(--mono);font-size:10px;color:var(--ink3);margin-left:6px">${edge.proof_count||0} proof(s)</span>
        </div>
        <div style="font-size:11px;color:var(--ink3);font-family:var(--mono);margin-bottom:4px">
          raw names used: ${escHtml([...(edge.original_sources||[]), ...(edge.original_targets||[])].join(", "))}
        </div>
        ${quotesHtml}
      </div>`;
  };

  const noClaimsMsg = `<div style="color:var(--ink3);font-size:11px;padding:6px 0;font-style:italic">No claims found using this name</div>`;

  const aliasSection = aliasClaims.length
    ? aliasClaims.slice(0, 5).map(makeClaimRow).join("") +
      (aliasClaims.length > 5 ? `<div style="color:var(--ink3);font-size:11px;padding:4px 0">+${aliasClaims.length - 5} more</div>` : "")
    : noClaimsMsg;

  const canonSection = canonClaims.length
    ? canonClaims.slice(0, 5).map(makeClaimRow).join("") +
      (canonClaims.length > 5 ? `<div style="color:var(--ink3);font-size:11px;padding:4px 0">+${canonClaims.length - 5} more</div>` : "")
    : noClaimsMsg;

  const sharedSection = sharedClaims.length ? `
    <div class="d-section">
      <div class="d-label" style="color:var(--accent3)">✓ Shared Claims — used both names (${sharedClaims.length})</div>
      <div class="d-card" style="border-color:rgba(126,200,164,0.3)">
        <div style="font-size:11px;color:var(--ink3);margin-bottom:8px">These claims reference both names — strong evidence the merge is correct.</div>
        ${sharedClaims.slice(0, 3).map(makeClaimRow).join("")}
      </div>
    </div>` : "";

  const totalAlias = aliasClaims.length;
  const totalCanon = canonClaims.length;
  const verdict = totalAlias === 0 && totalCanon === 0
    ? `<span style="color:var(--ink3)">No claims found for either name — merge may be noise</span>`
    : totalAlias > 0 && totalCanon === 0
    ? `<span style="color:var(--accent2)">Alias-only usage — canonical name never appeared independently. Consider undoing.</span>`
    : totalAlias === 0 && totalCanon > 0
    ? `<span style="color:var(--accent3)">Alias absorbed into canonical with no independent alias claims. Merge looks safe.</span>`
    : `<span style="color:var(--ink2)">Both names had independent usage. Review claims below before deciding.</span>`;

  return `
    <div class="d-section">
      <div class="d-label">Merge Resolution</div>
      <div class="d-card" style="${undone ? "opacity:0.5;border-color:var(--accent2)" : ""}">
        <div class="merge-diff-row">
          <span class="mdr-alias">${escHtml(m.alias)}</span>
          <span class="mdr-arrow">→</span>
          <span class="mdr-canon">${escHtml(m.canonical)}</span>
        </div>
        <div class="mdr-reason">${escHtml(m.reason)}</div>
      </div>
    </div>

    <div class="d-section">
      <div class="d-label">Quick Verdict</div>
      <div class="d-card" style="font-size:12px">${verdict}</div>
    </div>

    <div class="d-section">
      <div class="d-label" style="color:var(--accent2)">Alias side — "${escHtml(m.alias)}" (${totalAlias} claim${totalAlias !== 1 ? "s" : ""})</div>
      <div class="d-card" style="border-color:rgba(224,112,112,0.25);padding:8px">
        <div style="font-size:11px;color:var(--ink3);margin-bottom:8px">Claims where this name appeared in the source text before merging.</div>
        ${aliasSection}
      </div>
    </div>

    <div class="d-section">
      <div class="d-label" style="color:var(--accent)">Canonical side — "${escHtml(m.canonical)}" (${totalCanon} claim${totalCanon !== 1 ? "s" : ""})</div>
      <div class="d-card" style="border-color:rgba(232,169,106,0.25);padding:8px">
        <div style="font-size:11px;color:var(--ink3);margin-bottom:8px">Claims where the canonical name appeared independently.</div>
        ${canonSection}
      </div>
    </div>

    ${sharedSection}

    <div class="d-section">
      <div class="d-label">Details</div>
      <div class="d-card">
        <div class="d-row"><span class="d-row-k">Type</span><span class="d-row-v">${escHtml(m.type || "—")}</span></div>
        <div class="d-row"><span class="d-row-k">Reason</span><span class="d-row-v">${escHtml(m.reason || "—")}</span></div>
        <div class="d-row"><span class="d-row-k">Status</span><span class="d-row-v" style="color:${undone ? "var(--accent2)" : "var(--accent3)"}">${undone ? "⚠ Queued for undo" : "✓ Active"}</span></div>
      </div>
    </div>

    <div class="d-section">
      <div class="d-label">Action</div>
      <div class="d-card" style="display:flex;flex-direction:column;gap:8px">
        <button class="pill-btn" data-undo-merge="${idx}" style="width:100%;${undone ? "background:rgba(126,200,164,0.1);border-color:var(--accent3);color:var(--accent3)" : "background:rgba(224,112,112,0.1);border-color:var(--accent2);color:var(--accent2)"}">
          ${undone ? "↩ Restore this merge" : "✕ Undo this merge"}
        </button>
        <div style="font-size:11px;color:var(--ink3)">Undone merges are queued. Click "Rebuild Graph" in the Graph tab to apply all changes.</div>
      </div>
    </div>

    <div class="d-section">
      <div class="d-label">Jump to canonical node</div>
      <div style="cursor:pointer;color:var(--accent);font-size:13px;padding:4px 0" data-node="${escHtml(m.canonical)}">${escHtml(m.canonical)} →</div>
    </div>
  `;
}


// ── Drawer open/close ──────────────────────────────────────
function openDrawer(kind, title, html) {
  const drawer = $("drawer");
  $("drawer-kind-badge").className = `kind-badge kind-${kind}`;
  $("drawer-kind-badge").textContent = kind;
  $("drawer-title").textContent = title;
  $("drawer-body").innerHTML = html;
  drawer.classList.remove("hidden");
  $("main").classList.add("drawer-open");
  wireDrawerClicks();
}

function closeDrawer() {
  $("drawer").classList.add("hidden");
  $("main").classList.remove("drawer-open");
}

function wireDrawerClicks() {
  $("drawer-body").querySelectorAll("[data-node]").forEach(el => {
    el.addEventListener("click", () => { selectNode(el.dataset.node); focusNodeOnGraph(el.dataset.node); });
  });
  $("drawer-body").querySelectorAll("[data-edge]").forEach(el => {
    el.addEventListener("click", () => selectEdge(el.dataset.edge));
  });
  $("drawer-body").querySelectorAll("[data-evidence]").forEach(el => {
    el.addEventListener("click", () => selectEvidence(el.dataset.evidence));
  });
  $("drawer-body").querySelectorAll(".neighbor-row[data-node]").forEach(el => {
    el.addEventListener("click", () => { selectNode(el.dataset.node); focusNodeOnGraph(el.dataset.node); });
  });
  $("drawer-body").querySelectorAll("[data-merge-idx]").forEach(el => {
    el.addEventListener("click", () => selectMerge(parseInt(el.dataset.mergeIdx, 10)));
  });
  $("drawer-body").querySelectorAll("[data-undo-merge]").forEach(el => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.undoMerge, 10);
      toggleUndoMerge(idx);
      $("drawer-body").innerHTML = renderMergeDrawer(S.graph.merges[idx], idx);
      wireDrawerClicks();
    });
  });
}

// ── Tab switching ──────────────────────────────────────────
function switchTab(tab) {
  S.currentTab = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("hidden", p.id !== `tab-${tab}`));
}

function updateListActiveState() {
  document.querySelectorAll(".list-row").forEach(row => row.classList.remove("active"));
}

// ── Global search ──────────────────────────────────────────
function runGlobalSearch(query) {
  const q = query.toLowerCase().trim();
  const results = $("search-results");
  if (!q) { results.classList.add("hidden"); return; }

  const hits = [];

  // Search nodes
  S.graph.nodes.forEach(n => {
    if (n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q) ||
        (n.aliases||[]).some(a=>a.toLowerCase().includes(q))) {
      hits.push({ kind: "node", label: n.label, sub: `${n.type} · degree ${n.degree}`, id: n.id });
    }
  });

  // Search edges by action
  S.graph.edges.forEach(e => {
    if (e.action.toLowerCase().includes(q) || e.source.toLowerCase().includes(q) || e.target.toLowerCase().includes(q)) {
      hits.push({ kind: "edge", label: `${e.source} ${e.action} ${e.target}`, sub: `${e.proof_count||0} proofs`, id: e.id });
    }
  });

  // Search evidence quotes
  S.graph.evidence.forEach(ev => {
    if (ev.source_id.toLowerCase().includes(q) || (ev.quotes||[]).some(qt=>qt.quote.toLowerCase().includes(q))) {
      const preview = ev.quotes&&ev.quotes[0] ? truncate(ev.quotes[0].quote,70) : ev.source_id;
      hits.push({ kind: "evidence", label: ev.source_id, sub: preview, id: ev.source_id });
    }
  });

  if (!hits.length) {
    results.innerHTML = `<div class="sr-item"><span class="sr-label" style="color:var(--ink3)">No results</span></div>`;
    results.classList.remove("hidden");
    return;
  }

  results.innerHTML = hits.slice(0,20).map(h => `
    <div class="sr-item" data-kind="${h.kind}" data-id="${escHtml(h.id)}">
      <div class="sr-label">${highlight(escHtml(h.label), q)}</div>
      <div class="sr-kind">${h.kind} · ${escHtml(truncate(h.sub, 60))}</div>
    </div>
  `).join("");
  results.classList.remove("hidden");

  results.querySelectorAll(".sr-item").forEach(item => {
    item.addEventListener("click", () => {
      const kind = item.dataset.kind, id = item.dataset.id;
      results.classList.add("hidden");
      $("global-search").value = "";
      if (kind === "node") { switchTab("graph"); selectNode(id); focusNodeOnGraph(id); }
      else if (kind === "edge") { switchTab("graph"); selectEdge(id); }
      else if (kind === "evidence") { selectEvidence(id); }
    });
  });
}

// ── Wire UI ────────────────────────────────────────────────
function wireUI() {
  // Tabs
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  });

  // Drawer close
  $("drawer-close").addEventListener("click", closeDrawer);

  // Global search
  $("global-search").addEventListener("input", e => runGlobalSearch(e.target.value));
  $("global-search").addEventListener("keydown", e => {
    if (e.key === "Escape") { $("search-results").classList.add("hidden"); $("global-search").value = ""; }
  });
  document.addEventListener("click", e => {
    if (!$("search-wrap").contains(e.target)) $("search-results").classList.add("hidden");
  });

  // Entity search
  $("entity-search").addEventListener("input", e => renderEntityList(e.target.value));

  // Evidence search
  $("evidence-search").addEventListener("input", e => renderEvidenceList(e.target.value));

  // Relation filter
  $("filter-relation").addEventListener("change", e => {
    S.filterRelation = e.target.value;
    if (S._render) S._render();
  });

  // Labels toggle
  $("show-labels").addEventListener("change", e => {
    S.showLabels = e.target.checked;
    if (S._nodeLabels) S._nodeLabels.classed("hidden", !S.showLabels);
    if (S._edgeLab) S._edgeLab.classed("hidden", !S.showLabels);
  });

  // Orphans toggle
  $("show-orphans").addEventListener("change", e => {
    S.showOrphans = e.target.checked;
    if (S._render) S._render();
  });

  // Reset / Freeze
  $("btn-reset").addEventListener("click", () => {
    S.frozen = false;
    $("btn-freeze").classList.remove("active");
    $("btn-freeze").textContent = "Freeze";
    if (S.sim) S.sim.alpha(0.5).restart();
  });

  $("btn-freeze").addEventListener("click", () => {
    S.frozen = !S.frozen;
    $("btn-freeze").classList.toggle("active", S.frozen);
    $("btn-freeze").textContent = S.frozen ? "Unfreeze" : "Freeze";
    if (S.frozen && S.sim) S.sim.stop();
    else if (!S.frozen && S.sim) S.sim.alpha(0.3).restart();
  });

  // Rebuild Graph — posts blocklist to Flask, polls until done, then reloads
  $("btn-regen").addEventListener("click", async () => {
    if (S.undoSet.size === 0 && !S.graph.merges.some((_, i) => S.undoSet.has(i))) {
      // No undos queued — just re-simulate the layout
      if (S._render) { S._render(); fitView(); }
      return;
    }

    // Build blocklist from queued undos
    const blocklist = [];
    S.graph.merges.forEach((m, i) => {
      if (S.undoSet.has(i)) blocklist.push({ alias: m.alias, canonical: m.canonical });
    });

    showPipelineOverlay("Starting pipeline…");

    try {
      const res = await fetch("/api/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocklist })
      });

      if (res.status === 409) {
        hidePipelineOverlay();
        alert("Pipeline is already running. Wait for it to finish.");
        return;
      }
      if (!res.ok) throw new Error(`Server error ${res.status}`);

      // Poll /api/status until done or error
      pollPipelineStatus();

    } catch (e) {
      hidePipelineOverlay();
      alert(`Could not reach server: ${e.message}\n\nMake sure server.py is running on port 5050.`);
    }
  });

  // Zoom controls
  $("zin").addEventListener("click",  () => d3.select("#graph-svg").transition().call(S.zoom.scaleBy, 1.4));
  $("zout").addEventListener("click", () => d3.select("#graph-svg").transition().call(S.zoom.scaleBy, 0.7));
  $("zfit").addEventListener("click", fitView);
}

// ── Pipeline overlay ───────────────────────────────────────
let _pollTimer = null;

function showPipelineOverlay(msg) {
  const ov = $("loading-overlay");
  ov.innerHTML = `
    <div class="spinner"></div>
    <p id="pipeline-msg" style="color:var(--ink2);text-align:center;max-width:260px">${escHtml(msg)}</p>
    <div id="pipeline-step" style="font-size:10px;color:var(--ink3);font-family:var(--mono);margin-top:4px"></div>
  `;
  ov.classList.remove("hidden");
}

function hidePipelineOverlay() {
  $("loading-overlay").classList.add("hidden");
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function pollPipelineStatus() {
  const STEP_LABELS = { resolve: "Step 1/2 — resolve.py", graph: "Step 2/2 — graph.py", "": "" };

  _pollTimer = setInterval(async () => {
    try {
      const res  = await fetch("/api/status");
      const data = await res.json();

      const msgEl  = $("pipeline-msg");
      const stepEl = $("pipeline-step");

      if (msgEl) msgEl.textContent  = data.message || "Running…";
      if (stepEl) stepEl.textContent = STEP_LABELS[data.step] || "";

      if (data.state === "done") {
        hidePipelineOverlay();
        // Clear undo state then reload graph data fresh from server
        S.undoSet.clear();
        $("undo-count").textContent = "0";
        $("undo-notice").classList.add("hidden");
        await reloadGraphData();
      } else if (data.state === "error") {
        hidePipelineOverlay();
        alert(`Pipeline failed at step "${data.step}":\n\n${data.message}`);
      }
    } catch (e) {
      // network hiccup — keep polling
    }
  }, 800);
}

async function reloadGraphData() {
  try {
    const res = await fetch(`./data/graph.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S.graph = await res.json();

    // Re-mark any merges that are in the persistent blocklist as undone
    // so they show correctly in the UI across sessions
    try {
      const blRes = await fetch(`/api/blocklist?t=${Date.now()}`);
      const blocklist = await blRes.json();
      const blocked = new Set(blocklist.map(e => `${e.alias}||${e.canonical}`));
      S.undoSet.clear();
      S.graph.merges.forEach((m, i) => {
        if (blocked.has(`${m.alias}||${m.canonical}`)) S.undoSet.add(i);
      });
      const count = S.undoSet.size;
      $("undo-count").textContent = count;
      $("undo-notice").classList.toggle("hidden", count === 0);
    } catch(e) { /* blocklist fetch failed — not critical */ }

    S.nodeMap.clear(); S.edgeMap.clear(); S.evidenceMap.clear();
    indexData();
    populateStats();
    buildRelationFilter();
    buildEntityTypeChips();
    renderEntityList();
    renderEvidenceList();
    renderMergeList();
    closeDrawer();
    if (S._render) { S._render(); setTimeout(fitView, 500); }
  } catch (e) {
    alert(`Could not reload graph data: ${e.message}`);
  }
}

// ── Utils ──────────────────────────────────────────────────
function escHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function truncate(s, n=80) {
  if (!s) return "";
  return s.length > n ? s.slice(0,n)+"…" : s;
}
function highlight(html, q) {
  if (!q) return html;
  try {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"), "ig");
    return html.replace(re, m => `<mark>${m}</mark>`);
  } catch { return html; }
}

// ── Go ─────────────────────────────────────────────────────
boot();