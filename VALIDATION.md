# Validation

Validated on 2026-11-12 with Herdr app 0.1.15, core 0.1.20, macOS and a connected Linux ARM64 host. All fixtures and release previews are synthetic. Private runtime histories and screenshots are excluded from the repository.

## Automated checks

- Ten Node model tests: detected/configured providers, custom agent discovery, disabled adapters, explicit project membership, shared roots, stable identity across providers/machines, safe resume arguments, partial global/machine overrides, exited/recovered shells, fork cycles, search/archive filtering, harness grouping with original resume targets, general home-folder isolation, bounded pagination/search over 5,000 records, and resumption after a cached space has been closed.
- Ten Python collector tests: user-chat filtering, legacy project assignments, archive/fork metadata, incompatible schema rejection, metadata validation, timestamp conversion, provider failure isolation, process timeout cleanup, login-shell output framing, selected-only Claude Desktop metadata merging, mixed-validity custom adapter output, finite timestamps, and explicit Claude ownership arguments. Reader errors preserve executable availability.
- Five installer tests cover complete replacement, obsolete-file removal, staged/installed validation failures, integration failures, partial new installs, zero-exit checker failures, and clean install/update/restore through a disposable app-home fixture.
- The bundled skill passes the skill-creator validator and is linked into the local Codex skills directory.
- `herdr-app check ./mods/project-history` and JavaScript syntax checks pass. Runtime deferred loading was checked separately in the actual app.

## Runtime checks

| Area | Result |
|---|---|
| Local history | Codex, Claude Code and Cline histories loaded without starting every conversation. |
| Remote history | All three adapters returned metadata on a configured Linux machine; Claude used an isolated SDK environment. |
| Codex resume | A previously completed conversation opened with its history at the prompt; the panel reused its existing tab. |
| Cline resume | A saved conversation opened at its prompt; another click reused the same terminal. The owned test tab and temporary space were removed. |
| Claude Desktop Code | Local Desktop titles, archive flags and explicit fork references merged by CLI session ID. An inactive Desktop conversation resumed in the CLI with its history intact; its owned test tab was closed. |
| Remote Cline/Codex resume | Both opened saved history at a prompt and reused the same terminal on a second click. Codex required a private machine-level executable override to avoid an existing broken shell function; no shell configuration was changed. All owned verification tabs were closed. |
| Remote Claude resume | The initial expired-login state was observed. After the user completed the normal login flow, the saved conversation resumed to its prompt and authenticated status was verified. The user then authorized closing the verification tab; it was closed. The final pass also verified fresh ownership checks, terminal reuse, exit to a shell, and resumption again without focusing the exited shell. |
| Grouping | The popup switched between project and harness views. Harness rows retained project context and the selected mode persisted across mod reload. |
| Navigation | Real search, project expansion, keyboard header/menu activation, native Spaces access and existing-terminal focus were exercised. Page 26–50 returned to 1–25 when the query changed. Empty-search text explained loaded-machine scope. |
| Appearance/states | Light and dark themes, empty search, archive-empty view, provider errors, stale history and loading were inspected. |
| Render stability | Grouping caches survive active-space changes, and grouping runs outside the short render callback. Switching conversations, creating/removing spaces, reloading the panel and loading local/remote history rendered with the larger history present. |
| Update | The complete staged updater replaced the installed mod in its existing layout. Its private backup remains available for rollback. |
| Running work | Existing unrelated local/remote terminals remained running. No task prompt was submitted during resume tests. |

## Limits of this evidence

Local and remote Codex, Claude and Cline resumption were exercised at their prompts. This proves navigation, saved-history loading and terminal reuse; it does not claim new model-task execution. The common Herdr launch path and machine-scoped identity also have automated coverage.

Cloud-only Claude Code, Claude Chat/Cowork and Windows were not tested or advertised as imported history. Unknown agents have live-terminal support only until configured with a history adapter. Authentication is handled by each agent's own CLI, not by this mod.

Codex and Claude Desktop metadata formats remain internal interfaces. Fork ancestry is only as complete as explicit metadata permits. Manual in-terminal session switching and external applications that do not expose session identity remain duplicate-detection limits; see README.md.

## Release preparation

The source, examples, fixtures and preview images are reviewed separately from the installed user configuration. The public folder excludes private project mappings, account IDs, machine addresses, credentials, real transcripts, real screenshots and runtime logs. Herdr-generated type/config files are ignored by Git. The final light/dark images were captured only after guarding that the active preview layout contained synthetic demo/detail blocks; the temporary preview layout was then removed.

`RECIPE.md`, the install/update/restore helper, rollback instructions, a usage/maintenance skill, optional dependency pin and MIT license are included. The first version is 0.1.0. CI is configured to check version agreement, JavaScript syntax and automated tests. The public repository is [coloboxp/herdr-project-history](https://github.com/coloboxp/herdr-project-history), with the `herdr-mod` topic for catalog discovery. The [first hosted CI run](https://github.com/coloboxp/herdr-project-history/actions/runs/43230784364) passed on Ubuntu with Node.js 22 and Python 3.11. CI runs on pushes to `main` and on pull requests; native Herdr checks remain a separate release gate.

## Retained resources

The installed mod and personal console clone remain in the app home. The original console layout remains available. Private update backups remain until the replacement is accepted, then can be removed individually. The dedicated remote Claude SDK environment remains because remote history uses it; its size and removal are documented in the README. The local skill link points to this source checkout and can be removed independently.

No verification terminals, preview layouts, temporary history snapshots or additional background services remain from the final pass. Existing user work remains running. The source is published separately from the private app-home configuration.
