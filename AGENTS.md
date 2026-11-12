# Working on Herdr Agent Cockpit

Read README.md and RECIPE.md before changing behavior. This is a public-source repository: keep actual project maps, session metadata, hostnames, personal paths, account IDs, credentials, private screenshots and test logs outside it. Use synthetic fixtures only. Never copy a whole Herdr app home into this repository.

The provider registry and Herdr detection decide agent labels and launch commands. Format-specific readers may know their storage formats; the shared model must not hardcode which agents are enabled. Add configuration and fixtures when adding an adapter.

Preserve saved history and active work. Discovery is read-only. Do not start agents to list conversations, send a prompt during a resume smoke test, add permission-bypass flags, or stop terminals you did not create. Keep optional remote dependencies isolated and document their ownership and removal.

Run Node model tests, Python collector tests and `herdr-app check ./mods/project-history` after relevant changes. Herdr's checker does not run deferred states: inspect the real loaded panel too. Keep runtime test evidence local, and describe the scope in VALIDATION.md without embedding private data.

For TUI management, use `herdr-app ls`, the mod's focus/refresh/remotes commands and the normalized collector snapshot. Resume with explicit machine, folder and the provider's configured argument array. Never guess terminal, space or session IDs.
