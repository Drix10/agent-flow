# R01 — intent hierarchy (explicit user instruction outranks guard defaults)

claim: When the user explicitly orders a flagged action, the guard must
yield through a logged override channel — not silently obey, not bluntly
refuse.
evidence: 01a1b7ed/06-VERDICTS.md E5 (U2/U4 main-line orders; agent chose
PR — worked by judgment, not by rule); 01a1ba9a missed (same shape, failed
open); d26fe691 fine-without (supervised force-push).
confidence: high | generality: universal
rework: new build item (override channel + audit). Scorecard item 4 input.
