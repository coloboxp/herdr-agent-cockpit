import test from "node:test";
import assert from "node:assert/strict";
import { buildProjects, buildHarnesses, liveSession, resumeSpace, resumeArgs, resolveProviders, threadRows, terminalTab, conversationPage, matchingThreads } from "../mods/project-history/model.js";

const registry = { providers: [{ id: "sample", label: "Sample", match: ["sample-agent"], run: ["sample"], resume: ["resume", "{id}"], rootsFlag: "--add-dir" }] };
const chat = (id, extra = {}) => ({ id, provider: "sample", title: id, cwd: "/workspace/alpha", updated: 1, ...extra });

test("provider detection, configuration and new agent discovery drive the model", () => {
  const providers = resolveProviders(registry, [
    { key: "sample-agent", installed: true, name: "Detected", run: ["wrapper", "sample"] },
    { key: "other", installed: true, name: "Other tool", run: ["other"] },
  ], { providers: [{ id: "sample", label: "My agent" }] });
  assert.equal(providers[0].label, "My agent");
  assert.deepEqual(providers[0].run, ["wrapper", "sample"]);
  assert.equal(providers[1].label, "Other tool");
  assert.equal(providers[1].reader, undefined);
  assert.equal(resolveProviders(registry, [])[0].detected, undefined);
  assert.deepEqual(resolveProviders(registry, [{key:"sample-agent",installed:true,run:["detected"]}],
    {providers:[{id:"sample",run:["custom-launch"]}]}).at(0).run, ["custom-launch"]);
  const merged = resolveProviders(registry, [{key:"sample-agent", installed:true, name:"Detected", run:["detected"]}],
    {providers:[{id:"sample", label:"Custom", run:["custom-launch"]}, {id:"sample", history:["history"]}]}).at(0);
  assert.equal(merged.label, "Custom");
  assert.deepEqual(merged.run, ["custom-launch"]);
  assert.deepEqual(merged.history, ["history"]);
  assert.equal(merged.detected, undefined);
  assert.equal(resolveProviders(registry, [], { providers: [{ id: "sample", enabled: false }] }).length, 0);
  assert.throws(() => resolveProviders(registry, [], { providers: [{ id: "bad id" }] }));
});

test("explicit membership wins, shared secondary roots do not duplicate conversations", () => {
  const groups = buildProjects(null, {
    roots: { Alpha: ["/workspace/alpha"], Editorial: ["/workspace/editorial", "/workspace/alpha"] },
    threads: [chat("first"), chat("explicit", { project: "Editorial" }), chat("first")],
  }, []);
  assert.deepEqual(groups.find(g => g.name === "Alpha").threads.map(t => t.id), ["first"]);
  assert.deepEqual(groups.find(g => g.name === "Editorial").threads.map(t => t.id), ["explicit"]);
});

test("machine and provider identity prevent incorrect terminal reuse", () => {
  const providers = registry.providers;
  const terminals = [
    { address: "remote/t1", state: "live", argv: ["sample", "resume", "saved"], foreground: {argv:["sample", "resume", "saved"]} },
    { address: "t2", state: "live", argv: ["other", "resume", "saved"] },
    { address: "t3", state: "finished", argv: ["sample", "resume", "saved"] },
  ];
  assert.equal(liveSession(null, chat("saved"), terminals, providers), undefined);
  assert.equal(liveSession("remote", chat("saved"), terminals, providers).address, "remote/t1");
  terminals.push({ address: "t4", state: "live", program: {key:"sample-agent"}, labels: { "herdr.history.provider": "sample", "herdr.history.session": "saved" } });
  assert.equal(liveSession(null, chat("saved"), terminals, providers).address, "t4");
  terminals.at(-1).foreground = {argv:["/bin/zsh"]};
  assert.equal(liveSession(null, chat("saved"), terminals, providers), undefined);
  terminals.at(-1).program = {key:"zsh", shell:true};
  delete terminals.at(-1).foreground;
  assert.equal(liveSession(null, chat("saved"), terminals, providers), undefined);
});

