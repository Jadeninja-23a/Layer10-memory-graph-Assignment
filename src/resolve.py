import json
import os
from thefuzz import fuzz
from email.utils import parsedate_to_datetime
from datetime import datetime

BLOCKLIST_FILE = "data/merge_blocklist.json"

# ==========================================
# HELPER: TEMPORAL PARSER
# ==========================================
def parse_email_date(date_str):
    try:
        if date_str == "UNKNOWN":
            return datetime.min
        return parsedate_to_datetime(date_str)
    except Exception:
        return datetime.min


# ==========================================
# BLOCKLIST LOADER
# ==========================================
def load_blocklist():
    """
    Reads merge_blocklist.json — pairs the UI has marked as bad merges.
    Returns a set of (alias_lower, canonical_lower) tuples to skip.
    """
    if not os.path.exists(BLOCKLIST_FILE):
        return set()
    with open(BLOCKLIST_FILE) as f:
        entries = json.load(f)
    blocked = {
        (e["alias"].lower().strip(), e["canonical"].lower().strip())
        for e in entries
        if "alias" in e and "canonical" in e
    }
    print(f"  Blocklist loaded: {len(blocked)} pair(s) will be skipped")
    return blocked


# ==========================================
# PHASE 1: THE PHONE BOOK (BALANCED MODE)
# ==========================================
def build_canonical_map(memories):
    print("Building canonical entity map (Balanced Mode)...")
    blocked_pairs = load_blocklist()

    # Build a set of names that actually appear in at least one relationship
    # Entities with no relationships will never be graph nodes — skip merging them
    active_names = set()
    for memory in memories:
        for rel in memory.get('relationships', []):
            active_names.add(rel['source'].lower().strip())
            active_names.add(rel['target'].lower().strip())

    print(f"  {len(active_names)} active entity names found in relationships")

    knowledge_base = {"PERSON": {}, "PROJECT": {}, "ORGANIZATION": {}}
    audit_trail = []

    for memory in memories:
        for entity in memory.get('entities', []):
            raw_name = entity['name']
            ent_type = entity['entity_type']

            # Skip entirely if this entity never appears in any relationship
            if raw_name.lower().strip() not in active_names:
                continue

            if ent_type not in knowledge_base:
                continue

            block = knowledge_base[ent_type]
            norm_name = raw_name.lower().strip()

            if norm_name in block:
                continue

            found_match = False
            for known_alias, canonical_name in block.items():

                # BLOCKLIST CHECK — skip this pair if the UI flagged it
                pair = (norm_name, canonical_name.lower().strip())
                if pair in blocked_pairs:
                    continue

                is_substring = (norm_name in known_alias or known_alias in norm_name)
                is_safe_substring = is_substring and min(len(norm_name), len(known_alias)) >= 4

                similarity = fuzz.token_set_ratio(norm_name, known_alias)

                if is_safe_substring or similarity >= 78:
                    block[norm_name] = canonical_name
                    found_match = True

                    reason = "Safe Substring" if is_safe_substring else f"Balanced Fuzzy Score {similarity}"
                    audit_trail.append({
                        "original": raw_name,
                        "mapped_to": canonical_name,
                        "type": ent_type,
                        "reason": reason
                    })
                    print(f"   [MERGE] '{raw_name}' -> '{canonical_name}' ({reason})")
                    break

            if not found_match:
                block[norm_name] = raw_name

    return knowledge_base, audit_trail


# ==========================================
# PHASE 2: CLAIM DEDUP, ARTIFACT DEDUP, & CONFLICTS
# ==========================================
def resolve_and_dedup_claims(memories, knowledge_base):
    """
    Deduplicates claims and builds temporal timelines.
    Now tags each proof item with the raw name that appeared in the source text
    so the UI can show alias-side vs canonical-side evidence in the merge viewer.
    """
    print("Deduplicating claims and building temporal timelines...")

    master_claims = {}

    for memory in memories:
        for rel in memory.get('relationships', []):

            source_raw = rel['source']
            target_raw = rel['target']

            # Look up canonical names
            canonical_source = source_raw
            for block in knowledge_base.values():
                if source_raw.lower().strip() in block:
                    canonical_source = block[source_raw.lower().strip()]
                    break

            canonical_target = target_raw
            for block in knowledge_base.values():
                if target_raw.lower().strip() in block:
                    canonical_target = block[target_raw.lower().strip()]
                    break

            action = rel['action'].lower().strip()
            claim_sig = (canonical_source, action, canonical_target)

            if claim_sig not in master_claims:
                master_claims[claim_sig] = {
                    "source": canonical_source,
                    "action": action,
                    "target": canonical_target,
                    "original_sources": {source_raw},
                    "original_targets": {target_raw},
                    "proof_timeline": []
                }
            else:
                master_claims[claim_sig]["original_sources"].add(source_raw)
                master_claims[claim_sig]["original_targets"].add(target_raw)

            for new_proof in rel.get('proof', []):
                new_quote = new_proof['exact_quote'].strip()

                is_duplicate_artifact = any(
                    existing['exact_quote'].strip() == new_quote
                    for existing in master_claims[claim_sig]["proof_timeline"]
                )

                if not is_duplicate_artifact:
                    # TAG: record which raw names appeared in the source text
                    # This is what the UI uses to split evidence by alias vs canonical
                    proof_with_origin = {
                        **new_proof,
                        "raw_source_name": source_raw,
                        "raw_target_name": target_raw,
                    }
                    master_claims[claim_sig]["proof_timeline"].append(proof_with_origin)

    # Sort evidence by time and add metadata
    final_resolved_claims = []

    for claim in master_claims.values():
        claim["original_sources"] = list(claim["original_sources"])
        claim["original_targets"] = list(claim["original_targets"])

        timeline = claim["proof_timeline"]
        timeline.sort(key=lambda x: parse_email_date(x.get('timestamp', 'UNKNOWN')))

        if timeline:
            claim["first_seen"] = timeline[0].get('timestamp', 'UNKNOWN')
            claim["last_seen"] = timeline[-1].get('timestamp', 'UNKNOWN')
            claim["total_independent_proofs"] = len(timeline)

        final_resolved_claims.append(claim)

    return final_resolved_claims


if __name__ == "__main__":
    input_file  = "data/extracted_memories.json"
    output_file = "data/resolved_memories.json"
    audit_file  = "data/resolution_audit.json"

    with open(input_file, 'r') as f:
        memories = json.load(f)

    kb_map, audit_log = build_canonical_map(memories)

    with open(audit_file, "w") as f:
        json.dump(audit_log, f, indent=2)
    print(f"Saved audit log to {audit_file}")

    final_claims = resolve_and_dedup_claims(memories, kb_map)

    with open(output_file, "w") as f:
        json.dump(final_claims, f, indent=2)

    print(f"Pipeline complete. {len(final_claims)} distinct claims → {output_file}")