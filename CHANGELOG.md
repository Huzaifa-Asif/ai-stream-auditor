# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.1] - 2026-10-05

### Fixed

- Preserve structural error state independently of bounded diagnostic storage, so warning saturation cannot turn malformed streams into successful reports.
- Reject OpenAI content-part starts, deltas, and stops without an open parent output item.

## [1.0.0] - 2026-10-03

### Added

- Bounded incremental audit state machine for OpenAI Responses and Anthropic Messages events.
- Separate protocol-completion, semantic-success, and outcome reporting.
- Lifecycle checks for terminals, content units, deltas, provider status, sequence numbers, and stop reasons.
- Forward-compatible unknown-event warnings without raw event retention.
