# Slice 14 critique (unprimed agent)

One fresh agent got only the PNGs from the first render: every state light and dark, 2x Account crops, Bento's
manual-updates shots and the About and General side-by-sides. It got no history and no expected answer. Its findings,
shortened:

1. Signed-out: the `you@example.com` prompt read as an entered value (full-strength, right-aligned, no field border). High.
2. Code sent: the `123456` prompt read as an entered code, and an entered code showed bold. High.
3. Signed in: the footer still said "Signing in connects this Mac…". Medium-high.
4. Send Code, Sign Out… and the Use a Different Email / Sign In pair each sat alone on an otherwise empty row. Medium.
5. Code refused: the error sat under the button row, away from the field. Medium.
6. Dark: disabled Send Code and Sign In are faint. Medium.
7. Code sent: Use a Different Email outweighs the disabled Sign In. Low.
8. Agent setup attention: the summary line names the problem, but there is no icon or fix button and the toggle stays on. Medium.
9. Updates: the status line sits under Check for Updates, the button is alone on its row, and the footer is far from its toggle. Medium.
10. Login item approval: the toggle shows on while the line says it is waiting for approval. Low.
11. Blank space under the form in every state. Low-medium.

It found About identical to Bento's and General identical apart from the name.

## What changed

- 1, 2, 4, 5: each field is now a bordered field 200 pt wide, left-aligned, with its action inline: Email [field] Send Code;
  Check your email … Use a Different Email; Code [field] Sign In. Signed in is Bento's Account detail row
  (Account / email, Sign Out…) and a This Mac row. The error now sits directly under the code row. The prompts are
  `you@example.com` and `6 digits`.
- 3: signed in, the footer reads "Other computers and cloud agents signed in to this account can use this Mac's sandboxes."

## Declined

- 6, 7: system button styles, unchanged.
- 8, 9, 10, 11: these are Bento's General section and window as they are. The slice requires an exact copy. The
  remedy for a missing command is the CLI's warning, which the popover shows (invariant 10). The updates rows are
  slice 15's, and the window height is `min(780, visible - 60)`.
