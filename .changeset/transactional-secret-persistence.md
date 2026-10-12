---
"@purr/core": minor
---

Prepare credential changes without modifying the vault, and commit them together with project and local-state changes. Failed saves preserve existing credentials; interrupted commits recover safely, and acknowledged operations can be reconciled without applying them twice.

Add versioned credential reads and transactional batches to storage adapters. Imports, execution history and integration settings use the same publication boundary.
