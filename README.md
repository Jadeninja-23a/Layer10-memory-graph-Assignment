# Enron Email Memory Graph Extraction

This project builds a structured memory graph from messy email conversations using the Enron Email Dataset. The goal is to extract entities and relationships from unstructured communication, ground them in evidence, clean duplicates, and make the resulting information explorable through a graph interface.

## Corpus Used
I used the Enron Email Dataset, which contains real corporate email threads with messy formatting, forwarded messages, quoted chains, and inconsistent metadata. These properties make it useful for testing extraction and deduplication systems.

The pipeline runs on a subset of the dataset, specifically Kenneth Lay’s mailbox:
`data/raw/subset/lay-k/`

This subset still includes common issues such as aliasing (e.g., “Ken” vs “Kenneth Lay”), repeated quotes from forwarded emails, and inconsistent timestamps.

## Structured Extraction
The extraction system converts raw emails into structured objects using a strict schema defined in `schema.py`.

### Schema Design
The main objects are:
* **Entity** – must be PERSON, PROJECT, or ORGANIZATION
* **Relationship** – connects two entities with an action
* **Evidence** – the grounding for each claim

Every extracted relationship must include evidence with:
* exact quote from the email
* message ID
* timestamp
* approximate location in the email

### Extraction Pipeline
There are two extraction modes:

**Cloud Extraction (`extract.py`)**
* Uses Groq API (`llama-3.3-70b-versatile`)
* Handles large batches quickly
* Truncates long emails to avoid context overflow

**Local Extraction (`llama_extract.py`)**
* Runs locally with Ollama (`llama3.1`)
* Used as a fallback for privacy or API limits
* Includes a 60-second timeout safety rail using `ThreadPoolExecutor` so local models cannot hang indefinitely

Both scripts truncate the email body to prevent long context issues.

### Validation
The system uses the `instructor` library + Pydantic to force the model to output valid structured JSON. This prevents malformed outputs and ensures all fields are present. Each extraction also includes metadata such as schema version and model used.

## Deduplication and Canonicalization
The raw extractions are cleaned using `resolve.py`.

* **Artifact Deduplication**: Forwarded emails often repeat the same content multiple times. Duplicate evidence is detected by matching identical quotes.
* **Entity Canonicalization**: Aliases like "Ken", "Kenneth", and "Kenneth Lay" are merged using fuzzy matching and substring rules.
* **Ghost Entity Filtering**: Entities that never participate in any relationship are removed to reduce noise.
* **Claim Deduplication**: Repeated claims are merged into a single edge while tracking how many independent pieces of evidence support it.
* **Reversible Merges**: All merge decisions are logged. If a merge is incorrect, it can be undone through a blocklist that prevents the same merge from happening again.

## Memory Graph Design
The cleaned data is converted into a graph using `graph.py`.

The graph contains:
* **Nodes** – entities with aliases and connection counts
* **Edges** – relationships between entities
* **Evidence** – supporting quotes for each claim
* **Merge logs** – audit trail of canonicalization decisions

Time information from email headers is used to track when claims were first and last observed. The backend server (`server.py`) rebuilds the graph automatically when merges are undone.

## Retrieval and Grounding
The interface supports searching across:
* entities
* relationships
* evidence quotes
* merge logs

Each claim displayed in the system links directly to its supporting evidence, including the exact quote and source email. 

To avoid confusion after entity merges, the system stores the original raw names used in the email so the UI can show exactly what was written.

## Visualization
The project includes a lightweight web UI.

Features include:
* Interactive graph view showing entities and relationships
* Evidence panel displaying the quotes supporting a claim
* Merge inspector showing which aliases were merged and why, complete with a UI to **unmerge and rebuild** the dataset

The graph is rendered using native SVG in the browser, allowing filtering by entity type, relation type, and time.  