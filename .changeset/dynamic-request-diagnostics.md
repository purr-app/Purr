---
"@purr/core": minor
---

Make dynamic variables easier to debug with dependency chains, clear cycle and extraction errors, and source request execution history. Preserve HTTP error responses for extraction and inspection, and record manual variable executions without duplicating cache hits. Fix variable details leaking between workspaces, clipped editor tooltips, and cancellation after navigating between requests.

Highlight variable references throughout request editors and show auth templates without revealing literal credentials. Recommend encrypted variables for credentials. Export dynamic request chains as Bash scripts using curl and jq; disable formats that cannot represent a chain.
