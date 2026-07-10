# Failure Patterns

Failure patterns are reusable diagnostic notes. They explain how a class of
failure looks, why it happened, and what a maintainer should check before
changing code or tests.

Use this directory together with [../runs/](../runs/) and
[../coverage/](../coverage/):

- run notes record individual stochastic or exploratory sessions
- failure patterns aggregate repeated lessons and counts
- coverage pages summarize confidence changes after failures are understood

## Count Policy

Counts are diagnostic, not vanity metrics. Increment a count only when a run or
test failure matches the pattern closely enough that the same diagnostic move
would have found it.

Keep counts by cause bucket using the vocabulary in
[../README.md](../README.md#failure-cause-vocabulary). If the cause is not
known, increment `unknown` and revisit it after diagnosis.

## Index

See [index.md](index.md).
