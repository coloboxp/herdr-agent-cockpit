"""Install the mod and integrate it into a copy of an existing Herdr layout."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def command(*args):
    result = subprocess.run(["herdr-app", *args], capture_output=True, text=True, check=True)
    if args[0] == "check":
        # Herdr can report a failed check with a successful process exit code.
        if "check passed:" not in result.stdout:
            raise RuntimeError("Mod validation failed: " + (result.stderr or result.stdout).strip())
        return None
    return json.loads(result.stdout)


def nodes(node):
    yield node
    for child in node.get("children", []):
        yield from nodes(child)


@contextmanager
def installed_revision(source, target):
    """Validate a complete staged revision and restore the old code on failure."""
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".project-history-", dir=target.parent) as temporary:
        staging = Path(temporary) / "next"
        previous = Path(temporary) / "previous"
        shutil.copytree(source, staging, ignore=shutil.ignore_patterns("*.d.ts", "jsconfig.json", "*.error", "__pycache__"))
        command("check", str(staging))
        if target.exists():
            target.rename(previous)
        try:
            staging.rename(target)
            command("check", str(target))
            yield
        except BaseException:
            if target.exists():
                shutil.rmtree(target)
            if previous.exists():
                previous.rename(target)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true", help="Back up and replace an existing installation")
    parser.add_argument("--restore", type=Path, help="Restore mod code from a printed backup directory")
    args = parser.parse_args()
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    app_home = Path(os.environ.get("HERDR_APP_HOME", config_home / "herdr-app"))
    source = args.restore / "project-history" if args.restore else Path(__file__).parent / "mods/project-history"
    version_file = source / "VERSION"
    version = version_file.read_text().strip() if version_file.exists() else None
    status = command("status")
    old_layout = status["layout"]
    old_path = app_home / "layouts" / (old_layout + ".json")
    layout = json.loads(old_path.read_text())
    blocks = [node for node in nodes(layout) if node.get("content", {}).get("mod") in ("spaces", "project-history")]
    if len(blocks) != 1:
        raise SystemExit("Expected one Spaces block. Add project-history manually; this layout was not changed.")
    new_layout = old_layout if blocks[0]["content"]["mod"] == "project-history" else old_layout + "-projects"
    if new_layout != old_layout and (app_home / "layouts" / (new_layout + ".json")).exists():
        raise SystemExit("The target layout name already exists. Choose it in Herdr or integrate manually.")
    command("check", str(source))
    target = app_home / "mods/project-history"
    backup = None
    if target.exists():
        if not (args.update or args.restore):
            raise SystemExit("Mod already exists. Use --update to back it up and replace it, or inspect it first.")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup = app_home / "backups" / ("project-history-" + stamp)
        backup.mkdir(parents=True)
        shutil.copytree(target, backup / "project-history")
        shutil.copy2(old_path, backup / old_path.name)
    with installed_revision(source, target):
        if new_layout != old_layout:
            command("do", "layout.clone", json.dumps({"name": old_layout, "as": new_layout}))
            new_path = app_home / "layouts" / (new_layout + ".json")
            layout = json.loads(new_path.read_text())
        else:
            new_path = old_path
        for node in nodes(layout):
            if node.get("content", {}).get("mod") == "spaces":
                node["content"]["mod"] = "project-history"
                node["size"] = {"weight": 2}
            if node.get("id") == "sidebar":
                node["size"] = {"px": max(300, node.get("size", {}).get("px", 300))}
        temporary = new_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(layout, indent=2) + "\n")
        temporary.replace(new_path)
    print(json.dumps({"version": version, "layout": new_layout, "rollbackLayout": old_layout if new_layout != old_layout else None,
                      "backup": str(backup) if backup else None}))


if __name__ == "__main__":
    main()
