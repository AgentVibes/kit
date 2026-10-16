---
"@agentvibes/kit": minor
---

`warnDegraded` and `warnNotImplemented` now dedup per category and detail, not per category alone: the same category with a different detail reports again. A caller that passed a varying detail under one category now sees one event per distinct detail.
