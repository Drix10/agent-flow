---
description: Audit the whole repo for over-engineering — ranked list of what to delete, reuse or replace with the standard library or platform; report only
---
Follow the `gardener` skill's /audit-lean procedure over the whole tree: one ranked line per finding (`delete`, `stdlib`, `native`, `reuse`, `yagni`, `shrink`), grep for a symbol before calling it deletable, never touch validation, error handling, security, accessibility or the small runnable checks, and end with `net: -N lines, -M dependencies possible.` Apply nothing.
