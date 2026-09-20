"""DSH harness hook coverage: settings resolution, the brief, and the
post-compaction checkpoint path.

The DSH integration owns its own installation, so these tests also pin the
refusal that keeps ``bm hook install`` from writing a second, divergent wiring.
"""

import json
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from typer.testing import CliRunner

from basic_memory.cli.commands.hook import PROFILES, Harness, load_dsh_settings
from basic_memory.cli.main import app

runner = CliRunner()

SKILL_PATH = (
    Path(__file__).parents[2] / "integrations" / "dsh" / "skills" / "bm-checkpoint" / "SKILL.md"
)


def write_config(root: Path, payload: object) -> None:
    config = root / ".dsh" / "basic-memory.json"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(json.dumps(payload), encoding="utf-8")


@pytest.fixture(autouse=True)
def isolated_dsh_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Keep user-level DSH settings out of the developer's real ~/.dsh."""
    home = tmp_path / "dsh-home"
    home.mkdir()
    monkeypatch.setenv("DSH_HOME", str(home))
    return home


def invoke(verb: str, project_dir: Path, payload: dict[str, object]) -> object:
    return runner.invoke(
        app,
        ["hook", verb, "--harness", "dsh", "--project-dir", str(project_dir)],
        input=json.dumps(payload),
    )


# --- Skill and profile must agree ---


def test_dsh_skill_writes_the_note_types_the_brief_recalls() -> None:
    """The bundled skill is the only DSH checkpoint author, so its note types must
    match what the profile recalls. Otherwise the brief's "where you left off"
    section is empty for every DSH session."""
    skill = SKILL_PATH.read_text(encoding="utf-8")
    profile = PROFILES[Harness.dsh]

    assert f"`{profile.session_note_type}`" in skill
    assert f"`{profile.coding_session_note_type}`" in skill


# --- Settings resolution ---


def test_dsh_project_config_routes_the_brief(tmp_path: Path) -> None:
    write_config(tmp_path, {"project": "team/notes"})

    with patch("basic_memory.mcp.tools.search_notes", new_callable=AsyncMock) as search:
        search.return_value = {"results": []}
        result = invoke("session-start", tmp_path, {"session_id": "s1", "cwd": str(tmp_path)})

    assert result.exit_code == 0
    assert "**Project:** team/notes" in result.stdout


def test_dsh_user_config_is_the_fallback(
    tmp_path: Path, isolated_dsh_home: Path
) -> None:
    (isolated_dsh_home / "basic-memory.json").write_text(
        json.dumps({"project": "user-default"}), encoding="utf-8"
    )

    with patch("basic_memory.mcp.tools.search_notes", new_callable=AsyncMock) as search:
        search.return_value = {"results": []}
        result = invoke("session-start", tmp_path, {"session_id": "s1", "cwd": str(tmp_path)})

    assert result.exit_code == 0
    assert "**Project:** user-default" in result.stdout


def test_dsh_project_config_overrides_user_config(
    tmp_path: Path, isolated_dsh_home: Path
) -> None:
    (isolated_dsh_home / "basic-memory.json").write_text(
        json.dumps({"project": "user-default"}), encoding="utf-8"
    )
    write_config(tmp_path, {"projectId": "workspace-project"})

    with patch("basic_memory.mcp.tools.search_notes", new_callable=AsyncMock) as search:
        search.return_value = {"results": []}
        result = invoke("session-start", tmp_path, {"session_id": "s1", "cwd": str(tmp_path)})

    assert result.exit_code == 0
    assert "**Project:** workspace-project" in result.stdout


def test_dsh_malformed_config_disables_capture(tmp_path: Path) -> None:
    """An unreadable config must fail closed: no route, and no capture."""
    config = tmp_path / ".dsh" / "basic-memory.json"
    config.parent.mkdir(parents=True)
    config.write_text("{not json", encoding="utf-8")

    cfg, configured = load_dsh_settings(tmp_path)

    assert configured is True
    assert cfg["captureEvents"] is False
    assert cfg["primaryProject"] == ""


def test_dsh_malformed_config_still_serves_a_brief(tmp_path: Path) -> None:
    """Fail-closed governs routing and capture, not the session: a broken config
    must not leave the model with nothing."""
    config = tmp_path / ".dsh" / "basic-memory.json"
    config.parent.mkdir(parents=True)
    config.write_text("{not json", encoding="utf-8")

    with patch("basic_memory.mcp.tools.search_notes", new_callable=AsyncMock) as search:
        search.return_value = {"results": []}
        result = invoke("session-start", tmp_path, {"session_id": "s1", "cwd": str(tmp_path)})

    assert result.exit_code == 0
    assert "# Basic Memory" in result.stdout


