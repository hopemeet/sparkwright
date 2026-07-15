# Package Script Expansion Unsupported Claim

## Symptom

After a successful `npm test`, final prose reported
``npm test` → `node --test` → confirmed working`` and Core classified
`node --test` as an unsupported independent success claim.

## Root Cause And Fix

Claim extraction discarded the same-line relationship between quoted commands.
It now retains an arrow-derived parent and accepts the child only when the
parent is a successful npm/pnpm/yarn script invocation. Semicolon-separated,
unrelated, and non-package command claims remain unsupported.

## Regression Evidence

Core outcome tests cover the valid expansion and a non-laundering countercase.
Recomputing real run `run_mrlkn4drt7xw93bd` now yields no completed-run issue.
