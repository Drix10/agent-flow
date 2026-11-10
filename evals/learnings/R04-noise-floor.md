# R04 — gates must clear the noise floor

claim: No numeric guard threshold is valid unless it exceeds the
measured noise of its own sensor. A tolerance tighter than
measurement error fires on noise, not violations.
evidence: 110fe80e full-text (critic swings ±3 on the same frame;
±0.5 ratchet invalid; own-score comparison proposed).
confidence: high | generality: universal
rework: ship the variance measurement with every gate; own-delta,
not absolute margin.
