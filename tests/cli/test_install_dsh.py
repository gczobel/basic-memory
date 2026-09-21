"""DSH installer coverage: the row mount and the `bm install dsh` plan."""

import json
import os
from pathlib import Path

import pytest
import yaml
from typer.testing import CliRunner

from basic_memory.cli.commands.install import (
    DSH_PACKAGE,
    DSH_ROW_MARKER,
    InstallError,
    dsh_profile_patch,
    dsh_row_block,
    dsh_row_name,
    mount_dsh_row,
)
from basic_memory.cli.main import app

runner = CliRunner()


@pytest.fixture(autouse=True)
def isolated_dsh_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Keep the installer out of the developer's real ~/.dsh."""
    home = tmp_path / "dsh-home"
    home.mkdir()
    monkeypatch.setenv("DSH_HOME", str(home))
    return home


def fake_dsh(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A `dsh` on PATH that records its argv instead of running pnpm."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    marker = tmp_path / "dsh-argv"
    script = bin_dir / "dsh"
    script.write_text(f'#!/bin/sh\necho "$@" >> "{marker}"\n', encoding="utf-8")
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    return marker


# --- The row mount ---


def test_mount_creates_the_patch_with_a_valid_row(tmp_path: Path) -> None:
    patch = tmp_path / "cordis.patch.yml"

    assert mount_dsh_row(patch) is True

    # The row is what DSH reads, so prove it parses and says what we intend.
    assert yaml.safe_load(patch.read_text(encoding="utf-8")) == [
        {"insert": [{"id": "basic-memory", "name": DSH_PACKAGE}]}
    ]


def test_mount_is_idempotent(tmp_path: Path) -> None:
    patch = tmp_path / "cordis.patch.yml"
    mount_dsh_row(patch)
    first = patch.read_text(encoding="utf-8")

    assert mount_dsh_row(patch) is False
    assert patch.read_text(encoding="utf-8") == first


def test_mount_preserves_what_the_user_wrote(tmp_path: Path) -> None:
    patch = tmp_path / "cordis.patch.yml"
    existing = "# my own MCP server\n- insert:\n    - id: mcp-calibre\n      name: '@deepseek-ai/dsh-mcp-client'\n"
    patch.write_text(existing, encoding="utf-8")

    mount_dsh_row(patch)

    text = patch.read_text(encoding="utf-8")
    assert text.startswith(existing)  # untouched, byte for byte
    assert DSH_ROW_MARKER in text
    entries = yaml.safe_load(text)
    assert [entry["insert"][0]["id"] for entry in entries] == ["mcp-calibre", "basic-memory"]


def test_mount_creates_missing_directories(tmp_path: Path) -> None:
    patch = tmp_path / "profiles" / "web" / "cordis.patch.yml"

    assert mount_dsh_row(patch) is True

    assert patch.is_file()


def test_mount_replaces_the_empty_patch_placeholder(tmp_path: Path) -> None:
    """An untouched profile patch is the empty-array template, and `[]` is a
    complete YAML document: a block sequence appended after it makes the file
    unparseable, so the profile fails to boot. DSH's own template goes in here."""
    patch = tmp_path / "cordis.patch.yml"
    patch.write_text(
        "# Your patch layer for this dsh profile, applied after every bundle layer:\n"
        "# a top-level YAML array of loader patch entries (id-targeted config\n"
        "# overrides, disables, and insert lists; `!!js` expressions allowed).\n"
        "[]\n",
        encoding="utf-8",
    )

    assert mount_dsh_row(patch) is True

    text = patch.read_text(encoding="utf-8")
    assert text.startswith("# Your patch layer")  # the guidance survives
    assert yaml.safe_load(text) == [{"insert": [{"id": "basic-memory", "name": DSH_PACKAGE}]}]


def test_row_block_names_the_configured_package() -> None:
    assert "'@example/other-plugin'" in dsh_row_block("@example/other-plugin")


def test_row_name_uses_the_package_name_for_a_directory(tmp_path: Path) -> None:
    """The loader imports the row's `name`, so a directory install must be mounted
    by the package name. A directory path fails the whole profile at boot with
    ERR_UNSUPPORTED_DIR_IMPORT."""
    plugin = tmp_path / "plugin"
    plugin.mkdir()
    (plugin / "package.json").write_text(
        json.dumps({"name": "@example/dir-plugin", "main": "./dist/index.js"}), encoding="utf-8"
    )

    assert dsh_row_name(str(plugin)) == "@example/dir-plugin"


def test_row_name_passes_a_package_specifier_through() -> None:
    assert dsh_row_name("@example/registry-plugin") == "@example/registry-plugin"


def test_row_name_rejects_a_directory_without_a_manifest(tmp_path: Path) -> None:
    plugin = tmp_path / "plugin"
    plugin.mkdir()

    with pytest.raises(InstallError, match="no readable package.json"):
        dsh_row_name(str(plugin))


def test_install_mounts_the_package_name_not_the_path(
    tmp_path: Path, isolated_dsh_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A local install must still produce a row the loader can import."""
    fake_dsh(tmp_path, monkeypatch)
    plugin = tmp_path / "plugin"
    plugin.mkdir()
    (plugin / "package.json").write_text(
        json.dumps({"name": "@example/dir-plugin", "main": "./dist/index.js"}), encoding="utf-8"
    )

    result = runner.invoke(app, ["install", "dsh", "--package", str(plugin), "--yes"])

    assert result.exit_code == 0
    patch = dsh_profile_patch("web").read_text(encoding="utf-8")
    assert yaml.safe_load(patch) == [{"insert": [{"id": "basic-memory", "name": "@example/dir-plugin"}]}]


# --- The command ---


def test_profile_patch_follows_dsh_home(isolated_dsh_home: Path) -> None:
    assert dsh_profile_patch("web") == isolated_dsh_home / "profiles" / "web" / "cordis.patch.yml"


def test_dry_run_writes_nothing_and_shows_the_mount(isolated_dsh_home: Path) -> None:
    result = runner.invoke(app, ["install", "dsh", "--dry-run"])

    assert result.exit_code == 0
    assert "dsh plugin --profile web add" in result.stdout
    assert "would mount the plugin row" in result.stdout
    assert not dsh_profile_patch("web").exists()


def test_install_runs_the_host_cli_and_mounts_the_row(
    tmp_path: Path, isolated_dsh_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    argv = fake_dsh(tmp_path, monkeypatch)

    result = runner.invoke(app, ["install", "dsh", "--yes"])

    assert result.exit_code == 0
    assert argv.read_text(encoding="utf-8").strip() == f"plugin --profile web add {DSH_PACKAGE}"
    assert "mounted:" in result.stdout
    assert dsh_profile_patch("web").is_file()


def test_install_is_repeatable(tmp_path: Path, isolated_dsh_home: Path, monkeypatch) -> None:
    fake_dsh(tmp_path, monkeypatch)
    runner.invoke(app, ["install", "dsh", "--yes"])
    first = dsh_profile_patch("web").read_text(encoding="utf-8")

    result = runner.invoke(app, ["install", "dsh", "--yes"])

    assert result.exit_code == 0
    assert "already mounted:" in result.stdout
    assert dsh_profile_patch("web").read_text(encoding="utf-8") == first


def test_install_honours_a_named_profile(
    tmp_path: Path, isolated_dsh_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    argv = fake_dsh(tmp_path, monkeypatch)

    result = runner.invoke(app, ["install", "dsh", "--profile", "tui", "--yes"])

    assert result.exit_code == 0
    assert "--profile tui" in argv.read_text(encoding="utf-8")
    assert dsh_profile_patch("tui").is_file()


def test_missing_host_cli_fails_before_mounting(
    tmp_path: Path, isolated_dsh_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # An empty PATH, not a prepended one: a real `dsh` on the developer's machine
    # would otherwise be found and run.
    empty = tmp_path / "empty-bin"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))

    result = runner.invoke(app, ["install", "dsh", "--yes"])

    assert result.exit_code == 1
    assert not dsh_profile_patch("web").exists()
