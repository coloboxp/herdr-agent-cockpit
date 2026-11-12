import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, ScrollHandle } from "gpui-base";
import { spaces, machines, terminals, focused, theme, exec, hc, appHome, openOverlay, closeOverlay, run, nextCommand, window, layout, props, readTextFile, knownAgents, shared, setShared } from "herdr";
import { buildProjects, buildHarnesses, liveSession, sessionCandidates, currentProvider, resumeSpace, resumeArgs, matchingThreads, conversationPage, threadRows, sessionKey, terminalTab, providerLabel, resolveProviders } from "./model.js";
import { demo } from "./demo.js";

const width = node => node?.id === "sidebar" ? node.size?.px : (node?.children ?? []).map(width).find(v => v != null);
const machineKey = name => name ?? "";
const labelOfMachine = name => name || "This computer";
const age = seconds => {
  const days = Math.max(0, Math.floor((Date.now() / 1000 - seconds) / 86400));
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? `${days}d ago` : new Date(seconds * 1000).toLocaleDateString();
};

export default class Projects extends View {
  init(_props, cx) {
    if (props()?.groupMenu) {
      this.handle = cx.focus_handle(); this.handle.focus(); this.at = props().current === "harness" ? 1 : 0;
      return;
    }
    this.demo = Boolean(props()?.demo);
    this.states = new Map(); this.expandedMachines = new Set(JSON.parse(localStorage.getItem("expandedMachines") ?? '[""]'));
    this.expanded = new Set(JSON.parse(localStorage.getItem("expanded") ?? "[]"));
    this.settings = {}; this.mappings = []; this.limit = {}; this.actions = []; this.at = 0; this.otherFolders = new Set();
    this.opening = new Set(); this.handle = cx.focus_handle(); this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search loaded history" });
    this.input.on("change", (_e, cx) => { this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.actions[this.at]?.go(cx));
    if (this.demo) {
      this.states = new Map(demo.states); this.expandedMachines = new Set(demo.machines.map(m => machineKey(m.name)));
      this.expanded = new Set(demo.expanded);
    } else {
      cx.spawn(async cx => {
        try {
          const base = appHome() + "/mods/project-history/";
          this.registry = JSON.parse(await readTextFile(base + "providers.json"));
          this.collector = await readTextFile(base + "collector.py");
          this.settings = JSON.parse(await readTextFile(appHome() + "/data/project-history.local.json") ?? "{}");
          this.mappings = this.settings.projects ?? JSON.parse(await readTextFile(appHome() + "/data/project-desk.json") ?? "{}").projects ?? [];
          if (!this.collector) throw new Error("Session reader is missing");
          this.refresh(null, cx);
        } catch (error) { this.setupError = String(error); cx.notify(); }
      });
      cx.timer.every(60000, cx => {
        if (!window().active) return;
        for (const machine of this.machineList()) if (this.expandedMachines.has(machineKey(machine.name))) this.refresh(machine.name, cx);
      });
    }
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.input.focus();
        if (command === "refresh") for (const m of this.machineList()) if (this.expandedMachines.has(machineKey(m.name))) this.refresh(m.name, cx);
        if (command === "remotes") {
          for (const m of this.machineList()) if (m.name) { this.expandedMachines.add(machineKey(m.name)); this.refresh(m.name, cx); }
          if (!this.demo) localStorage.setItem("expandedMachines", JSON.stringify([...this.expandedMachines]));
        }
      }
    });
  }

  machineList() {
    return this.demo ? demo.machines : machines();
  }

  refresh(machine, cx) {
    if (this.demo || !this.collector) return;
    const key = machineKey(machine), state = this.states.get(key) ?? {};
    if (state.loading) return;
    if (!this.machineList().some(m => machineKey(m.name) === key && m.layout === "ready")) {
      this.states.set(key, { ...state, error: "Machine is unavailable. Reconnect in Herdr, then refresh." }); cx.notify(); return;
    }
    this.states.set(key, { ...state, loading: true, error: null }); cx.notify();
    cx.spawn(async cx => {
      try {
        this.settings = JSON.parse(await readTextFile(appHome() + "/data/project-history.local.json") ?? "{}");
        // Discovery belongs to Herdr: it includes programs.json and the target login shell.
        const detected = await knownAgents({ on: machine });
        const settings = { providers: [...(this.settings.providers ?? []), ...(this.settings.machines?.[key]?.providers ?? [])] };
        const providers = resolveProviders(this.registry, detected, settings);
        const python = this.settings.machines?.[key]?.python ?? this.settings.python ?? "python3";
        if (typeof python !== "string" || !python || python.includes("\0")) throw new Error("Invalid Python executable in project history settings");
        const result = await exec(python, ["-B", "-c", this.collector, "--config-json", JSON.stringify({ providers })], { on: machine, timeout: 30000 });
        if (result.code !== 0) throw new Error("Session reader failed. Check Python 3 and the configured adapters on this machine.");
        const snapshot = JSON.parse(result.stdout);
        if (snapshot.version !== 1 || !Array.isArray(snapshot.threads)) throw new Error("Unsupported session reader response");
        for (const [id, status] of Object.entries(snapshot.providers)) if (status.error && state.snapshot) {
          const previous = state.snapshot.threads.filter(thread => thread.provider === id);
          snapshot.threads.push(...previous); status.stale = previous.length > 0;
        }
        this.states.set(key, { snapshot, providers, loading: false, updated: Date.now() });
      } catch (error) { this.states.set(key, { ...state, loading: false, error: String(error) }); }
      cx.notify();
    });
  }

  open(project, thread, cx) {
    if (this.demo) return;
    const machine = project.machine, key = sessionKey(machine, thread);
    if (this.opening.has(key)) return;
    const state = this.states.get(machineKey(machine));
    if (thread.resumeUnavailable) { this.actionError = thread.resumeUnavailable; cx.notify(); return; }
    if (!this.machineList().some(m => m.name === machine && m.layout === "ready")) { this.actionError = "Reconnect this machine before opening a conversation."; cx.notify(); return; }
    if (!state?.snapshot?.providers?.[thread.provider]?.available) { this.actionError = "This agent is unavailable. Check its installation in Herdr, then refresh."; cx.notify(); return; }
    this.opening.add(key); this.actionError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const provider = state.providers.find(p => p.id === thread.provider);
        for (const candidate of sessionCandidates(machine, thread, terminals(), state.providers)) {
          const result = await hc(["get", candidate.address, "--json"]);
          if (result.code !== 0) throw new Error("Could not verify an existing terminal. Refresh before retrying.");
          const current = JSON.parse(result.stdout);
          if (current.state === "live" && currentProvider(current, provider)) {
            run("pane.focus", { terminal: candidate.address }); return;
          }
        }
        if (provider?.reader === "claude") {
          const python = this.settings.machines?.[machineKey(machine)]?.python ?? this.settings.python ?? "python3";
          const result = await exec(python, ["-B", "-c", this.collector, "--config-json", JSON.stringify({ providers: [provider] }), "--check-session", thread.id], { on: machine, timeout: 5000 });
          if (result.code !== 0) throw new Error("Could not check current session ownership. Retry when the machine is available.");
          const ownership = JSON.parse(result.stdout).ownership;
          if (ownership === "running") throw new Error("This conversation is running outside Herdr. Stop or hand it off there before resuming here.");
          if (ownership !== "not-found") throw new Error("Current session ownership is unavailable. Retry before resuming.");
        }
        const argv = resumeArgs(thread, [...new Set([...project.roots, ...(thread.additionalRoots ?? [])])], state.providers);
        const args = { folder: thread.cwd, argv };
        const space = resumeSpace(project, spaces());
        let command;
        if (space) { command = "tab.new"; args.space = space.id; args.name = thread.title; }
        else { command = "space.new"; args.machine = machine ?? ""; args.name = project.name; args.tab = thread.title; }
        const result = await exec("herdr-app", ["do", command, JSON.stringify(args)], { timeout: 15000 });
        if (result.code !== 0) throw new Error("Herdr could not open the conversation. Refresh the machine and retry.");
        const created = JSON.parse(result.stdout);
        if (created.error || !created.terminal) throw new Error("Herdr could not open the conversation. Refresh the machine and retry.");
        const labeled = await hc(["label", created.terminal, `herdr.history.provider=${thread.provider}`, `herdr.history.session=${thread.id}`]);
        if (labeled.code !== 0) this.actionError = "Conversation opened; its live marker could not be saved. Refresh before reopening.";
      } catch (error) { this.actionError = "Could not resume conversation. " + String(error); }
      finally { this.opening.delete(key); cx.notify(); }
    });
  }

  toggleProject(project, cx) {
    this.expanded.has(project.identity) ? this.expanded.delete(project.identity) : this.expanded.add(project.identity);
    if (!this.demo) localStorage.setItem("expanded", JSON.stringify([...this.expanded]));
    if (!this.demo && project.space) run("space.select", { id: project.space.id });
    cx.notify();
  }

  groupBy() {
    return shared("project-history.groupBy") ?? this.settings?.groupBy ?? "project";
  }

  chooseGrouping(group) {
    closeOverlay(props().overlay);
    if (group === "spaces") openOverlay({ mod: "spaces", kind: "dialog", width: 360, height: 600 });
    else setShared("project-history.groupBy", group);
  }

  groupingMenu() {
    const t = theme(), options = [{ id: "project", label: "By project" }, { id: "harness", label: "By harness" }, { id: "spaces", label: "Spaces navigation…" }];
    return v_flex().id("grouping-menu").track_focus(this.handle).w_full().p(6).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((event, cx) => {
        if (event.key === "down" || event.key === "up") { this.at = (this.at + (event.key === "down" ? 1 : options.length - 1)) % options.length; cx.stop_propagation(); cx.notify(); }
        if (event.key === "enter") { this.chooseGrouping(options[this.at].id); cx.stop_propagation(); }
        if (event.key === "escape") closeOverlay(props().overlay);
      }).children(options.map((option, index) => h_flex().id(`group-${option.id}`).h(32).px(10).gap(8).items_center().rounded(5)
        .when(this.at === index, el => el.bg(t.selected)).hover(el => el.bg(t.hover)).cursor_pointer()
        .on_click(() => this.chooseGrouping(option.id))
        .child(div().flex_1().child(option.label))
        .when(props().current === option.id, el => el.child(this.icon("check", t.accent)))));
  }

  icon(name, color, size = 13) {
    return svg(`mods/project-history/icons/${name}.svg`).size(size).flex_none().text_color(color);
  }

  row(id, go, body, selected = false, height = 30, scrollIndex = 0) {
    const t = theme(), index = this.actions.length;
    this.actions.push({ go, scrollIndex });
    return h_flex().id(id).h(height).px(8).gap(7).flex_none().items_center().rounded(5)
      .when(selected || (this.handle.is_focused() && this.at === index), el => el.bg(t.selected))
      .hover(el => el.bg(t.hover)).cursor_pointer()
      .on_click((_e, cx) => { this.at = index; go(cx); }).children(body);
  }

  navigate(event, cx) {
    if (event.key === "down" || event.key === "up") {
      this.at = Math.max(0, Math.min(this.actions.length - 1, this.at + (event.key === "down" ? 1 : -1)));
      this.scroll.scroll_to_item(this.actions[this.at]?.scrollIndex ?? 0); this.handle.focus(); cx.stop_propagation(); cx.notify();
    } else if (event.key === "enter") { this.actions[this.at]?.go(cx); cx.stop_propagation(); }
    else if (event.key === "escape" && focused()?.terminal) { run("pane.focus", { terminal: focused().terminal }); cx.stop_propagation(); }
  }

  render(cx) {
    if (props()?.groupMenu) return this.groupingMenu();
    if (props()?.detail) {
      const t = theme();
      return v_flex().size_full().bg(t.background).p(48).gap(20).text_color(t.foreground)
        .child(div().text_size(32).font_semibold().child("Your projects. Every conversation."))
        .child(div().max_w(600).text_size(17).child("Browse saved agent conversations across your computer and connected machines. Open a chat when you need it; keep the rest as history."))
        .child(div().text_size(14).text_color(t.muted).child("Search · Resume · Reuse open tabs · Follow forks"))
        .child(div().mt(24).text_size(12).text_color(t.muted).child("Synthetic preview. No private projects or conversations are shown."));
    }
    const t = theme(), query = this.input.value().trim().toLowerCase(), harnessView = this.groupBy() === "harness";
    const allSpaces = this.demo ? demo.spaces : spaces(), allTerminals = this.demo ? demo.terminals : terminals();
    this.actions = [];
    const filterKey = JSON.stringify([query, Boolean(this.archived), harnessView]);
    if (this.filterKey !== filterKey) { this.filterKey = filterKey; this.limit = {}; }
    const headerButton = (id, label, go, child) => this.row(id, go, [child], false, 28)
      .px(5).role("button").accessibility_label(label).tooltip(label);
    const header = h_flex().h(36).px(12).flex_none().items_center().justify_between()
      .child(div().font_medium().child(harnessView ? "Harnesses" : "Projects"))
      .child(h_flex().gap(2)
        .child(headerButton("history-new", "New space", () => { if (!this.demo) run("space.new"); }, div().text_size(18).child("+")))
        .child(headerButton("history-grouping", "Grouping and Spaces navigation", () => openOverlay({ mod: "project-history", kind: "popup", width: 230, height: 116, props: { groupMenu: true, current: this.groupBy() } }), this.icon("layers", t.muted)))
        .child(headerButton("history-archive", this.archived ? "Show active chats" : "Show archived chats", cx => { this.archived = !this.archived; this.at = 0; cx.notify(); }, this.icon("archive", this.archived ? t.accent : t.muted)))
        .child(headerButton("history-refresh", "Refresh expanded machines", cx => { for (const m of this.machineList()) if (this.expandedMachines.has(machineKey(m.name))) this.refresh(m.name, cx); }, this.icon("refresh", t.muted))));
    if (!this.demo && (width(layout()) ?? 280) < 160) {
      this.actions = [];
      return v_flex().track_focus(this.handle).size_full().bg(t.chrome).text_color(t.foreground)
        .on_key_down((event, cx) => this.navigate(event, cx)).children(allSpaces.map(space =>
          this.row(`rail-${space.id}`, () => run("space.select", { id: space.id }), [div().child(space.name.slice(0, 2))], space.active, 32)
            .tooltip(space.name).accessibility_label(space.name)));
    }
    const currentSpaces = new Map(allSpaces.map(space => [space.id, space]));
    const rows = [];
    let searchMatches = 0, expandedHistory = false;
    for (const machine of this.machineList()) {
      const key = machineKey(machine.name), state = this.states.get(key) ?? {}, providers = state.providers ?? [];
      this.states.set(key, state);
      const expanded = this.expandedMachines.has(key);
      const signature = JSON.stringify(allSpaces.map(s => [s.id, s.name, s.folder, s.machine]));
      if (!state.preparing && (state.builtSnapshot !== state.snapshot || state.spaceSignature !== signature)) {
        // Group large histories outside the render callback's short execution budget.
        state.preparing = true;
        state.builtSnapshot = state.snapshot; state.spaceSignature = signature;
        cx.spawn(async cx => {
          try {
            state.projects = buildProjects(machine.name, state.snapshot, allSpaces, machine.name ? [] : this.mappings);
            state.harnesses = buildHarnesses(machine.name, state.projects, providers);
            state.filteredRows = new Map();
          } catch (error) { state.error = "Could not group saved history. " + String(error); }
          finally { state.preparing = false; cx.notify(); }
        });
      }
      const projects = harnessView ? state.harnesses ?? [] : state.projects ?? [];
      const filterSignature = JSON.stringify([query, Boolean(this.archived), harnessView]);
      if (state.filterSignature !== filterSignature) { state.filterSignature = filterSignature; state.filteredRows = new Map(); }
      const other = projects.filter(p => p.key.startsWith("path:"));
      rows.push(this.row(`machine-${key}`, cx => {
        expanded ? this.expandedMachines.delete(key) : this.expandedMachines.add(key);
        if (!this.demo) localStorage.setItem("expandedMachines", JSON.stringify([...this.expandedMachines]));
        if (!expanded && !state.snapshot) this.refresh(machine.name, cx);
        cx.notify();
      }, [this.icon(expanded ? "down" : "right", t.muted, 10), this.icon(machine.name ? "server" : "monitor", t.muted),
        div().flex_1().truncate().font_medium().child(labelOfMachine(machine.name)),
        div().text_size(10.5).text_color(t.muted).child(state.loading ? "Loading…" : machine.layout !== "ready" ? "Offline" : ""),
      ], false, 32, rows.length));
      if (!expanded) continue;
      expandedHistory ||= Boolean(state.snapshot);
      if (state.error) rows.push(div().px(14).py(6).text_size(11.5).text_color(t.foreground).child(state.error));
      for (const [id, status] of Object.entries(state.snapshot?.providers ?? {})) if (status.error || status.limited) rows.push(
        div().pl(24).pr(8).py(4).text_size(11).text_color(t.muted).tooltip(status.error || "The provider reached its history limit")
          .child(`${providerLabel(id, providers)}: ${status.stale ? "showing previous history" : status.error ? "history unavailable" : "latest 5,000 chats"}`));
      if (state.snapshot && !state.snapshot.threads.length && !state.loading && !state.error && !Object.values(state.snapshot.providers).some(p => p.error)) rows.push(
        div().pl(24).py(6).text_size(11.5).text_color(t.muted).child("No saved history found. Check configured adapters if you expected chats."));
      const liveOnly = providers.filter(p => state.snapshot?.providers?.[p.id]?.liveOnly).map(p => p.label);
      if (liveOnly.length) rows.push(div().pl(24).pr(8).py(4).text_size(11).text_color(t.muted).tooltip("These detected agents have no saved-history adapter configured").child(`${liveOnly.join(", ")}: live terminals only`));
      if (!state.snapshot && !state.error) rows.push(div().pl(24).py(6).text_size(12).text_color(t.muted).child(state.loading ? "Reading saved history…" : "Refresh to load history"));
      if (!harnessView && other.length && !query) rows.push(this.row(`other-folders-${key}`, cx => {
        this.otherFolders.has(key) ? this.otherFolders.delete(key) : this.otherFolders.add(key); cx.notify();
      }, [div().w(10).flex_none(), this.icon(this.otherFolders.has(key) ? "down" : "right", t.muted, 10),
        div().flex_1().text_size(11.5).text_color(t.muted).child("Other history folders"),
        div().text_size(10.5).text_color(t.muted).child(String(other.length)),
      ], false, 30, rows.length));
      const shownProjects = query || this.otherFolders.has(key) ? projects : projects.filter(p => !p.key.startsWith("path:"));
      for (const project of shownProjects) {
        if (project.space) project.space = currentSpaces.get(project.space.id) ?? project.space;
        project.identity = JSON.stringify([key, project.key]);
        const nameMatches = project.name.toLowerCase().includes(query);
        if (!state.filteredRows.has(project.key)) state.filteredRows.set(project.key, matchingThreads(project.threads, nameMatches ? "" : query, Boolean(this.archived), providers));
        const filtered = state.filteredRows.get(project.key);
        if (query && !nameMatches && !filtered.length) continue;
        searchMatches++;
        const open = Boolean(query) || this.expanded.has(project.identity);
        const selected = Boolean(project.space?.active);
        const projectRow = this.row(`project-${project.identity}`, cx => this.toggleProject(project, cx), [
          div().w(10).flex_none(), this.icon(open ? "down" : "right", t.muted, 10), this.icon(harnessView ? "terminal" : "folder", selected ? t.accent : t.muted),
          div().flex_1().min_w(0).truncate().tooltip(project.roots.join("\n")).font_medium().child(project.name),
          div().text_size(10.5).text_color(t.muted).child(String(filtered.length)),
        ], selected, 31, rows.length);
        if (project.space && !this.demo) projectRow.on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: project.space.id } } }));
        rows.push(projectRow);
        if (!open) continue;
        const knownIds = new Set(project.threads.map(thread => thread.id));
        const linked = new Set(allTerminals.filter(term => knownIds.has(term.labels?.["herdr.history.session"]) || (term.argv ?? []).some(arg => knownIds.has(arg))).map(term => term.address));
        const tabIds = new Set(project.space?.tabs.map(tab => tab.id) ?? []);
        const harness = providers.find(p => p.id === project.provider);
        const unlinked = allTerminals.filter(term => {
          const on = term.address.includes("/") ? term.address.split("/")[0] : "";
          if (on !== key || term.state !== "live" || linked.has(term.address)) return false;
          return harnessView ? term.labels?.["herdr.history.provider"] === project.provider || (harness?.match ?? []).includes(term.program?.key)
            : (term.program?.agent || term.report?.app || term.app) && tabIds.has(terminalTab(term));
        });
        for (const terminal of unlinked) {
          const owner = allSpaces.find(space => space.tabs.some(tab => tab.id === terminalTab(terminal)));
          const tab = owner?.tabs.find(tab => tab.id === terminalTab(terminal));
          rows.push(this.row(`live-${terminal.address}`, () => { if (!this.demo) run("pane.focus", { terminal: terminal.address }); }, [
            div().w(33).flex_none(), this.icon("terminal", t.working),
            div().flex_1().min_w(0).truncate().child((harnessView && owner ? owner.name + " · " : "") + (tab?.name || terminal.title || "Live terminal")),
            div().text_size(10.5).text_color(t.muted).child(terminal.status || "Live"),
          ], false, 30, rows.length));
        }
        if (!filtered.length) rows.push(div().pl(54).py(6).text_size(11.5).text_color(t.muted).child(query ? "No matching chats" : this.archived ? "No archived chats" : "No saved chats"));
        const page = conversationPage(filtered, this.limit[project.identity]), offset = page.offset;
        for (const { thread, depth } of threadRows(page.threads, "", Boolean(this.archived), providers)) {
          const live = liveSession(machine.name, thread, allTerminals, providers);
          const current = !this.demo && live?.address === focused()?.terminal;
          const parent = thread.parent && project.threads.find(p => p.provider === thread.provider && p.id === thread.parent);
          const label = providerLabel(thread.provider, providers);
          const tooltip = `${thread.title}\n${label} · ${new Date(thread.updated * 1000).toLocaleString()}${parent ? `\nFork of ${parent.title}` : thread.parent ? "\nFork · original not in this list" : ""}`;
          rows.push(this.row(`chat-${sessionKey(machine.name, thread)}`, cx => this.open(thread.harnessProject ?? project, thread, cx), [
            div().w(33 + depth * 10).flex_none(), this.icon(thread.parent ? "branch" : thread.pinned ? "pin" : "chat", current ? t.accent : t.muted),
            v_flex().flex_1().min_w(0).gap(2).tooltip(tooltip)
              .child(div().truncate().text_color(t.foreground).child(thread.title))
              .child(div().truncate().text_size(10.5).text_color(t.muted).child((harnessView ? thread.harnessProject.name : label) + (thread.origin === "desktop" ? " · Desktop" : "") + (thread.parent ? " · Fork" : ""))),
            div().flex_none().text_size(10).text_color(live || thread.externallyRunning ? t.accent : t.muted).child(this.opening.has(sessionKey(machine.name, thread)) ? "Opening…" : live ? "Open" : thread.externallyRunning ? "Running" : thread.resumeUnavailable ? "Desktop only" : age(thread.updated)),
          ], current, 44, rows.length));
        }
        if (filtered.length > 25) rows.push(div().pl(54).py(4).text_size(10.5).text_color(t.muted).child(`${offset + 1}–${offset + page.threads.length} of ${filtered.length}`));
        if (page.previous) rows.push(this.row(`previous-${project.identity}`, cx => {
          this.limit[project.identity] = Math.max(0, offset - 25); cx.notify();
        }, [div().pl(47).text_color(t.accent).child("Previous 25")], false, 30, rows.length));
        if (page.next) rows.push(this.row(`more-${project.identity}`, cx => {
          this.limit[project.identity] = offset + 25; cx.notify();
        }, [div().pl(47).text_color(t.accent).child(`Next ${Math.min(25, filtered.length - offset - 25)}`)], false, 30, rows.length));
      }
    }
    if (query && !searchMatches && ![...this.states.values()].some(state => state.loading)) rows.push(
      div().px(16).py(10).text_size(12).text_color(t.muted).child(expandedHistory ? "No matches in loaded history. Expand another machine to include its history." : "Expand a machine to search its history"));
    this.at = Math.min(this.at, Math.max(0, this.actions.length - 1));
    return v_flex().id("project-history").track_focus(this.handle).size_full().min_h(0).bg(t.chrome).text_size(12.5).text_color(t.foreground)
      .on_key_down((event, cx) => this.navigate(event, cx))
      .child(header)
      .child(h_flex().mx(8).mb(6).px(8).h(30).flex_none().items_center().gap(6).rounded(5).border(1).border_color(t.input)
        .child(this.icon("search", t.muted)).child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground)))
      .when(Boolean(this.archived), el => el.child(div().px(16).pb(4).text_size(11).text_color(t.muted).child("Archived chats")))
      .when(Boolean(this.setupError || this.actionError), el => el.child(div().px(12).py(6).text_size(11.5).text_color(t.foreground).child(this.setupError || this.actionError)))
      .child(v_flex().id("project-history-list").track_scroll(this.scroll).flex_1().min_h(0).px(6).pb(8).overflow_y_scrollbar().children(rows));
  }
}