# --- Per-turn capture ---
#
# The settled path must write and the compaction path must not. Each test is what
# gives the other its teeth: alone, either one passes against a core that ignores
# the trigger entirely.


TURNS = [
    {
        "role": "user",
        "text": "Preserve this decision about how the fence length is chosen, and why the "
        "content is capped before the closing fence is emitted.",
    },
    {
        "role": "assistant",
        "text": "Recorded: the fence is one backtick longer than the longest run in the "
        "content, and the data is capped first so a slice cannot reopen it.",
    },
]


def capture(tmp_path: Path, payload: dict[str, object]) -> AsyncMock:
    """Drive one capture and return the patched writer."""
    write = AsyncMock(return_value={"permalink": "dsh-session/abc"})
    with patch("basic_memory.mcp.tools.write_note", write):
        result = invoke("pre-compact", tmp_path, {"cwd": str(tmp_path), **payload})
    assert result.exit_code == 0
    return write


def test_dsh_settled_capture_writes_one_note(tmp_path: Path) -> None:
    write_config(tmp_path, {"project": "team/notes"})

    write = capture(
        tmp_path, {"session_id": "session-a", "trigger": "settled", "turns": TURNS}
    )

    assert write.await_count == 1
    kwargs = write.await_args.kwargs
    assert kwargs["note_type"] == "dsh_session"
    assert kwargs["directory"] == "dsh/sessions"
    assert kwargs["overwrite"] is True
    assert kwargs["tags"] == ["dsh", "auto-capture"]


def test_dsh_compaction_capture_writes_no_note(tmp_path: Path) -> None:
    """DSH does not await the observer, so nothing may be written here."""
    write_config(tmp_path, {"project": "team/notes"})

    write = capture(
        tmp_path, {"session_id": "session-a", "trigger": "pressure", "turns": TURNS}
    )

    write.assert_not_awaited()


def test_dsh_captures_in_one_session_share_a_title(tmp_path: Path) -> None:
    """A session has one running note. A fresh title per capture would leave a
    trail of fragments instead of the session's story."""
    write_config(tmp_path, {"project": "team/notes"})
    write = AsyncMock(return_value={"permalink": "p"})
    with patch("basic_memory.mcp.tools.write_note", write):
        for turns in (
            TURNS,
            [
                *TURNS,
                {
                    "role": "user",
                    "text": "And one more thing: record that the closing fence is emitted "
                    "after the data is capped, so a slice cannot reopen it.",
                },
            ],
        ):
            invoke(
                "pre-compact",
                tmp_path,
                {
                    "session_id": "session-a",
                    "trigger": "settled",
                    "cwd": str(tmp_path),
                    "turns": turns,
                },
            )

    titles = [call.kwargs["title"] for call in write.await_args_list]
    assert len(titles) == 2
    assert titles[0] == titles[1]


def test_dsh_captures_in_different_sessions_do_not_share_a_title(tmp_path: Path) -> None:
    write_config(tmp_path, {"project": "team/notes"})
    write = AsyncMock(return_value={"permalink": "p"})
    with patch("basic_memory.mcp.tools.write_note", write):
        for session_id in ("session-a", "session-b"):
            invoke(
                "pre-compact",
                tmp_path,
                {
                    "session_id": session_id,
                    "trigger": "settled",
                    "cwd": str(tmp_path),
                    "turns": TURNS,
                },
            )

    titles = [call.kwargs["title"] for call in write.await_args_list]
    assert titles[0] != titles[1]


def test_dsh_capture_below_the_floor_writes_nothing(tmp_path: Path) -> None:
    """A turn that says almost nothing buys no spawn and no rewrite."""
    write_config(tmp_path, {"project": "team/notes"})

    write = capture(
        tmp_path,
        {"session_id": "session-a", "trigger": "settled", "turns": [{"role": "user", "text": "hi"}]},
    )

    write.assert_not_awaited()


def test_dsh_capture_skips_a_trivial_turn_in_a_substantial_session(tmp_path: Path) -> None:
    """The floor judges the turn that just settled, not the session's total.

    Summing the whole conversation would make the gate inert after the first turn:
    "ok" as a follow-up in a long session would still capture.
    """
    write_config(tmp_path, {"project": "team/notes"})

    write = capture(
        tmp_path,
        {
            "session_id": "session-a",
            "trigger": "settled",
            "turns": [*TURNS, {"role": "user", "text": "ok"}],
        },
    )

    write.assert_not_awaited()


