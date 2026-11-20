# Auto Commit For GitHub Copilot

A VS Code extension that automatically generates intelligent git commit messages from your staged changes using GitHub Copilot.

## Features

- **AI-Powered Commit Messages** — Leverages GitHub Copilot (via `vscode.lm` API) to analyze your staged diff and generate meaningful commit messages
- **AI-Driven File Grouping** — The selected model first groups the staged files by *intent*, then generates a commit message for each group. Small mistakes in the grouping reply (a missed file, a `./` prefix, a duplicate) are repaired instead of discarding the whole result
- **Very Large Changes** — Changes with more than 100 files (tested with 1,300) are pre-grouped by folder, grouped batch by batch, and merged across folders when the same intent spans several directories
- **Parallel Generation** — Commit messages for different groups are generated concurrently (4 requests at a time by default)
- **AI Commit Ordering** — After all messages are ready, the model orders the commits so that dependencies land first; the list animates into the new order and can be undone
- **Commit Count Range** — Optionally limit how many commits are generated (minimum and/or maximum)
- **Thinking Effort** — Choose the reasoning effort sent with each request, or follow the model's own setting
- **Exact Staged Content** — Each commit contains exactly what was staged when the messages were generated, including partially staged files (`git add -p`); unstaged edits never leak into a commit
- **Large Change Support** — Checks the selected model's input budget before sending requests. Oversized groups are split into diff fragments, analyzed by the same model, and summarized into one commit message per group. Lockfiles and generated files are summarized by their statistics only
- **One Feature Per Commit** — The grouping prompt enforces atomic commits: feature work, unrelated refactors, docs, config and dependency bumps are split into separate commits automatically
- **Conventional Commits Support** — Optionally enforces `feat/fix/docs/style/refactor/test/chore/ci/build` prefixes
- **Multi-Language** — Generate commit messages in English, Chinese, or auto-detect from your git log history
- **Model Selection** — Choose from all GitHub Copilot models available in your VS Code instance
- **Custom Prompt** — Append your own instructions to guide the generated output
- **Real-Time Streaming** — A placeholder card appears for every planned commit and fills in as its message is generated. A group that fails shows an error card with a **Retry** button instead of stopping the whole run
- **Inline Editing** — Edit any generated commit message before committing
- **Drag to Reorder** — Drag commit candidates to control execution order
- **Selective Commit** — Check or uncheck individual candidates; only selected commits are executed
- **File Tree** — Staged files are shown as a folder tree (or a flat list) with per-folder file counts and line statistics, using VS Code's Seti file icons and Codicons. Folders with a single subfolder are compacted, like in the Explorer
- **Diff Viewer** — Inspect a full line-by-line diff for each staged file directly in the panel
- **Style Matching** — References your recent commit history to maintain a consistent tone

## Installation

You can install the extension either from a pre-built `.vsix` release or by
building it yourself from source.

### Option A — Install a pre-built `.vsix`

1. Download the latest `autocommit-for-github-copilot-<version>.vsix` from the
   project's [Releases](https://github.com/winterYANGWT/Auto-Commit-For-Github-Copilot/releases) page.
2. In VS Code, open the **Extensions** view (`Ctrl+Shift+X`), click the `…`
   menu in the top-right corner, choose **Install from VSIX…**, and select
   the downloaded file.

   Alternatively, from a terminal:

   ```bash
   code --install-extension autocommit-for-github-copilot-1.0.0.vsix
   ```

### Option B — Build from source

Requires **Node.js 20+** and **npm** for development; VSIX packaging requires
**Node.js 22+** (CI uses Node.js 24).

```bash
# 1. Clone the repository
git clone https://github.com/winterYANGWT/Auto-Commit-For-Github-Copilot.git
cd Auto-Commit-For-Github-Copilot

# 2. Install dependencies
npm ci

# 3. Check types and run tests
npm run typecheck
npm test

# 4. Compile and package into a .vsix using the pinned vsce CLI
npm run package

# 5. Install the resulting .vsix into VS Code
code --install-extension autocommit-for-github-copilot.vsix
```

After installation, reload VS Code if prompted. You should see a
**✨ AutoCommit** entry in the status bar and a sparkle icon in the Source
Control panel title bar.

> Tip: for development you can also press `F5` in this repo to launch a new
> **Extension Development Host** window with the extension loaded — no
> packaging required.

## Continuous Integration

