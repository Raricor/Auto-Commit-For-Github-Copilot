# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- GitHub Actions CI for type checks, regression tests, production builds on Node.js 20/22/24, and downloadable VSIX artifacts.

### Changed

- Separate AI intent grouping from commit-message generation, generating one group at a time with the selected model.
- Check input budgets before requests; analyze oversized groups through complete diff fragments and model summaries.
- Display completed candidates incrementally while keeping commit actions disabled during generation.

### Fixed

- Avoid retrying all staged diffs after provider failures; use local grouping only when the AI grouping output is invalid.
- Preserve staged files that have no candidate yet when committing results from a cancelled or partially failed generation.

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
