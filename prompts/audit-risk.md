---
description: Find new risk surfaces (dependencies, auth, payments, destructive data ops, outbound calls, secrets) since the baseline
---
Follow the `gardener` skill's /audit-risk procedure: call `risk_audit`, group new surfaces by type, propose protected_paths / risk_boundaries updates, and call `risk_baseline_update` with only the keys I accept. Secrets are never accepted — tell me to remove and rotate them.
