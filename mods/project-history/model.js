export const providerLabel = (id, providers) => providers.find(p => p.id === id)?.label ?? "Agent";
export const sessionKey = (machine, thread) => JSON.stringify([machine ?? "", thread.provider, thread.id]);
export const terminalTab = terminal => {
  const tab = terminal.labels?.["herdr.tab"];
  const machine = terminal.address.includes("/") ? terminal.address.split("/")[0] : "";
  return machine && tab && !tab.startsWith(machine + "/") ? machine + "/" + tab : tab;
};
const pathWithin = (path, root) => path === root || path.startsWith(root.replace(/\/$/, "") + "/");
const basename = path => path === "/" ? "Filesystem root" : path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Home";

export function resolveProviders(defaults, detected, settings = {}) {
  const configured = new Map(defaults.providers.map(p => [p.id, { ...p }]));
  const overrides = new Map();
  for (const p of settings.providers ?? []) overrides.set(p.id, { ...overrides.get(p.id), ...p });
  for (const override of settings.providers ?? []) configured.set(override.id, { ...configured.get(override.id), ...override });
  const providers = [...configured.values()].map(p => {
    const agent = detected.find(a => (p.match ?? [p.id]).includes(a.key));
    const launch = overrides.get(p.id)?.run ?? agent?.run ?? p.run;
    return { ...p, label: overrides.get(p.id)?.label ?? agent?.name ?? p.label ?? "Agent", run: launch,
      ...(agent && JSON.stringify(launch) === JSON.stringify(agent.run) ? { detected: Boolean(agent.installed) } : {}) };
  });
  for (const agent of detected.filter(a => a.installed)) {
    if (!providers.some(p => (p.match ?? [p.id]).includes(agent.key))) providers.push({
      id: agent.key, label: agent.name, match: [agent.key], run: agent.run, detected: true,
    });
  }
  for (const p of providers) {
    if (typeof p.id !== "string" || !/^[A-Za-z0-9_.-]+$/.test(p.id)) throw new Error("Each provider needs a simple unique id");
    for (const key of ["run", "resume", "history"]) if (p[key] && (!Array.isArray(p[key]) || !p[key].every(a => typeof a === "string" && a && !a.includes("\0")))) throw new Error(`Invalid ${key} command for ${p.label}`);
  }
  return providers.filter(p => p.enabled !== false);
}

export function buildProjects(machine, snapshot, spaces, mappings = []) {
  const groups = new Map();
  const roots = snapshot?.roots ?? {};
  const add = (key, name, paths, space = null, subtree = false) => {
    if (!groups.has(key)) groups.set(key, { key, machine, name, roots: paths, space, subtree, threads: [], live: [] });
    else if (space) groups.get(key).space = space;
    return groups.get(key);
  };
  for (const [name, paths] of Object.entries(roots)) add(`name:${name}`, name, paths, null, true);
  for (const space of spaces.filter(s => (s.machine ?? "") === (machine ?? ""))) {
    const mapped = mappings.find(p => p.space === space.id);
    const name = mapped?.name ?? space.name;
    const existing = [...groups.values()].find(p => p.name === name);
    const paths = mapped?.roots ?? existing?.roots ?? [space.folder];
    add(existing?.key ?? `name:${name}`, name, paths, space, Boolean(mapped));
  }
  const candidates = [...groups.values()].flatMap(p => p.roots.map((root, index) => ({ p, root, index })))
    .filter(c => c.root).sort((a, b) => b.root.length - a.root.length || a.index - b.index);
  const seen = new Set();
  for (const thread of snapshot?.threads ?? []) {
    const identity = sessionKey(machine, thread);
    if (seen.has(identity)) continue;
    seen.add(identity);
    let project = thread.project ? groups.get(`name:${thread.project}`) : null;
    if (!project && thread.project) project = add(`name:${thread.project}`, thread.project, [thread.cwd]);
    if (!project) {
      const path = thread.projectRoot || thread.cwd;
      project = candidates.find(c => c.p.subtree ? pathWithin(path, c.root) : path === c.root)?.p;
    }
    if (!project) project = add(`path:${thread.cwd}`, basename(thread.cwd), [thread.cwd]);
    project.threads.push(thread);
  }
  return [...groups.values()].sort((a, b) => Number(Boolean(b.space)) - Number(Boolean(a.space))
    || (a.space?.index ?? Infinity) - (b.space?.index ?? Infinity) || a.name.localeCompare(b.name));
}

