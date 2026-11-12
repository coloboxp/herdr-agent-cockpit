// Synthetic data only. The preview never reads local histories or launches agents.
const providers = [
  { id: "codex", label: "Codex", run: ["codex"], resume: ["resume", "{id}"] },
  { id: "claude", label: "Claude Code", run: ["claude"], resume: ["--resume", "{id}"] },
  { id: "cline", label: "Cline", run: ["cline"], resume: ["--tui", "--id", "{id}"] },
];
const now = Date.now() / 1000;
const thread = (id, provider, title, project, hours, parent = null) => ({
  id, provider, title, project, cwd: `/workspace/${project}`, updated: now - hours * 3600, parent, archived: false,
});
const local = { roots: { Atlas: ["/workspace/Atlas"], Website: ["/workspace/Website"] }, providers: {}, threads: [
  thread("demo-access", "codex", "Review workspace access", "Atlas", 1),
  thread("demo-simplify", "claude", "Simplify the invitation flow", "Atlas", 3),
  thread("demo-alternative", "codex", "Explore a smaller migration", "Atlas", 2, "demo-access"),
  thread("demo-docs", "cline", "Update the setup guide", "Atlas", 25),
  thread("demo-nav", "claude", "Polish keyboard navigation", "Website", 4),
  thread("demo-colors", "codex", "Check light and dark themes", "Website", 28),
] };
const remote = { roots: { Observatory: ["/workspace/Observatory"] }, providers: {}, threads: [
  thread("demo-analysis", "codex", "Compare the latest measurements", "Observatory", 2),
  thread("demo-results", "claude", "Summarize the results", "Observatory", 26),
] };
export const demo = {
  machines: [{ name: null, layout: "ready" }, { name: "Build server", layout: "ready" }],
  states: [["", { snapshot: local, providers }], ["Build server", { snapshot: remote, providers }]],
  spaces: [{ id: "demo-atlas", name: "Atlas", folder: "/workspace/Atlas", machine: null, active: true, tabs: [] }],
  terminals: [{ address: "demo-live", state: "live", program: {key:"codex"}, labels: { "herdr.history.provider": "codex", "herdr.history.session": "demo-access" } }],
  expanded: [JSON.stringify(["", "name:Atlas"]), JSON.stringify(["", "name:Website"]), JSON.stringify(["Build server", "name:Observatory"]),
    ...["", "Build server"].flatMap(machine => ["codex", "claude", "cline"].map(provider => JSON.stringify([machine, `harness:${provider}`])))],
};
