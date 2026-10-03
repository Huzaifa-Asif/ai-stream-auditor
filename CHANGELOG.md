# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-03

### Added

- Bounded incremental audit state machine for OpenAI Responses and Anthropic Messages events.
- Separate protocol-completion, semantic-success, and outcome reporting.
- Lifecycle checks for terminals, content units, deltas, provider status, sequence numbers, and stop reasons.
- Forward-compatible unknown-event warnings without raw event retention.
