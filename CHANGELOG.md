# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.3] - 2026-10-19

### Added

- Exercise credential-free truncated and complete streams from the official
  Anthropic TypeScript SDK against the auditor on the SDK's supported Node
  runtimes, while preserving a dependency-free Node 18 core check.
- Ship and execute a runnable Anthropic Messages lifecycle example.
- Include the security, contribution, and conduct policies in the package
  tarball.

## [1.0.2] - 2026-10-10

### Added

- Ship the runnable OpenAI Responses lifecycle example in the npm tarball.
- Execute the example as part of the aggregate package check.
- Document how lifecycle auditing composes with async-iterator deadlines.

## [1.0.1] - 2026-10-06

### Fixed

- Preserve structural error state independently of bounded diagnostic storage, so warning saturation cannot turn malformed streams into successful reports.
- Reject OpenAI content-part starts, deltas, and stops without an open parent output item.

## [1.0.0] - 2026-10-03

### Added

- Bounded incremental audit state machine for OpenAI Responses and Anthropic Messages events.
- Separate protocol-completion, semantic-success, and outcome reporting.
- Lifecycle checks for terminals, content units, deltas, provider status, sequence numbers, and stop reasons.
- Forward-compatible unknown-event warnings without raw event retention.
