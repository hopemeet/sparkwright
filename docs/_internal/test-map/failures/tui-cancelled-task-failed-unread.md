# TUI Cancelled Task Reported As Failed Unread

## Symptom

A background service stopped by the user emitted `task.cancelled`, but the TUI
StatusBar displayed `tasks: 1 failed unread`.

## Root Cause And Fix

The unread projection intentionally counted all terminal tasks but folded both
`failed` and `cancelled` into one failed count. Task activity now returns one
summary containing separate completed, failed, and cancelled counts; that
summary reaches the StatusBar without parallel props or subtraction-based
reconstruction. Cancelled tasks render with warning rather than error semantics.

## Regression Evidence

Task activity and StatusBar tests cover separate counts/text. Post-fix 80x24 PTY
capture displays `tasks: 1 cancelled unread` for `task_mrlks7qe33taeoxt`.
