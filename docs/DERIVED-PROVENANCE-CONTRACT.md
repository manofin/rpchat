# Derived provenance: B1 clarification

Status: F1 choice adopted by the user on 2026-10-27: preserve current behavior and correct the report.
Scope: the imported provenance implementation; not a migration or production-data approval.

For summarize/rollup, recheck the direct model inputs after the model returns.
A changed head, direct source content/provenance, revoked approval, or changed effective input audience blocks storage.
This is not a promise to reject every metadata change in every transitive ancestor.
If an ancestor audience widens while the input summary's recorded ceiling keeps its effective audience unchanged,
rollup can finish; the new episode retains that private scope and cannot enter a public prompt.
If the effective audience narrows, reject with 409, create no episode, and leave rolled_up_into unchanged.

Evidence: bench/derivedProvenanceRollupAudience.test.ts asserts both branches and positive private reuse after approval.
The source RESULT.txt is historical evidence and is not rewritten by this import.

Hardening coverage: bench/derivedProvenanceHardening.test.ts adds the 12 previously surviving mutation witnesses.
M14/M15 are deliberately corrupted receipts, not states produced by the current normal writer.
M20 protects explicit reserved-memory exclusion; it does not report an existing leak in the unmutated code.
The legacy source=user shortcut in this imported baseline is not beatlog B0 approval policy.
B2/B3 must enforce the adopted field-level approval and full input provenance contracts before using it.

No live migration, model call, service start, commit, push, or merge is authorized by this document.
