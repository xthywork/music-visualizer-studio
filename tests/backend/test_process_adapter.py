from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from app.render_jobs.models import JobErrorCode
from app.render_jobs.process import ProcessAdapter, ProcessAdapterError, sanitize_stderr


def adapter(*, stderr_limit: int = 64 * 1024) -> ProcessAdapter:
    return ProcessAdapter(
        sys.executable,
        error_code=JobErrorCode.ENCODE_FAILED,
        label="test encoder",
        stderr_limit=stderr_limit,
    )


def test_argument_array_does_not_invoke_a_shell(tmp_path: Path) -> None:
    marker = tmp_path / "must-not-exist"
    hostile = f"; touch {marker}"
    output = adapter().run(["-c", "import sys; print(sys.argv[1])", hostile])
    assert output.decode().strip() == hostile
    assert not marker.exists()


def test_arguments_reject_nul_and_non_string_values() -> None:
    with pytest.raises(ValueError, match="NUL"):
        adapter().spawn(["bad\x00argument"])
    with pytest.raises(TypeError, match="strings"):
        adapter().spawn([123])  # type: ignore[list-item]


def test_failure_has_stable_code_and_redacted_bounded_diagnostic(tmp_path: Path) -> None:
    secret = tmp_path / "private" / "audio.mp3"
    process = adapter(stderr_limit=128).spawn(
        [
            "-c",
            "import sys; sys.stderr.write(('noise' * 100) + sys.argv[1]); raise SystemExit(9)",
            str(secret),
        ]
    )
    with pytest.raises(ProcessAdapterError) as captured:
        process.wait()
    assert captured.value.code == JobErrorCode.ENCODE_FAILED
    assert str(captured.value) == "test encoder exited unsuccessfully."
    assert captured.value.returncode == 9
    assert str(secret) not in captured.value.detail
    assert "<path>" in captured.value.detail
    assert len(captured.value.detail) <= 2_000


def test_sanitizer_removes_terminal_control_sequences() -> None:
    assert sanitize_stderr(b"\x1b[31mfailed\x1b[0m\x00") == "failed"


def test_spawn_owns_a_new_process_group() -> None:
    process = adapter().spawn(["-c", "import time; time.sleep(30)"])
    try:
        assert process.process.pid == __import__("os").getpgid(process.process.pid)
    finally:
        process.terminate(grace_seconds=0.05)
    assert process.process.poll() is not None


def test_run_timeout_terminates_the_process_group() -> None:
    with pytest.raises(ProcessAdapterError, match="timed out"):
        adapter().run(["-c", "import time; time.sleep(30)"], timeout=0.01)
