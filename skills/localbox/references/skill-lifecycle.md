# Localbox skill lifecycle

The installed release owns the global Localbox skill. The CLI exposes
`skill.status`, `skill.install`, `skill.update`, and `skill.uninstall`; these
commands use the bundled `skills@1.7.0` installer and the bundled skill source.

Install and update stage a complete folder replacement. Existing global
destinations and the ownership receipt are backed up first, symlinks are copied
as symlinks, and verification must find `SKILL.md` at every discovered global
destination before the receipt is written. A failed operation restores the
backup and reports `needs_attention` with its path. Unmanaged skills are never
removed by uninstall.

The installer discovers supported agent harnesses through `skills ls --global
--json`; it does not maintain a second agent list. The release invokes
`skills add <bundled-source> --all --global --yes`, so a new supported harness
can be added by the pinned installer without changing Localbox's lifecycle code.

An app update refreshes a managed skill after the active release switches. The
six-hour updater also refreshes it when no app update is available. It does not
touch project-local skills.
