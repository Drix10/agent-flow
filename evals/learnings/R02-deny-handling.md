# R02 — deny handling per action class (halt vs reroute)

claim: Destructive-class denies halt, report, and defer to the human
(P07). Recoverable-class denies may reroute via explicit alternates —
but the alternates must be enumerated by policy, not invented (the native
"reasonable workaround" license is too broad: it permitted everything here).
evidence: 6666fa97 yt-dlp halt (worked) vs a8c1e208 sudo ask-first (worked)
vs native blanket workaround license (too permissive) vs c3c44745
blocked-edit→full-rewrite (benign here, must count as edit).
confidence: medium | generality: universal
rework: deny policy table per rule (halt / reroute-with-enumerated-
alternates); rewrite-counts-as-edit narrowing.

Structural gap (deep pass): Oct 21 credential incident — live payment +
OAuth secrets entered via chat paste with zero audit trace in any of 7 logs,
while the secret rule fires only on tool-side reads. Guard the door secrets
actually use (paste-into-chat), not just read-of-file.
