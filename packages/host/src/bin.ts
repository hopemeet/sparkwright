#!/usr/bin/env node
// Sparkwright host CLI. See docs/HOST_PROTOCOL.md for the wire protocol.
import { runHostMain } from "./main.js";

void runHostMain(process.argv.slice(2));
