"""Disposable fixtures for complete replacement and failure recovery."""
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import shutil
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("installer", Path(__file__).parents[1] / "install.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def test_clean_install_update_and_restore_in_disposable_app_home(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            layouts = home / "layouts"; layouts.mkdir()
            original = {"id":"sidebar", "size":{"px":240}, "children":[{"id":"spaces", "content":{"mod":"spaces"}}]}
            (layouts / "main.json").write_text(json.dumps(original))
            active = ["main"]
            def command(*args):
                if args[0] == "status":
                    return {"layout":active[0]}
                if args[:2] == ("do", "layout.clone"):
                    clone = json.loads(args[2])
                    shutil.copy2(layouts / (clone["name"] + ".json"), layouts / (clone["as"] + ".json"))
                    active[0] = clone["as"]
            def invoke(*args):
                with patch.dict(installer.os.environ, {"HERDR_APP_HOME":str(home)}), patch("sys.argv", ["install.py", *args]), patch.object(installer, "command", side_effect=command), patch("builtins.print"):
                    installer.main()
            invoke()
            target = home / "mods/project-history"
            self.assertEqual(active[0], "main-projects")
            self.assertEqual(json.loads((layouts / "main.json").read_text()), original)
            integrated = json.loads((layouts / "main-projects.json").read_text())
            self.assertEqual(integrated["children"][0]["content"]["mod"], "project-history")
            self.assertEqual(integrated["size"]["px"], 300)
            (target / "obsolete.py").write_text("old")
            (target / "main.js").write_text("previous revision")
            invoke("--update")
            self.assertFalse((target / "obsolete.py").exists())
            backup = next((home / "backups").iterdir())
            invoke("--restore", str(backup))
            self.assertEqual((target / "main.js").read_text(), "previous revision")
            self.assertEqual((target / "obsolete.py").read_text(), "old")

    def test_failed_checker_output_is_failure_even_with_zero_exit_status(self):
        with patch.object(installer.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "check failed: example", "")):
            with self.assertRaisesRegex(RuntimeError, "validation failed"):
                installer.command("check", "example")

    def test_update_removes_obsolete_files_and_retains_only_complete_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source", Path(directory) / "mods/history"
            source.mkdir(); target.mkdir(parents=True)
            (source / "main.js").write_text("new")
            (target / "main.js").write_text("old")
            (target / "obsolete.py").write_text("obsolete")
            with patch.object(installer, "command"), installer.installed_revision(source, target):
                self.assertEqual((target / "main.js").read_text(), "new")
            self.assertFalse((target / "obsolete.py").exists())
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_failed_validation_and_integration_restore_previous_revision(self):
        for failure in ("staging", "installed", "integration"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                source, target = Path(directory) / "source", Path(directory) / "mods/history"
                source.mkdir(); target.mkdir(parents=True)
                (source / "main.js").write_text("new")
                (target / "main.js").write_text("old")
                checks = [RuntimeError("invalid")] if failure == "staging" else [None, RuntimeError("invalid")] if failure == "installed" else [None, None]
                with patch.object(installer, "command", side_effect=checks), self.assertRaises(RuntimeError):
                    with installer.installed_revision(source, target):
                        raise RuntimeError("integration")
                self.assertEqual((target / "main.js").read_text(), "old")
                self.assertEqual(list(target.parent.iterdir()), [target])

    def test_failed_new_install_leaves_no_partial_mod(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source", Path(directory) / "mods/history"
            source.mkdir(); (source / "main.js").write_text("new")
            with patch.object(installer, "command"), self.assertRaises(RuntimeError):
                with installer.installed_revision(source, target):
                    raise RuntimeError("integration")
            self.assertFalse(target.exists())
            self.assertEqual(list(target.parent.iterdir()), [])