def test_dsh_capture_preserves_the_session_start(tmp_path: Path) -> None:
    """A rewritten note must not report its last capture as the session's start."""
    write_config(tmp_path, {"project": "team/notes"})

    write = capture(
        tmp_path,
        {
            "session_id": "session-a",
            "trigger": "settled",
            "turns": TURNS,
            "started": "2026-01-02T03:04:05+00:00",
        },
    )

    metadata = write.await_args.kwargs["metadata"]
    assert metadata["started"] == "2026-01-02T03:04:05+00:00"


def test_dsh_settled_capture_records_no_compaction_envelope(tmp_path: Path) -> None:
    """The WAL's v0 vocabulary maps 1:1 onto harness hooks, and a settled turn is
    not a compaction. Recording one as `compaction_imminent` would make it lie."""
    write_config(tmp_path, {"project": "team/notes"})

    with patch("basic_memory.cli.commands.hook._capture_envelope") as envelope:
        capture(tmp_path, {"session_id": "session-a", "trigger": "settled", "turns": TURNS})
        assert envelope.call_count == 0, "a turn is not a compaction"

        capture(tmp_path, {"session_id": "session-a", "trigger": "pressure", "turns": TURNS})
        assert envelope.call_count == 1, "a real compaction is still traced"


def test_dsh_capture_below_a_configured_floor_writes_nothing(tmp_path: Path) -> None:
    write_config(tmp_path, {"project": "team/notes", "captureMinChars": 500})

    write = capture(
        tmp_path, {"session_id": "session-a", "trigger": "settled", "turns": TURNS}
    )

    write.assert_not_awaited()


def test_dsh_coding_profile_captures_a_coding_session(tmp_path: Path) -> None:
    # The coding profile refuses without proven git identity, so prove it.
    def git(*args: str) -> None:
        subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)

    git("init", "-q")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    (tmp_path / "README.md").write_text("x", encoding="utf-8")
    git("add", "README.md")
    git("commit", "-qm", "initial")

    write_config(
        tmp_path,
        {"project": "team/notes", "sessionProfile": "coding", "repository": "acme/app"},
    )

    write = capture(
        tmp_path, {"session_id": "session-a", "trigger": "settled", "turns": TURNS}
    )

    assert write.await_args.kwargs["note_type"] == "coding_session"
    assert write.await_args.kwargs["metadata"]["repository"] == "acme/app"


# --- Post-compaction checkpoint prompting ---


def test_dsh_post_compaction_brief_requests_a_checkpoint(tmp_path: Path) -> None:
    write_config(tmp_path, {"project": "team/notes"})

    with patch("basic_memory.mcp.tools.search_notes", new_callable=AsyncMock) as search:
        search.return_value = {"results": []}
        result = invoke(
            "session-start",
            tmp_path,
            {"session_id": "s1", "trigger": "compact", "cwd": str(tmp_path)},
        )

    assert result.exit_code == 0
    assert "Basic Memory checkpoint required after compaction" in result.stdout
    assert "bm-checkpoint" in result.stdout


def test_dsh_checkpoint_on_compact_false_suppresses_the_prompt(tmp_path: Path) -> None:
    write_config(tmp_path, {"project": "team/notes", "checkpointOnCompact": False})

    with patch("basic_memory.mcp.tools.search_notes", new_callable=AsyncMock) as search:
        search.return_value = {"results": []}
        result = invoke(
            "session-start",
            tmp_path,
            {"session_id": "s1", "trigger": "compact", "cwd": str(tmp_path)},
        )

    assert result.exit_code == 0
    assert "Basic Memory checkpoint required after compaction" not in result.stdout


def test_dsh_startup_brief_does_not_request_a_checkpoint(tmp_path: Path) -> None:
    write_config(tmp_path, {"project": "team/notes"})

    with patch("basic_memory.mcp.tools.search_notes", new_callable=AsyncMock) as search:
        search.return_value = {"results": []}
        result = invoke(
            "session-start",
            tmp_path,
            {"session_id": "s1", "trigger": "startup", "cwd": str(tmp_path)},
        )

    assert result.exit_code == 0
    assert "Basic Memory checkpoint required after compaction" not in result.stdout


# --- Installation ownership ---


@pytest.mark.parametrize("harness", ["pi", "dsh"])
def test_hook_install_refuses_package_owned_harness(harness: str) -> None:
    result = runner.invoke(app, ["hook", "install", "--harness", harness])

    assert result.exit_code == 1
    assert "owned by" in result.output
    assert f"not `bm hook install`" in result.output


@pytest.mark.parametrize("harness", ["pi", "dsh"])
def test_hook_remove_refuses_package_owned_harness(harness: str) -> None:
    result = runner.invoke(app, ["hook", "remove", "--harness", harness])

    assert result.exit_code == 1
    assert "owned by" in result.output
    assert f"not `bm hook remove`" in result.output
