# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Order generated commits with one extra model request so that dependencies land first; the commit list animates into the new order and offers Undo.
- Handle very large changes (tested with 1,300 files): files are pre-grouped by folder, grouped batch by batch in parallel, then merged across folders when one intent spans several directories.
- Generate commit messages for different groups in parallel (`concurrency`, default 4).
- Optional commit count range (`minCommits` / `maxCommits`, default no limit).
- Thinking effort setting (`reasoningEffort`), sent with every request; empty follows the model's own setting.
- Placeholder cards for planned commits, progress for each stage, notices for repaired or fallback grouping, and a Retry button for a group that failed.
- Ask for confirmation before a run that needs more than 40 model requests.

### Changed

- Grouping evidence now uses the changed lines of each file (hunk headers and `+`/`-` lines) and divides the input budget among the files, instead of a fixed 1,200-character excerpt.
- Small mistakes in the grouping reply are repaired instead of discarding the whole AI grouping; local rules are used only after two unusable replies.
- Lockfiles and generated artifacts are described by their statistics only; their content is no longer sent.
- A single staged file no longer needs a grouping request.
- An unusable reply for one group is retried once and then reported for that group only; other groups continue.
- Large staged diffs (over 1 MB) are loaded into the file panel on demand.
- The File Changes panel shows a folder tree by default (a flat list is still available), with per-folder file counts and line statistics.
- File icons follow VS Code's default Seti icon theme, and panel controls use Codicons, so the panel looks like the Explorer and Source Control views. The icons are bundled because the extension cannot read the local icon theme in Remote SSH windows; see `THIRD_PARTY_NOTICES.md`.

### Fixed

- Commits now contain exactly the content that was staged when the messages were generated. Previously each file was re-added from the working tree, so unstaged edits in partially staged files were committed too.
- The staged state is restored when a commit fails partway, for example when a pre-commit hook rejects it.
- Refuse to commit when the staged changes differ from what the messages were generated for.
- Staged files were not recognized when `diff.mnemonicPrefix` or `diff.noprefix` was set, and paths containing ` b/` were parsed incorrectly.
- Code fences inside Markdown diffs no longer break the prompt, and the commit-history style rule no longer overrides the language and format settings.

## [0.4.0] - 2026-10-27

Changes from 0.3.1 to 0.4.0.

### Added

- GitHub Actions CI for type checks, regression tests, production builds on Node.js 20/22/24, and downloadable VSIX artifacts.

### Changed

- Group staged changes by intent using bounded file summaries before generating commit messages one group at a time with the selected model.
- Check input budgets before every request; split oversized groups into bounded diff fragments and combine model summaries so large changes can be analyzed with the same model, including DeepSeek.
- Display completed candidates incrementally while keeping commit actions disabled during generation.

### Fixed

- Avoid retrying all staged diffs after provider failures; use local grouping only when the AI grouping output is invalid.
- Preserve staged files that have no candidate yet when committing results from a cancelled or partially failed generation.
- Honor cancellation during token counting and response streaming, preventing further requests or candidate updates after cancellation.

## [0.3.1] - 2026-08-19

Changes from 0.3.0 to 0.3.1.

### Fixed

- Preserve both the original and destination paths when committing renamed files so the old path is removed instead of being left as an unstaged deletion.
- Validate `user.name` and `user.email` before changing the Git index, preventing failed commits from disturbing staged changes when the user identity is not configured.

## [0.3.0] - 2026-06-02

Changes from 0.2.0 to 0.3.0.

### Added

- Add a per-card `Commit this` action so an approved generated commit can be committed on its own while the remaining candidates stay available.
- Remember the selected Copilot model in extension settings and fall back to Auto when the saved model is no longer available.
- Disable generate, regenerate, and commit actions while a commit is in progress to avoid duplicate submissions.

### Changed

- Keep uncommitted commit candidates visible after a single-card or selected commit succeeds; only committed cards are removed.
- Open the Configuration panel expanded by default.
