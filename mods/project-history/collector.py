"""Read local agent metadata. No model calls, database writes, or persisted cache."""
import sys
sys.dont_write_bytecode = True

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import shlex
import sqlite3
import subprocess
import time
import uuid

LIMIT = 5000
SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


def title(value):
    """Keep labels readable and strip terminal control characters."""
    return " ".join(re.sub(r"[\x00-\x1f\x7f]", " ", str(value or "")).split())[:180] or "Untitled conversation"


def timestamp(value):
    if isinstance(value, (int, float)):
        return (value / 1000 if value > 100000000000 else value) if not isinstance(value, bool) and math.isfinite(value) else None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError, OverflowError):
        return None


def record(provider, session_id, label, cwd, updated, **extra):
    """Validate external metadata before making it actionable in the UI."""
    if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
        return None
    if not isinstance(cwd, str) or "\0" in cwd or not Path(cwd).is_absolute():
        return None
    if label is not None and not isinstance(label, str):
        return None
    updated = timestamp(updated)
    if updated is None:
        return None
    return dict(provider=provider, id=session_id, title=title(label), cwd=cwd,
                updated=updated, archived=False, pinned=False,
                project=None, parent=None, **extra)


def normalize_rows(provider, rows):
    """Invalid rows cannot discard valid siblings or leak arbitrary adapter fields."""
    result = []
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        item = record(provider, raw.get("id"), raw.get("title"), raw.get("cwd"), raw.get("updated"))
        if not item:
            continue
        project, parent = raw.get("project"), raw.get("parent")
        if project is not None and not isinstance(project, str):
            continue
        if parent is not None and (not isinstance(parent, str) or not SESSION_ID.fullmatch(parent)):
            continue
        if any(key in raw and not isinstance(raw[key], bool) for key in ("archived", "pinned", "externallyRunning")):
            continue
        item.update(project=title(project) if project else None, parent=parent,
                    archived=raw.get("archived", False), pinned=raw.get("pinned", False))
        for key in ("origin", "resumeUnavailable"):
            if isinstance(raw.get(key), str):
                item[key] = title(raw[key])
        if isinstance(raw.get("projectRoot"), str) and "\0" not in raw["projectRoot"] and Path(raw["projectRoot"]).is_absolute():
            item["projectRoot"] = raw["projectRoot"]
        item["additionalRoots"] = [path for path in raw.get("additionalRoots", []) if isinstance(path, str) and "\0" not in path and Path(path).is_absolute()] if isinstance(raw.get("additionalRoots", []), list) else []
        item["externallyRunning"] = raw.get("externallyRunning", False)
        result.append(item)
    return result


def read_json(path, fallback=None):
    if not path.exists():
        return fallback
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Metadata file exceeds the supported size")
    return json.loads(path.read_text())


def cli_available(name):
    if shutil.which(name):
        return True
    shell = os.environ.get("SHELL", "/bin/sh")
    result = run_process([shell, "-lic", 'command -v "$1"', shell, name], timeout=5)
    return result.returncode == 0 and bool(result.stdout.strip())


def run_process(command, timeout):
    """Reap the entire owned process group on timeout, including shell-wrapper children."""
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                          start_new_session=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=1)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
            raise RuntimeError("History command timed out; its owned subprocesses were stopped") from None
        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def run_cli(args, timeout=12):
    """Use the same login environment as Herdr launches, including shell functions."""
    if shutil.which(args[0]):
        return run_process(args, timeout)
    shell = os.environ.get("SHELL", "/bin/sh")
    marker = "HERDR_HISTORY_" + uuid.uuid4().hex
    script = 'printf "%s" "$1"; shift; "$@"; history_exit=$?; printf "%s" "' + marker + '"; exit "$history_exit"'
    result = run_process([shell, "-lic", script, shell, marker, *args], timeout)
    # Login profiles can emit terminal integration sequences; isolate only the command's output.
    before, start, output = result.stdout.partition(marker)
    output, end, after = output.rpartition(marker)
    if not start or not end:
        raise RuntimeError("Login shell did not return framed command output")
    result.stdout = output
    return result


def fork_parent(path):
    """Only use explicit fork metadata; message parent UUIDs are not fork ancestry."""
    try:
        with Path(path).open("rb") as stream:
            line = stream.readline(65536)
        payload = json.loads(line).get("payload", {})
        parent = payload.get("forked_from_id") or payload.get("forked_from")
        return parent if isinstance(parent, str) and SESSION_ID.fullmatch(parent) else None
    except (OSError, ValueError, TypeError):
        return None


