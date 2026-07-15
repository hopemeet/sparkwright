# TUI Narrow Status Bar Wrap

## Symptom

At 80 columns, the compact StatusBar put terminal reason, usage, task notice,
model, and permission in one flex row. Ink wrapped fragments such as
`done/final_answer`, model name, and `read-only` onto unrelated rows.

## Root Cause And Fix

Compact mode shortened only the model label but retained the wide one-row
layout. It now owns a deliberate status/identity row plus a task/workflow row;
the separate usage line remains the compact token source.

## Regression Evidence

The 80-column render test asserts stable status, identity, and task rows and no
duplicate compact token/reason fields. Real PTY capture confirms the layout.
