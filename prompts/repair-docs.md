---
description: Fix context claims flagged stale — re-verify against code, then refresh the manifest
---
Follow the `gardener` skill's /repair-docs procedure: for each flagged file, re-read the code, correct or remove the claim, align manifest references with the prose, and only then call `stale_repair`. Finish by re-running `stale_detect`; it must be healthy or you must say what remains. Focus: ${@:-all flagged files}.