The [CI workflow](.github/workflows/ci.yml) runs on pushes, pull requests, and manual
dispatches. On Node.js 20, 22, and 24 it installs locked dependencies, type-checks
both the extension and React webview, runs the regression tests, and builds the
production extension.

After all checks pass, a Node.js 24 job builds the VSIX and uploads it as
`autocommit-for-github-copilot-vsix`, retained for 14 days. Download it from the
workflow run's **Artifacts** section and install the contained `.vsix` in VS Code.
Tests use a simulated model boundary and need no Copilot login or DeepSeek API key.

## Requirements

- VS Code **1.90.0** or later
- The built-in **Git** extension must be enabled
- An active **GitHub Copilot** subscription with the VS Code extension installed and signed in

## Getting Started

1. Stage the files you want to commit with `git add` (or via the VS Code Source Control panel)
2. Open the AutoCommit panel using any of the following:
   - Click the **✨ AutoCommit** item in the status bar
   - Click the **sparkle (✨)** icon in the Source Control panel title bar
   - Run the command **AutoCommit: Generate Commits** from the Command Palette (`Ctrl+Shift+P`)
3. Wait for commit candidates to stream in
4. Review, edit, reorder, or deselect candidates as needed
5. Click **Commit Selected** to execute the commits in order

## Extension Settings

| Setting                                             | Type                     | Default | Description                                                                      |
| --------------------------------------------------- | ------------------------ | ------- | -------------------------------------------------------------------------------- |
| `autocommit-for-github-copilot.conventionalCommits` | `boolean`                | `true`  | Use Conventional Commits style (`feat/fix/docs/…`)                               |
| `autocommit-for-github-copilot.language`            | `"en" \| "zh" \| "auto"` | `"en"`  | Language for generated commit messages. `auto` detects from your git log history |
| `autocommit-for-github-copilot.model`               | `string`                 | `""`    | Preferred Copilot language model. Empty means Auto                               |
| `autocommit-for-github-copilot.minCommits`          | `number` (0–200)         | `0`     | Fewest commits to generate. `0` means no limit                                   |
| `autocommit-for-github-copilot.maxCommits`          | `number` (0–200)         | `0`     | Most commits to generate. `0` means no limit                                     |
| `autocommit-for-github-copilot.reasoningEffort`     | `"" \| "none" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | `""` | Thinking effort sent with each request. Empty follows the effort configured for the model in VS Code |
| `autocommit-for-github-copilot.concurrency`         | `number` (1–8)           | `4`     | Most model requests in flight at once                                            |

Settings can also be changed at any time from the **Configuration** panel inside the AutoCommit webview.

**About thinking effort:** VS Code does not tell extensions which effort levels a
model supports, so the panel offers a fixed list. The selected level is sent with
every request; GitHub Copilot models and providers such as DeepSeek ignore levels
the model does not support and use that model's default instead.

## How It Works

```
Staged Changes (git diff --cached)            ── index snapshot recorded (git write-tree)
        │
        ▼
  Parse per-file diffs
        │
        ▼
  Grouping by INTENT
   ─ 1 file: no request
   ─ up to 100 files: one request with per-file diff evidence
   ─ more files: folder batches grouped in parallel, then one merge request
   ─ replies are repaired; local rules only after two invalid replies
   ─ optional commit count range is enforced
        │
        ▼  (confirmation first if more than 40 requests are expected)
  Generate one message + reason per group, in parallel
   ─ full group diff when it fits the input budget
   ─ otherwise: analyze all diff fragments, then combine model summaries
   ─ a failed group becomes a retryable card; other groups continue
        │
        ▼
  AI commit ordering (dependencies first)
        │
        ▼
  CommitCandidates  ──►  Webview Panel (React)
                          Review / Edit / Reorder / Retry
        │
        ▼
  git commit (per candidate, in order, from the index snapshot)
