"""Synthetic fixtures only; tests never touch the user's histories or launch agents."""
import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("collector", Path(__file__).parents[1] / "mods/project-history/collector.py")
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class CollectorTests(unittest.TestCase):
    def database(self):
        c = sqlite3.connect(":memory:")
        c.executescript("""
        CREATE TABLE projects(id TEXT, name TEXT);
        CREATE TABLE project_roots(project_id TEXT, path TEXT, position INT);
        CREATE TABLE threads(id TEXT, name TEXT, title TEXT, cwd TEXT, project_id TEXT,
          archived INT, is_pinned INT, source TEXT, thread_source TEXT, updated_at INT, forked_from_id TEXT);
        INSERT INTO projects VALUES('alpha','Alpha'),('beta','Beta');
        INSERT INTO project_roots VALUES('alpha','/workspace/alpha',0),('beta','/workspace/beta',0);
        """)
        return c

    def add(self, c, session_id, source="vscode", kind="user", project=None, archived=0, parent=None):
        c.execute("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?)", (
            session_id, "Readable title", "Original prompt", "/workspace/alpha", project,
            archived, 0, source, kind, 123, parent))

    def test_membership_workers_archives_and_forks(self):
        with closing(self.database()) as c:
            self.add(c, "direct", project="beta")
            self.add(c, "legacy")
            self.add(c, "fork", parent="direct", archived=1)
            self.add(c, "worker", kind="subagent")
            self.add(c, "exec-job", source="exec", kind=None)
            rows, roots, limited = collector.codex_rows(c, {
                "thread-project-assignments": {"legacy": {"projectId": "old"}},
                "local-projects": {"old": {"name": "Beta"}},
            })
        self.assertEqual({r["id"] for r in rows}, {"direct", "legacy", "fork"})
        self.assertEqual(next(r for r in rows if r["id"] == "legacy")["project"], "Beta")
        self.assertEqual(next(r for r in rows if r["id"] == "direct")["project"], "Beta")
        self.assertTrue(next(r for r in rows if r["id"] == "fork")["archived"])
        self.assertEqual(next(r for r in rows if r["id"] == "fork")["parent"], "direct")
        self.assertEqual(roots["Alpha"], ["/workspace/alpha"])
        self.assertFalse(limited)

    def test_schema_rejection_does_not_modify_database(self):
        with closing(sqlite3.connect(":memory:")) as c:
            c.execute("CREATE TABLE threads(id TEXT)")
            with self.assertRaisesRegex(ValueError, "schema"):
                collector.codex_rows(c, {})
            self.assertEqual(c.execute("PRAGMA table_info(threads)").fetchall()[0][1], "id")

    def test_metadata_validation_and_dates(self):
        self.assertIsNone(collector.record("sample", "id; command", "x", "/workspace", 0))
        self.assertIsNone(collector.record("sample", "--untrusted-option", "x", "/workspace", 0))
        self.assertIsNone(collector.record("sample", "valid", "x", "relative", 0))
        self.assertEqual(collector.title("Title\nwith\x1b controls"), "Title with controls")
        self.assertEqual(collector.timestamp(1700000000000), 1700000000)
        self.assertGreater(collector.timestamp("2026-01-01T00:00:00Z"), 0)

    def test_only_explicit_fork_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / "session.jsonl"
            p.write_text(json.dumps({"payload": {"parentUuid": "message", "forked_from_id": "saved-parent"}}) + "\n")
            self.assertEqual(collector.fork_parent(p), "saved-parent")
            p.write_text(json.dumps({"payload": {"parentUuid": "message"}}) + "\n")
            self.assertIsNone(collector.fork_parent(p))

    def test_mixed_adapter_rows_keep_valid_siblings_and_export_only_known_fields(self):
        valid = {"id":"saved", "title":"Title", "cwd":"/workspace", "updated":123}
        invalid = [None, 7, [], {**valid, "project":8}, {**valid, "parent":[]},
                   {**valid, "cwd":"/workspace\0bad"}, {**valid, "updated":float("nan")},
                   {**valid, "updated":float("inf")}, {**valid, "archived":1}]
        with patch.object(collector, "run_cli", return_value=subprocess.CompletedProcess([], 0, json.dumps([
                *invalid, {**valid, "secret":"synthetic-secret"}]), "")):
            rows, _, _ = collector.command_history({"id":"sample", "history":["history"]})
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], "saved")
        self.assertNotIn("secret", rows[0])
        json.dumps(rows, allow_nan=False)

    def test_claude_ownership_requires_explicit_session_arguments(self):
        output = "\n".join(["/usr/bin/claude --resume saved", "node /tools/claude -r other",
                            "claude --session-id=third", "echo claude unrelated",
                            "claude --add-dir /workspace/other", "other --resume fourth"])
        self.assertEqual(collector.claude_process_ids(output), {"saved", "other", "third"})
        with patch.object(collector, "run_process", return_value=subprocess.CompletedProcess([], 1, "", "")):
            with self.assertRaises(RuntimeError):
                collector.running_claude_ids()

    def test_provider_failure_isolated_and_live_only_is_explicit(self):
        with patch.object(collector, "codex", side_effect=ValueError("schema changed")), \
             patch.object(collector, "claude", return_value=([collector.record("claude", "saved", "Title", "/workspace", 123)], {}, False)):
            result = collector.snapshot([
                {"id": "a", "reader": "codex", "run": ["a"], "detected": True},
                {"id": "b", "reader": "claude", "run": ["b"], "detected": True},
                {"id": "c", "run": ["c"], "detected": True},
            ])
        self.assertEqual(result["threads"][0]["provider"], "b")
        self.assertIn("error", result["providers"]["a"])
        self.assertTrue(result["providers"]["a"]["available"])
        self.assertTrue(result["providers"]["c"]["liveOnly"])

    def test_command_timeout_stops_owned_process(self):
        with self.assertRaisesRegex(RuntimeError, "subprocesses were stopped"):
            collector.run_process([sys.executable, "-c", "import time; time.sleep(10)"], 0.05)

    def test_login_shell_output_is_not_mistaken_for_history_json(self):
        completed = subprocess.CompletedProcess([], 0, "shell banner MARK[1,2]MARKterminal integration", "")
        with patch.object(collector.shutil, "which", return_value=None), \
             patch.object(collector.uuid, "uuid4") as token, \
             patch.object(collector, "run_process", return_value=completed):
            token.return_value.hex = "fixed"
            completed.stdout = completed.stdout.replace("MARK", "HERDR_HISTORY_fixed")
            self.assertEqual(json.loads(collector.run_cli(["sample", "history"]).stdout), [1, 2])

    def test_desktop_titles_forks_and_archives_merge_without_exporting_sensitive_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "account/workspace"
            root.mkdir(parents=True)
            for sid, cli, parent in [("local_parent", "parent", None), ("local_child", "child", "local_parent")]:
                (root / (sid + ".json")).write_text(json.dumps({
                    "sessionId": sid, "cliSessionId": cli, "title": "Desktop title",
                    "cwd": "/workspace", "lastActivityAt": 1700000000000, "isArchived": True,
                    "forkedFromSessionId": parent, "remoteMcpServersConfig": {"token": "synthetic-secret"},
                }))
            metadata = collector.desktop_claude_metadata(Path(temp))
        self.assertNotIn("synthetic-secret", json.dumps(metadata))
        rows = collector.merge_claude_desktop([collector.record("claude", "parent", "CLI title", "/workspace", 1)], metadata)
        self.assertEqual(len(rows), 2)
        self.assertEqual(next(r for r in rows if r["id"] == "child")["parent"], "parent")
        self.assertIn("resumeUnavailable", next(r for r in rows if r["id"] == "child"))
        self.assertTrue(next(r for r in rows if r["id"] == "parent")["archived"])
        self.assertNotIn("resumeUnavailable", next(r for r in rows if r["id"] == "parent"))


if __name__ == "__main__":
    unittest.main()
