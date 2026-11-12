---
name: herdr-workspace
description: Browse and resume coding-agent conversations through Herdr Project History, configure its machines and providers, and maintain or roll back the mod.
---

# Herdr workspace

Use Herdr as the terminal owner and Project History as the saved-conversation index. Keep live agent status separate from saved history. A shell left after an agent exits is not an open conversation.

## Browse and resume

- Inspect `herdr-app status`, `herdr-app ls` and the installed mod's `providers.json`. App home is `HERDR_APP_HOME`, or `${XDG_CONFIG_HOME:-~/.config}/herdr-app`. Do not assume machine names, spaces, terminal IDs or enabled agents.
- `herdr-app do project-history.focus` focuses history search. `project-history.refresh` reloads settings and expanded machines. `project-history.remotes` explicitly loads configured remotes; use it when remote browsing is requested.
- Read `<app home>/data/project-history.local.json` if present. Provider settings merge field by field: bundled registry, Herdr detection, global private overrides, machine overrides. Use the configured Python on each machine.
- List local history with `<python> -B <app home>/mods/project-history/collector.py`. Select providers with `--provider <registry id>`. Listing is read-only and starts no agents. The normalized result supplies project roots, provider health and validated conversation metadata. Avoid printing complete personal histories unnecessarily.
- For remote collection, use Herdr's existing `exec` interface with an explicit target machine and configured Python; send the installed collector source through `-c` and the resolved registry through `--config-json`. Check the current Herdr interface before constructing a remote command. Do not create a remote helper, daemon or transcript copy.
- Prefer clicking the selected panel row for resumption: it checks existing terminals, checks Claude ownership where supported, chooses the project/machine, constructs the configured argument array and labels the resulting terminal. Never launch conversations just to identify them.
- If resuming through CLI, inspect `herdr-app commands` for current `tab.new`, `space.new` and `pane.focus` arguments. Use the exact saved folder, configured provider `run` plus `resume` arguments, and explicit machine. Use `{id}` only as a complete argument. Add configured additional-root flags. Pass no task prompt or permission-bypass flags.
- Before a CLI launch, inspect matching live terminals with `herdr-core get <address> --json`; confirm current foreground provider and saved session identity. Focus an existing match with `pane.focus`. For Claude, run the collector with one selected provider and `--check-session <id>` on the target machine. `running` blocks a second launch; `unknown` requires recovery before retrying. `not-found` is best-effort process evidence.
- Desktop-only metadata cannot be resumed through a missing CLI transcript. Explicit fork metadata may be shown; do not infer ancestry from message parents or similar titles. In-agent session switches can invalidate saved terminal labels.

## Configure

Keep personal settings in the app-home data file, outside public source. Supported choices are `groupBy` (`project` or `harness`), `python`, provider overrides and machine-specific overrides. A grouping choice made in the panel overrides the configured default. Search covers loaded machines; expand another machine to include it.

Use a custom `reader: command` only when its history command returns the documented normalized array. Read the repository README before adding an adapter; retain validation of IDs, finite dates, absolute folders and optional fields. Keep valid rows when other rows are malformed. Authentication and models belong to the agent's normal setup.

## Maintain

Work in the source repository. Read its `AGENTS.md`, `README.md`, `RECIPE.md` and `VALIDATION.md`. Inspect branch, upstream and dirty work before changes; fetch a configured remote when reachable. Preserve user changes.

Run `node --test tests/*.test.mjs`, `python3 -B -m unittest discover -s tests -p 'test_*.py'`, and `herdr-app check ./mods/project-history`. Update with `python3 -B install.py --update`; it prints a private backup location. Inspect the real loaded panel because the checker misses deferred states. Verify changed navigation and resume behavior without submitting prompts; close only test terminals you created.

To recover an update, run `python3 -B install.py --restore <printed backup directory>`. It replaces the complete mod and keeps a backup of the replaced revision. Switching to the original layout restores navigation but does not restore mod code or stop terminals. Read the README's rollback commands before removal.

For public packaging, include source, this skill, synthetic examples and synthetic previews only. Exclude private configuration, paths, hostnames, account identifiers, session metadata, logs and real screenshots. Never publish merely because installation or tests passed; publication needs the user's instruction.