def codex_rows(connection, state):
    """Accept known metadata columns and fail clearly on an incompatible schema."""
    connection.row_factory = sqlite3.Row
    columns = {r[1] for r in connection.execute("PRAGMA table_info(threads)")}
    required = {"id", "title", "cwd", "source", "updated_at", "archived"}
    if not required <= columns:
        raise ValueError("Unsupported Codex metadata schema")
    tables = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    projects, roots = {}, {}
    if {"projects", "project_roots"} <= tables:
        projects = {r[0]: r[1] for r in connection.execute("SELECT id, name FROM projects")}
        for r in connection.execute("SELECT project_id, path FROM project_roots ORDER BY position"):
            if r[0] in projects:
                roots.setdefault(projects[r[0]], []).append(r[1])
    migrations = state.get("app-server-project-id-by-legacy-project-id-by-host", {})
    migrated = next((v for k, v in migrations.items() if k == "local:" + str(Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")))), {})
    assignments = state.get("thread-project-assignments", {})
    legacy = state.get("local-projects", {})
    fields = ["id", "title", "cwd", "source", "updated_at", "archived"]
    fields += [c for c in ("name", "project_id", "is_pinned", "thread_source", "rollout_path", "forked_from_id") if c in columns]
    # Filter before LIMIT: review workers and background exec jobs must not displace user chats.
    visible = "source IN ('cli','vscode','mcp')"
    if "thread_source" in columns:
        visible = "(thread_source IN ('user','agent_created_thread','chatgpt_handoff','realtime_voice') OR (thread_source IS NULL AND " + visible + "))"
    result = []
    for r in connection.execute("SELECT " + ",".join(fields) + " FROM threads WHERE " + visible + " ORDER BY updated_at DESC LIMIT ?", (LIMIT + 1,)):
        row = dict(r)
        item = record("codex", row["id"], row.get("name") or row["title"], row["cwd"], row["updated_at"])
        if not item:
            continue
        assigned = row.get("project_id") or assignments.get(item["id"], {}).get("projectId")
        project = projects.get(assigned) or projects.get(migrated.get(assigned)) or legacy.get(assigned, {}).get("name")
        if not assigned:
            matches = [name for name, paths in roots.items() if item["cwd"] in paths]
            project = matches[0] if len(matches) == 1 else None
        item.update(project=project, archived=bool(row["archived"]), pinned=bool(row.get("is_pinned")),
                    parent=row.get("forked_from_id") or (fork_parent(row["rollout_path"]) if row.get("rollout_path") else None))
        result.append(item)
    return result[:LIMIT], roots, len(result) > LIMIT


def codex(config=None):
    root = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).absolute()
    databases = sorted(root.glob("state_*.sqlite"), key=lambda p: int(p.stem.split("_")[-1]) if p.stem.split("_")[-1].isdigit() else -1, reverse=True)
    if not databases:
        return [], {}, False
    # shortcut: local Codex metadata is an internal interface; schema checks reject incompatible upgrades.
    with sqlite3.connect(databases[0].as_uri() + "?mode=ro", uri=True, timeout=2) as connection:
        connection.execute("PRAGMA query_only=ON")
        return codex_rows(connection, read_json(root / ".codex-global-state.json", {}))


def desktop_claude_metadata(root=None):
    """Select only local Code metadata; never export Desktop settings or credentials."""
    if root is None:
        if sys.platform != "darwin":
            return []
        root = Path.home() / "Library/Application Support/Claude/claude-code-sessions"
    result = []
    for path in Path(root).glob("*/*/local_*.json"):
        try:
            raw = read_json(path, {})
            item = record("claude", raw.get("cliSessionId"), raw.get("title"), raw.get("cwd"),
                          raw.get("lastActivityAt") or raw.get("createdAt"))
            if not item:
                continue
            item.update(desktopId=raw.get("sessionId"), desktopParent=raw.get("forkedFromSessionId"),
                        archived=bool(raw.get("isArchived")), origin="desktop",
                        projectRoot=raw.get("originCwd"),
                        additionalRoots=[p for p in (raw.get("requestedAdditionalFolders") or []) if isinstance(p, str) and Path(p).is_absolute()])
            result.append(item)
        except (OSError, ValueError, TypeError):
            continue
    parents = {row["desktopId"]: row["id"] for row in result if row["desktopId"]}
    for row in result:
        row["parent"] = parents.get(row.pop("desktopParent"))
        row.pop("desktopId")
    return result


def merge_claude_desktop(rows, metadata):
    by_id = {row["id"]: row for row in rows}
    for desktop in metadata:
        existing = by_id.get(desktop["id"])
        if existing:
            activity = max(existing["updated"], desktop["updated"])
            existing.update(desktop)
            existing["updated"] = activity
        else:
            desktop["resumeUnavailable"] = "No matching local CLI transcript; open this session in Claude Desktop"
            by_id[desktop["id"]] = desktop
    return list(by_id.values())


def claude_process_ids(output):
    """Recognize explicit session flags on Claude commands, not UUIDs in unrelated arguments."""
    sessions = set()
    for line in output.splitlines():
        try:
            args = shlex.split(line)
        except ValueError:
            continue
        if not any(Path(arg).name in ("claude", "claude.exe") for arg in args[:4]):
            continue
        for index, arg in enumerate(args):
            if arg in ("--resume", "-r", "--session-id") and index + 1 < len(args):
                candidate = args[index + 1]
            elif arg.startswith(("--resume=", "--session-id=")):
                candidate = arg.split("=", 1)[1]
            else:
                continue
            if SESSION_ID.fullmatch(candidate):
                sessions.add(candidate)
    return sessions


def running_claude_ids():
    process = run_process(["ps", "-u", str(os.getuid()), "-ww", "-o", "args="], 3)
    if process.returncode:
        raise RuntimeError("Could not check current Claude session ownership")
    return claude_process_ids(process.stdout)


def claude(config=None):
    if not (Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")) / "projects").exists():
        return [], {}, False
    try:
        from claude_agent_sdk import list_sessions
    except ImportError as error:
        raise RuntimeError("Install claude-agent-sdk with list_sessions support to browse Claude history") from error
    rows = []
    for session in list_sessions(limit=LIMIT + 1):
        item = record("claude", session.session_id, session.custom_title or session.summary or session.first_prompt,
                      session.cwd, session.last_modified)
        if item:
            # Only a dedicated ancestry field is reliable; the SDK currently may not expose one.
            item["parent"] = getattr(session, "forked_from_id", None)
            rows.append(item)
    rows = merge_claude_desktop(rows, desktop_claude_metadata((config or {}).get("desktopPath")))
    try:
        active = running_claude_ids()
    except (OSError, RuntimeError):
        active = set()
    for row in rows:
        row["externallyRunning"] = row["id"] in active
    return rows[:LIMIT], {}, len(rows) > LIMIT


def cline(config):
    result = run_cli([arg.replace("{limit}", str(LIMIT + 1)) for arg in config["history"]])
    if result.returncode:
        raise RuntimeError("Cline history command failed; check cline history --json on this machine")
    history = json.loads(result.stdout)
    if not isinstance(history, list):
        raise ValueError("Unsupported Cline history response")
    rows = []
    for session in history:
        if not isinstance(session, dict):
            continue
        if session.get("isSubagent"):
            continue
        metadata = session.get("metadata") if isinstance(session.get("metadata"), dict) else {}
        item = record("cline", session.get("sessionId"), metadata.get("title") or session.get("prompt"),
                      session.get("cwd") or session.get("workspaceRoot"), session.get("updatedAt") or session.get("startedAt"))
        if item:
            item["parent"] = metadata.get("forkedFromId")
            rows.append(item)
    return rows[:LIMIT], {}, len(history) > LIMIT


def command_history(config):
    """Optional adapters return the documented normalized JSON array, never shell code."""
    result = run_cli(config["history"])
    if result.returncode:
        raise RuntimeError("Configured history command failed")
    history = json.loads(result.stdout)
    if not isinstance(history, list):
        raise ValueError("History command must return a JSON array")
    rows = normalize_rows(config["id"], history[:LIMIT + 1])
    return rows[:LIMIT], {}, len(history) > LIMIT


def snapshot(providers):
    """Isolate provider failures so one missing agent never hides the other histories."""
    readers = {"codex": codex, "claude": claude, "cline": cline, "command": command_history}
    result = {"version": 1, "threads": [], "roots": {}, "providers": {}, "collectedAt": time.time()}
    def collect(config):
        available = False
        try:
            available = config["detected"] if "detected" in config else cli_available(config["run"][0])
            reader = readers.get(config.get("reader"))
            if reader is None:
                return [], {}, {"available": bool(config.get("detected")), "count": 0, "liveOnly": True}
            rows, roots, limited = reader(config)
            rows = normalize_rows(config["id"], rows)
            return rows, roots, {"available": available, "count": len(rows), "limited": limited}
        except (OSError, ValueError, TypeError, AttributeError, RuntimeError, sqlite3.Error, subprocess.SubprocessError) as error:
            return [], {}, {"available": available, "count": 0, "error": title(str(error))}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {p["id"]: pool.submit(collect, p) for p in providers if p.get("enabled", True)}
        for name, future in futures.items():
            rows, roots, status = future.result()
            result["threads"].extend(rows); result["roots"].update(roots); result["providers"][name] = status
    result["threads"].sort(key=lambda r: (not r["pinned"], -r["updated"], r["id"]))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", action="append")
    parser.add_argument("--config-json", help="Provider registry JSON, also used for read-only remote execution")
    parser.add_argument("--check-session", help="Check current ownership without loading history")
    args = parser.parse_args()
    registry = json.loads(args.config_json) if args.config_json else read_json(Path(__file__).with_name("providers.json"))
    providers = registry["providers"]
    if args.provider:
        providers = [p for p in providers if p["id"] in args.provider]
    if args.check_session:
        if len(providers) != 1 or not SESSION_ID.fullmatch(args.check_session):
            parser.error("Ownership checks require one provider and a valid session id")
        try:
            ownership = ("running" if args.check_session in running_claude_ids() else "not-found") if providers[0].get("reader") == "claude" else "unsupported"
        except (OSError, RuntimeError):
            ownership = "unknown"
        print(json.dumps({"ownership": ownership}))
    else:
        print(json.dumps(snapshot(providers), ensure_ascii=False, allow_nan=False))
