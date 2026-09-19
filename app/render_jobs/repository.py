"""SQLite-backed durable render job repository."""

from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable, Iterator

from .models import (
    JobErrorCode,
    JobState,
    RenderConfiguration,
    TERMINAL_JOB_STATES,
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(frozen=True, slots=True)
class JobRecord:
    id: str
    configuration: RenderConfiguration
    state: JobState
    progress: float
    frame: int
    total_frames: int
    eta_seconds: float | None
    cancel_requested: bool
    worker_id: str | None
    error_code: JobErrorCode | None
    error_message: str | None
    output_relpath: str | None
    output_available: bool
    cleanup_done: bool
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


class JobRepository:
    """Owns schema migration and state transitions for one SQLite database."""

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path

    def initialize(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS schema_meta (
                    version INTEGER NOT NULL
                );
                INSERT INTO schema_meta(version)
                SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_meta);

                CREATE TABLE IF NOT EXISTS render_jobs (
                    id TEXT PRIMARY KEY,
                    config_json TEXT NOT NULL,
                    state TEXT NOT NULL CHECK (
                        state IN ('queued', 'running', 'completed', 'cancelled', 'failed', 'interrupted')
                    ),
                    progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
                    frame INTEGER NOT NULL DEFAULT 0 CHECK (frame >= 0),
                    total_frames INTEGER NOT NULL DEFAULT 0 CHECK (total_frames >= 0),
                    eta_seconds REAL,
                    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
                    worker_id TEXT,
                    error_code TEXT,
                    error_message TEXT,
                    output_relpath TEXT,
                    output_available INTEGER NOT NULL DEFAULT 0 CHECK (output_available IN (0, 1)),
                    cleanup_done INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_done IN (0, 1)),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_render_jobs_queue
                    ON render_jobs(state, created_at, id);
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.database_path,
            timeout=5,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def create_job(
        self,
        configuration: RenderConfiguration,
        *,
        job_id: str | None = None,
    ) -> JobRecord:
        identifier = str(uuid.UUID(job_id)) if job_id else str(uuid.uuid4())
        timestamp = _now()
        config_json = json.dumps(
            configuration.model_dump(mode="json", by_alias=True),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    """
                    INSERT INTO render_jobs(
                        id, config_json, state, created_at, updated_at
                    ) VALUES (?, ?, 'queued', ?, ?)
                    """,
                    (identifier, config_json, timestamp, timestamp),
                )
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        return self.require(identifier)

    def get(self, job_id: str) -> JobRecord | None:
        try:
            identifier = str(uuid.UUID(job_id))
        except (ValueError, AttributeError):
            return None
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM render_jobs WHERE id = ?", (identifier,)
            ).fetchone()
        return _record(row) if row else None

    def require(self, job_id: str) -> JobRecord:
        record = self.get(job_id)
        if record is None:
            raise KeyError(job_id)
        return record

    def iter_jobs(self) -> Iterator[JobRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM render_jobs ORDER BY created_at, id"
            ).fetchall()
        yield from (_record(row) for row in rows)

    def count_active(self) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS count FROM render_jobs WHERE state IN ('queued', 'running')"
            ).fetchone()
        return int(row["count"])

    def claim_next(self, worker_id: str) -> JobRecord | None:
        timestamp = _now()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute(
                    """
                    SELECT id FROM render_jobs
                    WHERE state = 'queued' AND cancel_requested = 0
                    ORDER BY created_at, id LIMIT 1
                    """
                ).fetchone()
                if row is None:
                    connection.commit()
                    return None
                cursor = connection.execute(
                    """
                    UPDATE render_jobs
                    SET state = 'running', worker_id = ?, started_at = ?, updated_at = ?
                    WHERE id = ? AND state = 'queued' AND cancel_requested = 0
                    """,
                    (worker_id, timestamp, timestamp, row["id"]),
                )
                connection.commit()
                if cursor.rowcount != 1:
                    return None
            except BaseException:
                connection.rollback()
                raise
        return self.require(row["id"])

    def update_progress(
        self,
        job_id: str,
        worker_id: str,
        *,
        frame: int,
        total_frames: int,
        eta_seconds: float | None,
    ) -> bool:
        if frame < 0 or total_frames < 0 or frame > total_frames:
            raise ValueError("invalid frame progress")
        progress = frame / total_frames if total_frames else 0.0
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE render_jobs
                SET progress = ?, frame = ?, total_frames = ?, eta_seconds = ?, updated_at = ?
                WHERE id = ? AND state = 'running' AND worker_id = ?
                """,
                (progress, frame, total_frames, eta_seconds, _now(), job_id, worker_id),
            )
        return cursor.rowcount == 1

    def request_cancel(self, job_id: str) -> JobRecord | None:
        record = self.get(job_id)
        if record is None or record.state in TERMINAL_JOB_STATES:
            return record
        timestamp = _now()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                if record.state == JobState.QUEUED:
                    connection.execute(
                        """
                        UPDATE render_jobs
                        SET state = 'cancelled', cancel_requested = 1,
                            error_code = ?, error_message = ?, updated_at = ?, completed_at = ?
                        WHERE id = ? AND state = 'queued'
                        """,
                        (
                            JobErrorCode.CANCELLED.value,
                            "Render cancelled before it started.",
                            timestamp,
                            timestamp,
                            job_id,
                        ),
                    )
                else:
                    connection.execute(
                        """
                        UPDATE render_jobs SET cancel_requested = 1, updated_at = ?
                        WHERE id = ? AND state = 'running'
                        """,
                        (timestamp, job_id),
                    )
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        return self.get(job_id)

    def is_cancel_requested(self, job_id: str, worker_id: str) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT cancel_requested FROM render_jobs
                WHERE id = ? AND state = 'running' AND worker_id = ?
                """,
                (job_id, worker_id),
            ).fetchone()
        return row is None or bool(row["cancel_requested"])

    def finish(
        self,
        job_id: str,
        worker_id: str,
        state: JobState,
        *,
        error_code: JobErrorCode | None = None,
        error_message: str | None = None,
        output_relpath: str | None = None,
    ) -> bool:
        if state not in TERMINAL_JOB_STATES:
            raise ValueError("finish requires a terminal state")
        if state == JobState.COMPLETED and not output_relpath:
            raise ValueError("completed jobs require an output path")
        timestamp = _now()
        output_available = int(state == JobState.COMPLETED)
        progress = 1.0 if state == JobState.COMPLETED else None
        cancellation_clause = "" if state == JobState.CANCELLED else "AND cancel_requested = 0"
        with self._connect() as connection:
            cursor = connection.execute(
                f"""
                UPDATE render_jobs
                SET state = ?,
                    progress = COALESCE(?, progress),
                    eta_seconds = NULL,
                    error_code = ?, error_message = ?,
                    output_relpath = ?, output_available = ?,
                    updated_at = ?, completed_at = ?
                WHERE id = ? AND state = 'running' AND worker_id = ?
                  {cancellation_clause}
                """,
                (
                    state.value,
                    progress,
                    error_code.value if error_code else None,
                    error_message,
                    output_relpath,
                    output_available,
                    timestamp,
                    timestamp,
                    job_id,
                    worker_id,
                ),
            )
        return cursor.rowcount == 1

    def recover_orphaned_running(self) -> int:
        timestamp = _now()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE render_jobs
                SET state = 'interrupted', worker_id = NULL,
                    error_code = ?, error_message = ?, output_available = 0,
                    updated_at = ?, completed_at = ?
                WHERE state = 'running'
                """,
                (
                    JobErrorCode.INTERRUPTED.value,
                    "Render worker stopped before completion.",
                    timestamp,
                    timestamp,
                ),
            )
        return cursor.rowcount

    def reconcile_completed_outputs(self, exists: Callable[[str], bool]) -> int:
        changed = 0
        for record in self.iter_jobs():
            if (
                record.state == JobState.COMPLETED
                and record.output_available
                and (not record.output_relpath or not exists(record.output_relpath))
            ):
                with self._connect() as connection:
                    cursor = connection.execute(
                        """
                        UPDATE render_jobs SET output_available = 0, updated_at = ?
                        WHERE id = ? AND state = 'completed' AND output_available = 1
                        """,
                        (_now(), record.id),
                    )
                changed += cursor.rowcount
        return changed

    def mark_cleanup_done(self, job_id: str) -> bool:
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE render_jobs SET cleanup_done = 1, updated_at = ?
                WHERE id = ? AND state IN ('completed', 'cancelled', 'failed', 'interrupted')
                  AND cleanup_done = 0
                """,
                (_now(), job_id),
            )
        return cursor.rowcount == 1

    def mark_output_unavailable(self, job_id: str) -> bool:
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE render_jobs
                SET output_available = 0, updated_at = ?
                WHERE id = ? AND state = 'completed' AND output_available = 1
                """,
                (_now(), job_id),
            )
        return cursor.rowcount == 1

    def delete_terminal(self, job_id: str) -> bool:
        with self._connect() as connection:
            cursor = connection.execute(
                """
                DELETE FROM render_jobs
                WHERE id = ? AND state IN ('completed', 'cancelled', 'failed', 'interrupted')
                """,
                (job_id,),
            )
        return cursor.rowcount == 1


def _parse_datetime(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def _record(row: sqlite3.Row) -> JobRecord:
    error_code = JobErrorCode(row["error_code"]) if row["error_code"] else None
    return JobRecord(
        id=row["id"],
        configuration=RenderConfiguration.model_validate_json(row["config_json"]),
        state=JobState(row["state"]),
        progress=float(row["progress"]),
        frame=int(row["frame"]),
        total_frames=int(row["total_frames"]),
        eta_seconds=float(row["eta_seconds"]) if row["eta_seconds"] is not None else None,
        cancel_requested=bool(row["cancel_requested"]),
        worker_id=row["worker_id"],
        error_code=error_code,
        error_message=row["error_message"],
        output_relpath=row["output_relpath"],
        output_available=bool(row["output_available"]),
        cleanup_done=bool(row["cleanup_done"]),
        created_at=_parse_datetime(row["created_at"]),
        updated_at=_parse_datetime(row["updated_at"]),
        started_at=_parse_datetime(row["started_at"]),
        completed_at=_parse_datetime(row["completed_at"]),
    )
