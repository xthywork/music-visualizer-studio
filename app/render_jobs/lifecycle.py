"""Coordinates database records with filesystem cleanup and deletion."""

from __future__ import annotations

from .models import JobState, TERMINAL_JOB_STATES
from .repository import JobRecord, JobRepository
from .storage import JobStorage


class JobLifecycle:
    def __init__(self, repository: JobRepository, storage: JobStorage) -> None:
        self.repository = repository
        self.storage = storage

    def cleanup_terminal(self, job_id: str) -> JobRecord:
        record = self.repository.require(job_id)
        if record.state not in TERMINAL_JOB_STATES:
            raise ValueError("cannot clean an active job")
        preserve_output = record.state == JobState.COMPLETED and record.output_available
        self.storage.cleanup_terminal(job_id, preserve_output=preserve_output)
        self.repository.mark_cleanup_done(job_id)
        return self.repository.require(job_id)

    def delete_output(self, job_id: str) -> JobRecord:
        record = self.repository.require(job_id)
        if record.state != JobState.COMPLETED:
            raise ValueError("only a completed job can have a published output")
        self.storage.delete_output(job_id)
        self.repository.mark_output_unavailable(job_id)
        return self.repository.require(job_id)

    def delete_job(self, job_id: str) -> None:
        record = self.repository.require(job_id)
        if record.state not in TERMINAL_JOB_STATES:
            raise ValueError("active jobs must be cancelled before deletion")
        self.storage.delete_job(job_id)
        if not self.repository.delete_terminal(job_id):
            raise RuntimeError("job record changed during deletion")
