"""Runtime configuration for the visualizer service.

The service is intentionally small in the MVP: it serves the browser
application and a health endpoint.  Host and port are configurable so a
reverse proxy or local development environment can choose its own binding,
while the documented internal defaults remain 0.0.0.0:34388.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 34388


def _env_int(name: str, default: int) -> int:
    """Read a positive integer environment value, falling back safely."""

    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return parsed if 1 <= parsed <= 65535 else default


@dataclass(frozen=True, slots=True)
class Settings:
    """Application settings loaded from the process environment."""

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    frontend_dist: str | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        """Build settings from environment variables.

        ``FRONTEND_DIST`` is optional and mainly useful for a packaged
        deployment or tests. When unset, the application resolves the
        repository's ``frontend/dist`` directory at startup.
        """

        return cls(
            host=os.getenv("VISUALIZER_HOST", DEFAULT_HOST),
            port=_env_int("VISUALIZER_PORT", DEFAULT_PORT),
            frontend_dist=os.getenv("FRONTEND_DIST") or None,
        )
