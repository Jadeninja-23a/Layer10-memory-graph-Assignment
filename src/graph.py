"""
graph.py — Builds a visualization-ready graph JSON from resolved_memories.json
Run: python graph.py
Output: data/graph.json (consumed by index.html)
"""

import json
import os
from collections import defaultdict

INPUT_RESOLVED = "data/resolved_memories.json"
INPUT_AUDIT    = "data/resolution_audit.json"
OUTPUT_GRAPH   = "data/graph.json"


def build_graph():
    # ── Load inputs ──────────────────────────────────────────────
    with open(INPUT_RESOLVED, "r") as f:
        claims = json.load(f)

    audit_log = []
    if os.path.exists(INPUT_AUDIT):
        with open(INPUT_AUDIT, "r") as f:
            audit_log = json.load(f)

    # ── Index merges: alias → canonical ──────────────────────────
    alias_map = {}
    for entry in audit_log:
        alias_map[entry["original"].lower().strip()] = entry["mapped_to"]

    # ── Collect nodes ─────────────────────────────────────────────
    node_ids   = set()
    node_meta  = {}   # id → {type, aliases, degree}

    def register_node(name):
        node_ids.add(name)
        if name not in node_meta:
            node_meta[name] = {"type": "Entity", "aliases": [], "degree": 0}

    # ── Build edges ───────────────────────────────────────────────
    edges = []
    for i, claim in enumerate(claims):
        src = claim["source"]
        tgt = claim["target"]
        register_node(src)
        register_node(tgt)
        node_meta[src]["degree"] += 1
        node_meta[tgt]["degree"] += 1

        # Collapse all proof into a flat evidence list
        evidence_list = []
        for proof in claim.get("proof_timeline", []):
            evidence_list.append({
                "source_id":        proof.get("source_id", ""),
                "exact_quote":      proof.get("exact_quote", ""),
                "timestamp":        proof.get("timestamp", ""),
                "context_location": proof.get("context_location", ""),
                "raw_source_name":  proof.get("raw_source_name", ""),
                "raw_target_name":  proof.get("raw_target_name", ""),
            })

        edges.append({
            "id":               f"e{i}",
            "source":           src,
            "target":           tgt,
            "action":           claim.get("action", "related_to"),
            "first_seen":       claim.get("first_seen", ""),
            "last_seen":        claim.get("last_seen", ""),
            "proof_count":      claim.get("total_independent_proofs", len(evidence_list)),
            "original_sources": claim.get("original_sources", [src]),
            "original_targets": claim.get("original_targets", [tgt]),
            "evidence":         evidence_list
        })

    # ── Attach aliases back onto canonical nodes ──────────────────
    for alias, canonical in alias_map.items():
        if canonical in node_meta:
            node_meta[canonical]["aliases"].append(alias)

    # ── Build node list ───────────────────────────────────────────
    nodes = []
    for nid in sorted(node_ids):
        meta = node_meta[nid]
        nodes.append({
            "id":      nid,
            "label":   nid,
            "type":    meta["type"],
            "degree":  meta["degree"],
            "aliases": meta["aliases"]
        })

    # ── Build evidence index (source_id → [edge ids]) ────────────
    evidence_index = defaultdict(list)
    for edge in edges:
        for ev in edge["evidence"]:
            sid = ev.get("source_id", "")
            if sid:
                evidence_index[sid].append(edge["id"])

    evidence_items = []
    for sid, edge_ids in evidence_index.items():
        # Gather unique quotes for this source
        seen_quotes = set()
        quotes = []
        for eid in edge_ids:
            edge = next((e for e in edges if e["id"] == eid), None)
            if edge:
                for ev in edge["evidence"]:
                    if ev.get("source_id") == sid and ev["exact_quote"] not in seen_quotes:
                        seen_quotes.add(ev["exact_quote"])
                        quotes.append({
                            "quote":    ev["exact_quote"],
                            "location": ev.get("context_location", ""),
                            "timestamp": ev.get("timestamp", "")
                        })
        evidence_items.append({
            "source_id": sid,
            "edge_ids":  edge_ids,
            "quotes":    quotes,
            "timestamp": quotes[0]["timestamp"] if quotes else ""
        })

    # ── Build merge list ──────────────────────────────────────────
    merges = [
        {
            "alias":     e["original"],
            "canonical": e["mapped_to"],
            "type":      e.get("type", ""),
            "reason":    e.get("reason", "")
        }
        for e in audit_log
    ]

    # ── Assemble graph.json ───────────────────────────────────────
    graph = {
        "meta": {
            "node_count":     len(nodes),
            "edge_count":     len(edges),
            "evidence_count": len(evidence_items),
            "merge_count":    len(merges),
            "built_at":       __import__("datetime").datetime.utcnow().isoformat() + "Z"
        },
        "nodes":    nodes,
        "edges":    edges,
        "evidence": evidence_items,
        "merges":   merges
    }

    os.makedirs(os.path.dirname(OUTPUT_GRAPH), exist_ok=True)
    with open(OUTPUT_GRAPH, "w") as f:
        json.dump(graph, f, indent=2)

    print(f"✓ graph.json built:")
    print(f"  {len(nodes)} nodes, {len(edges)} edges, "
          f"{len(evidence_items)} evidence sources, {len(merges)} merges")
    print(f"  → {OUTPUT_GRAPH}")


if __name__ == "__main__":
    build_graph()