```

### Grouping Strategy

The model is instructed to follow one golden rule: **each commit must
represent exactly one feature, fix, refactor, or chore.** Files only share
a group when they jointly implement that single intent (e.g. a feature's
source file together with its own tests). Unrelated changes — even within
the same directory — are split into separate commits.

Small mistakes in the model's reply are repaired: paths are normalized, unknown
paths and duplicates are dropped, and files the model missed are grouped by the
rules below (you see a notice when this happens). Only when the reply is unusable
twice, or misses more than half of the files twice, does the whole change fall back
to the deterministic rule-based grouping:

| Group    | Matched Files                                                                |
| -------- | ---------------------------------------------------------------------------- |
| `deps`   | `package.json`, `*.lock`, `requirements.txt`, `Cargo.toml`, `poetry.lock`, … |
| `test`   | `*.test.ts`, `__tests__/`, `test/`, `e2e/`, …                                |
| `config` | `*.config.*`, `.env*`, `*.yaml`, `tsconfig.*`, `.eslintrc`, …                |
| `docs`   | `*.md`, `docs/` directory                                                    |
| `source` | All other source files, sub-grouped by top-level directory                   |
| `misc`   | Root-level files that don't fit any other group                              |

Grouping uses paths, change statistics, and the changed lines of each file
(hunk headers and `+`/`-` lines; context lines are left out). The input budget is
divided among the files, up to 6,000 characters each. After groups are fixed,
generation analyzes the full diff for each group. A group that
does not fit in one request is split into bounded requests to the **same selected
model**, including DeepSeek models exposed through `vscode.lm`. Every diff fragment
is analyzed before the model combines its summaries into a commit message.

Lockfiles and generated artifacts (`package-lock.json`, `yarn.lock`,
`pnpm-lock.yaml`, `Cargo.lock`, `poetry.lock`, `go.sum`, `*.min.js`, `*.min.css`,
`*.map`, `*.snap`, `__snapshots__/`, …) are described to the model by their line
statistics only; their content is never sent.

Each request is checked with the model's token counter and uses at most 80% of its
advertised input capacity, plus a conservative character limit. The grouping request
also has a 64,000-token cap.

If the model's reply for one group cannot be used, that group is retried once and
then shown as a failed card with a **Retry** button; the other groups continue.
A provider error (for example a quota or network error) stops all requests at once,
keeps the commits already generated, and marks the unfinished groups as failed so
they can be retried individually. Commit actions become available after generation
stops.

### Very Large Changes

With more than 100 staged files, the files are first pre-grouped by folder into
batches of at most 60 files. Files that share a name in the same folder
(`foo.ts`, `foo.test.ts`, `foo.css`) stay in the same batch. Each batch is grouped
by intent in parallel, then one merge request joins groups from different folders
that implement the same intent (for example a feature and its tests under `tests/`).
For a 1,300-file change this is typically 25–35 grouping requests, depending on
the folder layout, plus one merge request.

Before sending many requests, the extension asks for confirmation: once before
folder-batch grouping if it needs more than 40 requests, and once before generation
if that needs more than 40. Additional requests can consume more of your Copilot
premium request quota.

### Commit Count Range

`minCommits` and `maxCommits` are passed to the grouping (or merge) request. If the
model's grouping falls outside the range, it is asked once more with feedback; if it
still does not comply, groups are merged by shared folder or split by sub-folder
until the count fits, and a notice tells you so. The minimum can never exceed the
number of staged files.

### Commit Order

When at least two commits were generated, one more request asks the model to order
them: dependency and build changes, and refactors or utilities that later commits
use, come first; documentation follows its feature; unrelated commits keep their
original order. The list animates into the new order and offers **Undo**. If the
ordering request fails, the generated order is kept.

### How Commits Are Made

When generation starts, the extension records the staged content with
`git write-tree`. Committing takes each candidate's files from that snapshot, not
from the working tree, so partially staged files are committed exactly as staged
and unstaged edits stay in your working tree. Afterwards the index is restored to
the snapshot, so anything not committed remains staged exactly as before — also
when a commit fails partway (for example because a pre-commit hook rejects it).
If you change the staged files after generating, committing is refused until you
generate again.

## Commands

| Command                        | Description                                                                 |
| ------------------------------ | --------------------------------------------------------------------------- |
| `AutoCommit: Generate Commits` | Open the AutoCommit panel and generate commit candidates for staged changes |

## Known Limitations

- Requires an active internet connection and a valid GitHub Copilot subscription
- Grouping excerpts and model-generated summaries can miss semantic relationships; review the proposed groups and messages before committing
- Token counts can be approximate for third-party model providers; the input budget includes a safety margin
- If a single file's path and the instructions alone exceed the input budget, generation reports an error asking for shorter instructions
- Grouping works at file granularity: one file with two unrelated changes cannot be split into two commits
- Thinking effort levels are not validated per model; unsupported levels are ignored by the provider
- The extension only processes **staged** changes (`git add` first)

## License

[GPL-3.0](LICENSE)
