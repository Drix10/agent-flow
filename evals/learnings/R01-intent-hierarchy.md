# R01 — intent hierarchy (explicit user instruction outranks guard defaults)

claim: When the user explicitly orders a flagged action, the guard must
yield through a logged override channel — not silently obey, not bluntly
refuse.
evidence: 01a1b7ed/06-VERDICTS.md E5 (U2/U4 main-line orders; agent chose
PR — worked by judgment, not by rule); 01a1ba9a missed (same shape, failed
open); d26fe691 fine-without (supervised force-push).
confidence: high | generality: universal
rework: new build item (override channel + audit). Scorecard item 4 input.

Grounded exhibits (deep pass): 6666fa97 msg#4717-4721 — tracekit refused the
agent, agent briefed hazards, user ran the force-push in their own terminal
(the ultimate override channel: the user's own hands); 01a1ba9a U19-U23 —
user disabled the guard, then ordered main push (BYPASS: removal itself must
go through the channel, logged + scoped).