test("resume is an argv array, preserves additional roots, rejects unconfigured providers", () => {
  assert.deepEqual(resumeArgs(chat("saved"), ["/workspace/alpha", "/workspace/shared space"], registry.providers),
    ["sample", "resume", "saved", "--add-dir", "/workspace/shared space"]);
  assert.throws(() => resumeArgs(chat("--untrusted-option"), [], []));
  assert.throws(() => resumeArgs(chat("--untrusted-option"), [], registry.providers));
  assert.throws(() => resumeArgs(chat("id; command"), [], registry.providers));
});

test("resume resolves current space ownership and tolerates a closed cached space", () => {
  const cached = {id:"remote/old", machine:"remote"};
  const project = {machine:"remote", space:cached};
  assert.equal(resumeSpace(project, []), undefined);
  assert.equal(resumeSpace(project, [{...cached, machine:null}]), undefined);
  const current = {...cached, tabs:[]};
  assert.equal(resumeSpace(project, [current]), current);
});

test("forks have reliable provider-scoped parents, orphaned forks and cycles remain visible", () => {
  const rows = threadRows([
    chat("parent"), chat("child", { parent: "parent", updated: 2 }),
    chat("orphan", { parent: "missing" }), chat("a", { parent: "b" }), chat("b", { parent: "a" }),
  ]);
  assert.equal(rows.length, 5);
  assert.equal(rows.find(r => r.thread.id === "child").depth, 1);
  assert.equal(rows.find(r => r.thread.id === "orphan").depth, 0);
  assert.equal(new Set(rows.map(r => r.thread.id)).size, 5);
});

test("search and archived visibility use agent labels from configuration", () => {
  assert.equal(threadRows([chat("a"), chat("b", { archived: true })], "sample", false, registry.providers).length, 1);
  assert.equal(threadRows([chat("a"), chat("b", { archived: true })], "", true).at(0).thread.id, "b");
});

test("harness grouping retains the original project, folder and machine for resume", () => {
  const projects = buildProjects("remote", { roots: { Alpha: ["/workspace/alpha"] }, threads: [chat("saved", { project: "Alpha" })] }, []);
  const harnesses = buildHarnesses("remote", projects, registry.providers);
  assert.equal(harnesses[0].name, "Sample");
  assert.equal(harnesses[0].threads[0].harnessProject, projects[0]);
  assert.equal(harnesses[0].threads[0].harnessProject.machine, "remote");
  assert.equal(harnesses[0].threads[0].cwd, "/workspace/alpha");
  assert.equal(projects[0].threads[0].harnessProject, undefined);
  assert.equal(threadRows(harnesses[0].threads, "alpha").length, 1);
  assert.equal(terminalTab({ address: "remote/t1", labels: { "herdr.tab": "tab1" } }), "remote/tab1");
});

test("a general home-directory space cannot swallow unrelated projects", () => {
  const projects = buildProjects(null, { threads: [chat("saved", { cwd: "/home/example/code/alpha" })] }, [
    { id: "home", name: "Scratch", folder: "/home/example", machine: null, tabs: [] },
  ]);
  assert.equal(projects.find(p => p.threads.length).name, "alpha");
});

test("large histories have bounded pages while search still reaches the oldest record", () => {
  const history = Array.from({length:5000}, (_,i) => chat(`saved-${i}`));
  const first = conversationPage(history), last = conversationPage(history, 99999);
  assert.equal(first.threads.length, 25); assert.equal(first.previous, false); assert.equal(first.next, true);
  assert.equal(last.offset, 4975); assert.equal(last.threads.at(-1).id, "saved-4999"); assert.equal(last.next, false);
  assert.equal(conversationPage(history, -1).offset, 0);
  assert.deepEqual(conversationPage([]).threads, []);
  assert.equal(matchingThreads(history, "saved-4999").at(0).id, "saved-4999");
});
