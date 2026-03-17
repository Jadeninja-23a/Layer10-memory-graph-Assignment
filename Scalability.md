# Layer10 Considerations

The system I built was tested on a static dataset (Enron emails). In a real enterprise environment the system would need to support multiple sources such as email, Slack/Teams chats, documents, and structured systems like Jira or Linear. This mainly requires changes in the schema, extraction flow, memory lifecycle, and update strategy.

---

## Unstructured + Structured Fusion

In the Enron dataset everything came from email text, but in a real environment there would be both **unstructured communication** (Slack, email, documents) and **structured artifacts** (tickets, pull requests, components).

To support this, the schema would be extended with entity types such as:

- `Ticket`
- `Document`
- `Component`
- `Project`

An initial **classification prompt** can determine the type of incoming data (chat, ticket, email, document). Based on this type, the system can apply a schema and extraction prompt tailored for that data source.

Structured systems like Jira provide reliable relationships (for example `User -> assigned_to -> Ticket`), while unstructured sources mainly provide context such as discussions, blockers, or decisions.

---

## Long-Term Memory

Some information may appear rarely but still be important. Because of this, the system should not rely only on frequency when deciding what to store.

Claims can be **tagged as long-term memory** when they come from authoritative sources or are manually marked as important. Temporary discussions or short-lived context remain **ephemeral**.

This allows the system to preserve important facts while letting less relevant context fade over time.

---

## Grounding & Safety

Every claim is grounded using:

- exact quote
- source ID
- timestamp

This requirement remains strict in a production environment.

The system should also maintain **backups of extracted evidence**, especially for important claims. If a source message or document is deleted, the corresponding evidence is removed. If a claim no longer has supporting evidence, the relationship is removed from the graph.

---

## Permissions

Access control can be implemented by attaching **permission metadata** to nodes and relationships.

When a user queries the graph, results only include nodes and edges that the user has permission to access based on the original source system.

---

## Operational Reality

In production the graph should **not be rebuilt from scratch** for every update. Instead the system should support **incremental ingestion**.

New emails, Slack messages, or ticket updates trigger extraction only for those items.

Operations like **undoing a merge** should update only the affected parts of the graph. Graph algorithms can locate the nodes and edges involved, restore previously merged nodes, and update relationships without regenerating the entire graph.

To control cost, simpler extraction tasks can run on smaller or local models, while more complex reasoning tasks can use larger models. Known merges and blocked merges can also act as regression tests to ensure new extraction versions do not break the existing memory structure.