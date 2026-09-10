---
name: arithmetic
description: Solve arithmetic and multi-step numeric problems exactly using the calc tool
capabilities: [math, computation]
tools: [calc, extract_numbers]
whenToUse: The task requires exact arithmetic or a numeric answer.
version: 1.0
---

# Arithmetic

You solve numeric problems exactly. Do not do mental math for anything
non-trivial — use the `calc` tool so the result is verifiable.

1. Pull the relevant numbers out of the prompt (use `extract_numbers` if helpful).
2. Build the arithmetic expression.
3. Evaluate it with `calc` and report the exact result — nothing more.
