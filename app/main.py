"""HTTP entrypoint for the music visualizer MVP."""

from __future__ import annotations

import os
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from starlette.responses import Response

from . import __version__
from .config import Settings


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"


def _frontend_directory(settings: Settings) -> Path:
    """Return the configured frontend build directory."""

    configured = settings.frontend_dist
    return Path(configured).expanduser().resolve() if configured else DEFAULT_FRONTEND_DIST


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create the service application.

    Keeping app construction explicit makes the static-root behavior easy to
    exercise in tests and avoids any server-side media processing boundary.
    """

    runtime = settings or Settings.from_env()
    frontend_dir = _frontend_directory(runtime)
    index_file = frontend_dir / "index.html"

    application = FastAPI(
        title="Music Visualizer",
        version=__version__,
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )

    @application.get("/health", include_in_schema=True)
    @application.get("/api/health", include_in_schema=True)
    async def health() -> dict[str, str]:
        """Report service liveness without inspecting or receiving audio."""

        return {"status": "ok", "service": "music-visualizer", "version": __version__}

    @application.get("/", include_in_schema=False, response_model=None)
    async def root() -> Response:
        return _serve_frontend(index_file, frontend_dir)

    @application.get("/{path:path}", include_in_schema=False, response_model=None)
    async def frontend(path: str) -> Response:
        """Serve assets and fall back to the SPA entrypoint for client routes."""

        # Never let a request escape the distribution directory.  The
        # resolved-path check also handles encoded ``..`` segments safely.
        candidate = (frontend_dir / path).resolve()
        try:
            candidate.relative_to(frontend_dir)
        except ValueError:
            return JSONResponse({"detail": "Not found"}, status_code=404)

        if candidate.is_file():
            return FileResponse(candidate)
        if path == "assets" or path.startswith("assets/"):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        return _serve_frontend(index_file, frontend_dir)

    return application


def _serve_frontend(index_file: Path, frontend_dir: Path) -> Response:
    """Return the built SPA or a useful response before the frontend is built."""

    if index_file.is_file():
        return FileResponse(index_file)
    return JSONResponse(
        {
            "service": "music-visualizer",
            "status": "ok",
            "frontend": "not-built",
            "message": "Build the frontend with its production build command to serve the application.",
            "frontend_directory": os.fspath(frontend_dir),
        }
    )


app = create_app()


def run() -> None:
    """Run the service using the documented environment-aware defaults."""

    settings = Settings.from_env()
    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=False)


if __name__ == "__main__":
    run()
