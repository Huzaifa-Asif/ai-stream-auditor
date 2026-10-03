# Security policy

## Supported versions

Security fixes are provided for the latest major version.

## Reporting

Do not open a public issue for an undisclosed vulnerability. Use GitHub private vulnerability reporting. If unavailable, contact the maintainer through the address on the public GitHub profile with the affected version, reproduction, impact, and mitigation. Expect acknowledgement within seven days.

## Scope

This package processes caller-supplied JavaScript objects without executing provider content. It does not parse transports or enforce output safety. Reports intentionally omit raw payloads, but lifecycle keys and error/status metadata can still be sensitive; callers are responsible for log access and retention controls.