export function buildHarnesses(machine, projects, providers) {
  const groups = new Map(providers.map(p => [p.id, {
    key: `harness:${p.id}`, machine, name: p.label, provider: p.id, roots: [], space: null, threads: [],
  }]));
  for (const project of projects) for (const thread of project.threads) {
    const group = groups.get(thread.provider);
    if (group) group.threads.push({ ...thread, harnessProject: project });
  }
  return [...groups.values()].filter(group => group.threads.length || providers.find(p => p.id === group.provider)?.detected)
    .map(group => ({ ...group, threads: group.threads.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updated - a.updated) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function currentProvider(terminal, provider) {
  if (!provider || terminal.program?.shell) return false;
  const names = new Set([provider.id, ...(provider.match ?? []), basename(provider.run?.[0] ?? "")]);
  if (terminal.foreground) return (terminal.foreground.argv ?? []).some(arg => names.has(basename(arg)));
  return names.has(terminal.program?.key) || names.has(terminal.report?.app);
}

export function sessionCandidates(machine, thread, terminals, providers) {
  const provider = providers.find(p => p.id === thread.provider);
  return terminals.filter(terminal => {
    if (terminal.state !== "live") return false;
    const addressMachine = terminal.address.includes("/") ? terminal.address.split("/")[0] : "";
    if (addressMachine !== (machine ?? "")) return false;
    const labels = terminal.labels ?? {};
    if (labels["herdr.history.provider"] === thread.provider && labels["herdr.history.session"] === thread.id) return true;
    const args = terminal.argv ?? [];
    const marker = provider?.resume?.indexOf("{id}") ?? -1;
    const flag = marker > 0 ? provider.resume[marker - 1] : null;
    return flag && args.some((arg, index) => arg === flag && args[index + 1] === thread.id)
      && args.some(arg => basename(arg) === basename(provider.run?.[0] ?? ""));
  });
}

export function liveSession(machine, thread, terminals, providers) {
  const provider = providers.find(p => p.id === thread.provider);
  return sessionCandidates(machine, thread, terminals, providers).find(terminal => currentProvider(terminal, provider));
}

export const resumeSpace = (project, spaces) => spaces.find(space => space.id === project.space?.id
  && (space.machine ?? "") === (project.machine ?? ""));

export function resumeArgs(thread, roots, providers) {
  const provider = providers.find(p => p.id === thread.provider);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(thread.id) || !provider?.run?.length || !provider.resume?.includes("{id}")) throw new Error("No valid resume adapter configured");
  const args = [...provider.run, ...provider.resume.map(arg => arg === "{id}" ? thread.id : arg)];
  if (provider.rootsFlag) for (const root of roots) if (typeof root === "string" && root.startsWith("/") && root !== thread.cwd) args.push(provider.rootsFlag, root);
  return args;
}

export function matchingThreads(threads, query = "", archived = false, providers = []) {
  return threads.filter(t => Boolean(t.archived) === archived && `${t.title} ${providerLabel(t.provider, providers)} ${t.harnessProject?.name ?? ""}`.toLowerCase().includes(query));
}

export function conversationPage(threads, offset = 0) {
  const last = Math.max(0, Math.floor((threads.length - 1) / 25) * 25);
  const start = Number.isInteger(offset) && offset >= 0 ? Math.min(offset, last) : 0;
  return { offset: start, threads: threads.slice(start, start + 25), previous: start > 0, next: start + 25 < threads.length };
}

export function threadRows(threads, query = "", archived = false, providers = []) {
  const visible = matchingThreads(threads, query, archived, providers);
  const byId = new Map(visible.map(t => [`${t.provider}:${t.id}`, t]));
  const children = new Map();
  for (const t of visible) {
    const parent = t.parent && byId.get(`${t.provider}:${t.parent}`);
    if (parent && parent !== t) {
      const key = `${t.provider}:${parent.id}`;
      children.set(key, [...(children.get(key) ?? []), t]);
    }
  }
  const order = (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updated - a.updated;
  const out = [], visited = new Set();
  const visit = (t, depth) => {
    const key = `${t.provider}:${t.id}`;
    if (visited.has(key)) return;
    visited.add(key); out.push({ thread: t, depth: Math.min(depth, 3) });
    for (const child of (children.get(key) ?? []).sort(order)) visit(child, depth + 1);
  };
  for (const t of [...visible].sort(order)) {
    if (!t.parent || !byId.has(`${t.provider}:${t.parent}`)) visit(t, 0);
  }
  for (const t of [...visible].sort(order)) visit(t, 0);
  return out;
}
