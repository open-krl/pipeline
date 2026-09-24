# Git Pre-Commit Automation: Lefthook & Biome Architecture Guide

This document outlines the operational models, failure semantics, and configuration patterns for managing Git pre-commit hooks using **Lefthook** and **Biome**.

---

## 1. Core Mechanics: Lefthook & Git Index Isolation

When you run `git commit`, Lefthook orchestrates checks before Git constructs the commit object.

### The Stashing Cycle
Git pre-commit hooks are intended to validate **only the files staged in Git's index (`.git/index`)**, not the uncommitted edits sitting in your working directory.

1. **Stash Unstaged Edits:** Lefthook automatically stashes any unstaged working directory changes before running your hook jobs.
2. **Execute Hook Pipeline:** The jobs run against the clean staged index.
3. **Pop Stash:** Once the jobs finish (or fail), Lefthook restores the stashed unstaged changes back to your working directory.

### The Partial Staging Trap
If you stage part of a file (e.g. lines 1–10) but have unstaged edits in the same file (e.g. lines 11–20):
* When `git commit` runs, your editor may flicker as lines 11–20 temporarily disappear (because Lefthook stashed them).
* If a pre-commit job modifies lines 1–10 and a subsequent job fails, Git aborts the commit. When Lefthook pops your unstaged edits back, Git attempts a three-way merge. If line numbers or offsets shifted during auto-fixing, you may hit a **stash merge conflict**.

---

## 2. What `stage_fixed: true` Actually Does

`stage_fixed` is often misunderstood as a "transactional lock" or "all-or-nothing rollback" mechanism. It is not.

### The Problem It Solves
1. A developer stages `src/app.ts` (`git add src/app.ts`) and commits.
2. A hook command runs `biome check --write src/app.ts`.
3. Biome re-formats or auto-fixes the file on disk in the **working directory**.
4. **Git's fundamental behavior:** Modifying a file on disk **does not** update Git's staging index (`.git/index`).
5. Without intervention, Git would commit the **old, unformatted** staged version, leaving the formatted changes behind in the worktree as unstaged modifications immediately after committing!

### The Solution
`stage_fixed: true` tells Lefthook:  
> *"If this job modified any files on disk, automatically run `git add` on them so the fixes are included in the staged commit."*

### Why Git Hooks Are Not Transactions
Git hooks are standard shell processes. There is no ACID transaction engine or rollback log underneath:
* When a command writes to disk (`biome check --write`) or runs `git add`, those changes are immediately written to disk and index.
* If a later job (like `typecheck`) fails, Git simply exits non-zero (`exit 1`) and refuses to advance the branch pointer.
* **Git does not rewind file edits made by earlier jobs.** The auto-fixed changes remain staged. You simply address the reported error (e.g. fix the type error) and commit again.

---

## 3. The Two Paradigms

Depending on team preference and workflow constraints, there are two distinct paradigms for configuring Lefthook with Biome:

### Paradigm A: Auto-Fix First, Then Verify (Mutating Hook)
*Use when convenience is preferred, and developers want the toolchain to silently format and apply safe lint fixes without having to manually run check commands.*

#### Execution Invariant
Any mutating step (`--write` + `stage_fixed: true`) **must run first**. All subsequent verification steps (typecheck, integration smoke checks) then evaluate the final, formatted code.

#### Configuration (`lefthook.yml`)
```yaml
pre-commit:
  parallel: false
  piped: true
  jobs:
    # 1. Mutate & re-stage first
    - name: auto-fix
      glob: "*.{js,ts,cjs,mjs,jsx,tsx,json,jsonc,css,graphql}"
      exclude: "(^data/|^tests/fixtures/)"
      run: bun run check --write {staged_files}
      stage_fixed: true

    # 2. Verify types on the final formatted code
    - name: typecheck
      run: bun run typecheck
```

* **Pros:** Zero friction. If you forget to format, the hook fixes and stages it for you.
* **Cons:** Hook mutates files during commit. If you partially staged a file and `typecheck` fails, popping the stash can lead to merge conflicts.

---

### Paradigm B: Fail-Fast / Pure Verification (Read-Only Hook)
*Use when strict determinism and safety against stash conflicts are preferred, especially in teams that heavily rely on `git add -p` (patch-based partial staging).*

#### Execution Invariant
The hook is strictly **read-only**. It never writes to disk, never runs `--write`, and never stages files. If code is unformatted or violates lint rules, it immediately fails and tells the developer to fix it.

#### Configuration (`lefthook.yml`)
```yaml
pre-commit:
  parallel: false
  piped: true
  jobs:
    - name: typecheck
      run: bun run typecheck

    - name: check
      glob: "*.{js,ts,cjs,mjs,jsx,tsx,json,jsonc,css,graphql}"
      exclude: "(^data/|^tests/fixtures/)"
      run: bun run check {staged_files}
```

* **Pros:** 100% deterministic. No file mutations during commit, no Git index modifications, and zero stash merge conflicts.
* **Cons:** Requires running `bun run check --write` manually if formatting was missed before committing.

---

## 4. Anti-Pattern: The Execution Order Deadlock

A common mistake when setting up Lefthook with Biome is the **"Dead-on-Arrival" Formatter** anti-pattern.

### The Flawed Configuration
```yaml
pre-commit:
  parallel: false
  piped: true
  jobs:
    - name: typecheck
      run: bun run typecheck

    - name: lint
      glob: "*.{js,ts,cjs,mjs,jsx,tsx,json,jsonc,css,graphql}"
      exclude: "(^data/|^tests/fixtures/)"
      run: bun run check                      # ⚠️ Checks BOTH linting AND formatting!

    - name: format
      glob: "*.{js,ts,cjs,mjs,jsx,tsx,json,jsonc,css,graphql}"
      exclude: "(^data/|^tests/fixtures/)"
      run: bun run format {staged_files}
      stage_fixed: true                       # 💀 NEVER REACHED
```

### Why `stage_fixed: true` Never Ran

1. **Semantic Collision (`check` vs `lint`):**  
   In Biome, `biome check` checks both lint rules **and** code formatting. Naming the job `lint` while executing `bun run check` meant the job was secretly enforcing formatting.
2. **Piped Abort Before Formatting:**  
   Because `piped: true` halts the pipeline on the first failing job, the moment an unformatted file was staged, Job 2 detected the formatting violation and exited with status code `1`.
3. **The Deadlock:**  
   Job 3 (`format` with `stage_fixed: true`) was never reached. The formatter never got the opportunity to reformat the file, and Lefthook never got the opportunity to auto-stage it.
4. **The Baffling User Experience:**  
   - Developer runs `git commit`.
   - Lefthook stashes unstaged fixes (file flickers back to unformatted 1-liner).
   - Job 2 crashes on formatting.
   - Lefthook aborts commit and pops the stash (file flickers back to formatted 2-liner).
   - Developer is left wondering why their commit failed on formatting when the file in their editor appears already formatted, and why `stage_fixed: true` didn't fix it.

