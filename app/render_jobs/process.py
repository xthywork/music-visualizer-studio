"""Safe subprocess ownership for FFmpeg and ffprobe.

Commands are always passed as argument arrays and every spawned process owns a
new process group.  Stderr is drained concurrently into a bounded tail so a
chatty child cannot deadlock the worker or grow memory without limit.
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from .models import JobErrorCode


_ANSI_ESCAPE = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class ProcessAdapterError(RuntimeError):
    """Stable worker error with bounded, path-redacted diagnostic detail."""

    def __init__(
        self,
        code: JobErrorCode,
        message: str,
        *,
        detail: str = "",
        returncode: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.detail = detail
        self.returncode = returncode


class _BoundedTail:
    def __init__(self, limit: int) -> None:
        self.limit = max(1, limit)
        self._chunks: deque[bytes] = deque()
        self._size = 0
        self._lock = threading.Lock()

    def append(self, chunk: bytes) -> None:
        if not chunk:
            return
        with self._lock:
            if len(chunk) >= self.limit:
                self._chunks.clear()
                self._chunks.append(chunk[-self.limit :])
                self._size = self.limit
                return
            self._chunks.append(chunk)
            self._size += len(chunk)
            while self._size > self.limit and self._chunks:
                removed = self._chunks.popleft()
                self._size -= len(removed)

    def value(self) -> bytes:
        with self._lock:
            return b"".join(self._chunks)[-self.limit :]


def sanitize_stderr(
    value: bytes,
    *,
    redactions: Sequence[str] = (),
    character_limit: int = 2_000,
) -> str:
    """Return readable diagnostics without control codes or submitted paths."""

    cleaned = _ANSI_ESCAPE.sub(b"", value).decode("utf-8", "replace")
    cleaned = _CONTROL.sub("", cleaned)
    for sensitive in sorted({item for item in redactions if item}, key=len, reverse=True):
        cleaned = cleaned.replace(sensitive, "<path>")
    lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
    return "\n".join(lines)[-max(1, character_limit) :]


def _validate_arguments(binary: str, arguments: Sequence[str]) -> tuple[str, ...]:
    if not isinstance(binary, str) or not binary or "\x00" in binary:
        raise ValueError("process binary must be a non-empty string without NUL")
    normalized: list[str] = [binary]
    for argument in arguments:
        if not isinstance(argument, str):
            raise TypeError("process arguments must be strings")
        if "\x00" in argument:
            raise ValueError("process arguments must not contain NUL")
        normalized.append(argument)
    return tuple(normalized)


def _path_redactions(command: Sequence[str]) -> tuple[str, ...]:
    values: list[str] = []
    for value in command[1:]:
        if value.startswith("pipe:") or value == "-":
            continue
        path = Path(value)
        if path.is_absolute() or "/" in value or "\\" in value:
            values.append(value)
    return tuple(values)


@dataclass(slots=True)
class ManagedProcess:
    process: subprocess.Popen[bytes]
    command: tuple[str, ...]
    error_code: JobErrorCode
    label: str
    stderr_tail: _BoundedTail
    stderr_thread: threading.Thread | None

    def wait(self, *, timeout: float | None = None, check: bool = True) -> int:
        try:
            returncode = self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            raise ProcessAdapterError(
                self.error_code,
                f"{self.label} timed out.",
                detail=self.diagnostic,
            ) from error
        finally:
            if self.stderr_thread is not None and self.process.poll() is not None:
                self.stderr_thread.join(timeout=1)
        if check and returncode != 0:
            raise ProcessAdapterError(
                self.error_code,
                f"{self.label} exited unsuccessfully.",
                detail=self.diagnostic,
                returncode=returncode,
            )
        return returncode

    @property
    def diagnostic(self) -> str:
        return sanitize_stderr(
            self.stderr_tail.value(), redactions=_path_redactions(self.command)
        )

    def terminate(self, *, grace_seconds: float = 3) -> None:
        """Terminate the owned process group, then kill it after the grace period."""

        if self.process.poll() is not None:
            if self.stderr_thread is not None:
                self.stderr_thread.join(timeout=1)
            return
        try:
            if os.name == "posix":
                os.killpg(self.process.pid, signal.SIGTERM)
            else:  # pragma: no cover - production is Ubuntu
                self.process.terminate()
            self.process.wait(timeout=grace_seconds)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            if self.process.poll() is None:
                try:
                    if os.name == "posix":
                        os.killpg(self.process.pid, signal.SIGKILL)
                    else:  # pragma: no cover - production is Ubuntu
                        self.process.kill()
                except ProcessLookupError:
                    pass
                self.process.wait()
        finally:
            if self.stderr_thread is not None:
                self.stderr_thread.join(timeout=1)


class ProcessAdapter:
    """Construct and own one family of child processes without a shell."""

    def __init__(
        self,
        binary: str,
        *,
        error_code: JobErrorCode,
        label: str,
        stderr_limit: int = 64 * 1024,
    ) -> None:
        self.binary = binary
        self.error_code = error_code
        self.label = label
        self.stderr_limit = stderr_limit

    def spawn(
        self,
        arguments: Sequence[str],
        *,
        stdin: int | BinaryIO | None = subprocess.DEVNULL,
        stdout: int | BinaryIO | None = subprocess.DEVNULL,
    ) -> ManagedProcess:
        command = _validate_arguments(self.binary, arguments)
        try:
            process = subprocess.Popen(
                command,
                stdin=stdin,
                stdout=stdout,
                stderr=subprocess.PIPE,
                shell=False,
                start_new_session=True,
            )
        except OSError as error:
            raise ProcessAdapterError(
                self.error_code,
                f"{self.label} could not start.",
            ) from error
        tail = _BoundedTail(self.stderr_limit)
        thread: threading.Thread | None = None
        if process.stderr is not None:
            thread = threading.Thread(
                target=_drain_stream,
                args=(process.stderr, tail),
                name=f"{self.label}-stderr",
                daemon=True,
            )
            thread.start()
        return ManagedProcess(
            process=process,
            command=command,
            error_code=self.error_code,
            label=self.label,
            stderr_tail=tail,
            stderr_thread=thread,
        )

    def run(
        self,
        arguments: Sequence[str],
        *,
        timeout: float | None = None,
        stdout: int | BinaryIO | None = subprocess.PIPE,
        cancelled: Callable[[], bool] | None = None,
    ) -> bytes:
        managed = self.spawn(arguments, stdout=stdout)
        output: list[bytes] = []
        output_thread: threading.Thread | None = None
        if managed.process.stdout is not None:
            output_thread = threading.Thread(
                target=_collect_stream,
                args=(managed.process.stdout, output),
                name=f"{self.label}-stdout",
                daemon=True,
            )
            output_thread.start()
        deadline = time.monotonic() + timeout if timeout is not None else None
        while managed.process.poll() is None:
            if cancelled is not None and cancelled():
                managed.terminate()
                raise ProcessAdapterError(
                    self.error_code, f"{self.label} was cancelled."
                )
            if deadline is not None and time.monotonic() >= deadline:
                managed.terminate()
                raise ProcessAdapterError(
                    self.error_code,
                    f"{self.label} timed out.",
                    detail=managed.diagnostic,
                )
            time.sleep(0.05)
        managed.wait()
        if output_thread is not None:
            output_thread.join(timeout=1)
        return b"".join(output)


def _drain_stream(stream: BinaryIO, tail: _BoundedTail) -> None:
    try:
        while chunk := stream.read(8_192):
            tail.append(chunk)
    finally:
        stream.close()


def _collect_stream(stream: BinaryIO, output: list[bytes]) -> None:
    try:
        while chunk := stream.read(8_192):
            output.append(chunk)
    finally:
        stream.close()
