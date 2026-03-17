"""
server.py — Memory Graph Explorer backend
Run: python server.py
Opens at: http://localhost:5050

Routes:
  GET  /                      → serves index.html
  GET  /data/<file>           → serves data files (graph.json etc.)
  POST /api/rebuild           → writes blocklist, reruns resolve.py + graph.py
  GET  /api/status            → returns pipeline status (idle / running / error)
  GET  /api/blocklist         → returns current merge_blocklist.json
  DELETE /api/blocklist       → clears the blocklist
"""

import os
import atexit
import signal
import json
import threading
import subprocess
import sys
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from datetime import datetime

# ── Config ─────────────────────────────────────────────────
# server.py lives in src/ — everything else is one level up at project root
SRC_DIR        = os.path.dirname(os.path.abspath(__file__))
BASE_DIR       = os.path.dirname(SRC_DIR)           # project root (index.html, app.js, styles.css)
DATA_DIR       = os.path.join(BASE_DIR, "data")     # root/data/
BLOCKLIST_FILE = os.path.join(DATA_DIR, "merge_blocklist.json")
RESOLVE_SCRIPT = os.path.join(SRC_DIR, "resolve.py")  # src/resolve.py
GRAPH_SCRIPT   = os.path.join(SRC_DIR, "graph.py")    # src/graph.py
PYTHON         = sys.executable   # same interpreter that's running this server

app = Flask(__name__, static_folder=BASE_DIR)
def cleanup_blocklist():
    """Delete the blocklist file when the server shuts down."""
    if os.path.exists(BLOCKLIST_FILE):
        os.remove(BLOCKLIST_FILE)
        print("\n  Blocklist cleared on exit.")

# Register for normal exit (sys.exit, end of script)
atexit.register(cleanup_blocklist)

# Register for Ctrl+C and kill signals
signal.signal(signal.SIGINT,  lambda sig, frame: (cleanup_blocklist(), sys.exit(0)))
signal.signal(signal.SIGTERM, lambda sig, frame: (cleanup_blocklist(), sys.exit(0)))

CORS(app)   # allow requests from any origin (useful if you open index.html directly)

# ── Pipeline state ─────────────────────────────────────────
# Shared across threads — protected by a lock
_pipeline_lock   = threading.Lock()
_pipeline_status = {
    "state":    "idle",      # idle | running | done | error
    "step":     "",          # "resolve" | "graph" | ""
    "message":  "",
    "started":  None,
    "finished": None,
}

def _set_status(state, step="", message=""):
    with _pipeline_lock:
        _pipeline_status["state"]   = state
        _pipeline_status["step"]    = step
        _pipeline_status["message"] = message
        if state == "running":
            _pipeline_status["started"]  = datetime.utcnow().isoformat() + "Z"
            _pipeline_status["finished"] = None
        elif state in ("done", "error"):
            _pipeline_status["finished"] = datetime.utcnow().isoformat() + "Z"

def _run_pipeline(blocklist):
    try:
        # 1. Merge new undos with existing blocklist so previous undos survive
        os.makedirs(DATA_DIR, exist_ok=True)
        existing = []
        if os.path.exists(BLOCKLIST_FILE):
            with open(BLOCKLIST_FILE) as f:
                existing = json.load(f)

        # Deduplicate by (alias, canonical) pair
        seen = {(e["alias"], e["canonical"]) for e in existing}
        for entry in blocklist:
            pair = (entry["alias"], entry["canonical"])
            if pair not in seen:
                existing.append(entry)
                seen.add(pair)

        with open(BLOCKLIST_FILE, "w") as f:
            json.dump(existing, f, indent=2)

        # 2. Run resolve.py
        _set_status("running", "resolve", "Running resolve.py…")
        result = subprocess.run(
            [PYTHON, RESOLVE_SCRIPT],
            capture_output=True, text=True, cwd=BASE_DIR
        )
        if result.returncode != 0:
            _set_status("error", "resolve", result.stderr[-800:] or "resolve.py failed")
            return

        # 3. Run graph.py
        _set_status("running", "graph", "Running graph.py…")
        result = subprocess.run(
            [PYTHON, GRAPH_SCRIPT],
            capture_output=True, text=True, cwd=BASE_DIR
        )
        if result.returncode != 0:
            _set_status("error", "graph", result.stderr[-800:] or "graph.py failed")
            return

        _set_status("done", "", "Pipeline complete — graph rebuilt.")

    except Exception as e:
        _set_status("error", "", str(e))


# ── Static file routes ─────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")

@app.route("/<path:filename>")
def static_files(filename):
    # Serve JS, CSS, and anything else from the base directory
    return send_from_directory(BASE_DIR, filename)

@app.route("/data/<path:filename>")
def data_files(filename):
    return send_from_directory(DATA_DIR, filename)


# ── API routes ─────────────────────────────────────────────
@app.route("/api/rebuild", methods=["POST"])
def api_rebuild():
    """
    Body: { "blocklist": [{"alias": "...", "canonical": "..."}, ...] }
    Starts the pipeline in a background thread immediately.
    Returns 409 if pipeline is already running.
    """
    with _pipeline_lock:
        if _pipeline_status["state"] == "running":
            return jsonify({"error": "Pipeline already running"}), 409

    body = request.get_json(silent=True) or {}
    blocklist = body.get("blocklist", [])

    thread = threading.Thread(target=_run_pipeline, args=(blocklist,), daemon=True)
    thread.start()

    return jsonify({"status": "started", "blocklist_count": len(blocklist)}), 202


@app.route("/api/status", methods=["GET"])
def api_status():
    with _pipeline_lock:
        return jsonify(dict(_pipeline_status))


@app.route("/api/blocklist", methods=["GET"])
def api_get_blocklist():
    if not os.path.exists(BLOCKLIST_FILE):
        return jsonify([])
    with open(BLOCKLIST_FILE) as f:
        return jsonify(json.load(f))


@app.route("/api/blocklist", methods=["DELETE"])
def api_clear_blocklist():
    if os.path.exists(BLOCKLIST_FILE):
        os.remove(BLOCKLIST_FILE)
    return jsonify({"status": "cleared"})


# ── Boot ───────────────────────────────────────────────────
if __name__ == "__main__":
    os.makedirs(DATA_DIR, exist_ok=True)
    print("─" * 50)
    print(" Memory Graph Explorer")
    print("  http://localhost:5050")
    print("─" * 50)
    # Use threaded=True so the status polling doesn't block the pipeline thread
    app.run(host="0.0.0.0", port=5050, debug=False, threaded=True)