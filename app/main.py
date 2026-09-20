"""HTTP entrypoint for the music visualizer MVP."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import uvicorn
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import ValidationError
from starlette.responses import Response

from . import __version__
from .config import Settings
from .render_jobs.models import (
    AgentRenderRequest,
    AgentRenderResponse,
    JobErrorCode,
    RenderJobResponse,
)
from .render_jobs.service import RenderJobService, RenderServiceError
from .render_jobs.worker import WorkerSupervisor


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"


def _frontend_directory(settings: Settings) -> Path:
    """Return the configured frontend build directory."""

    configured = settings.frontend_dist
    return Path(configured).expanduser().resolve() if configured else DEFAULT_FRONTEND_DIST


def _agent_response(job: RenderJobResponse) -> AgentRenderResponse:
    """Expose server-render job links without requiring UI-specific state."""

    resource = f"/api/agent/render/{job.id}"
    return AgentRenderResponse(
        job=job,
        status_url=resource,
        cancel_url=f"{resource}/cancel",
        output_url=f"/api/render-jobs/{job.id}/output",
        delete_url=resource,
    )


def create_app(
    settings: Settings | None = None,
    render_service: RenderJobService | None = None,
) -> FastAPI:
    """Create the service application.

    Keeping app construction explicit makes the static-root behavior easy to
    exercise in tests and avoids any server-side media processing boundary.
    """

    runtime = settings or Settings.from_env()
    frontend_dir = _frontend_directory(runtime)
    index_file = frontend_dir / "index.html"

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        service = application.state.render_service
        if not service.initialized:
            service.initialize()
        yield

    application = FastAPI(
        title="Music Visualizer",
        version=__version__,
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )
    application.state.render_service = render_service or RenderJobService(runtime)

    @application.exception_handler(RenderServiceError)
    async def render_service_error(_request: Request, error: RenderServiceError) -> JSONResponse:
        return JSONResponse(
            {"error": {"code": error.code.value, "message": str(error)}},
            status_code=error.status_code,
        )

    @application.get("/health", include_in_schema=True)
    @application.get("/api/health", include_in_schema=True)
    async def health() -> dict[str, str | bool]:
        """Report HTTP liveness and render-worker readiness without leaking paths."""

        service: RenderJobService = application.state.render_service
        worker = service.readiness.get()
        return {
            "status": "ok" if worker.ready else "degraded",
            "service": "music-visualizer",
            "version": __version__,
            "database": "ready" if service.initialized else "initializing",
            "storage": "ready" if service.initialized else "initializing",
            "renderWorkerReady": worker.ready,
        }

    @application.get("/api/render-capabilities")
    async def render_capabilities():
        service: RenderJobService = application.state.render_service
        return service.capabilities()

    @application.post("/api/render-jobs", status_code=201)
    async def create_render_job(
        config: str = Form(...),
        audio: UploadFile = File(...),
        cover: UploadFile | None = File(default=None),
        background: UploadFile | None = File(default=None),
        subtitles: UploadFile | None = File(default=None),
    ):
        service: RenderJobService = application.state.render_service
        return await service.create(
            config_json=config,
            audio=audio,
            cover=cover,
            background=background,
            subtitles=subtitles,
        )

    @application.post("/api/agent/render", status_code=201)
    async def create_agent_render(
        request: str = Form(...),
        audio: UploadFile = File(...),
        cover: UploadFile | None = File(default=None),
        background: UploadFile | None = File(default=None),
    ) -> AgentRenderResponse:
        """Create a server-only render job from a compact agent request."""

        try:
            agent_request = AgentRenderRequest.model_validate_json(request)
            configuration = agent_request.render_configuration()
        except ValidationError as error:
            raise RenderServiceError(
                422,
                JobErrorCode.INVALID_REQUEST,
                "Agent render request is invalid.",
            ) from error
        service: RenderJobService = application.state.render_service
        job = await service.create(
            config_json=configuration.model_dump_json(by_alias=True),
            audio=audio,
            cover=cover,
            background=background,
        )
        return _agent_response(job)

    @application.get("/api/agent/render/{job_id}")
    async def get_agent_render(job_id: str) -> AgentRenderResponse:
        service: RenderJobService = application.state.render_service
        return _agent_response(service.status(job_id))

    @application.post("/api/agent/render/{job_id}/cancel")
    async def cancel_agent_render(job_id: str) -> AgentRenderResponse:
        service: RenderJobService = application.state.render_service
        return _agent_response(service.cancel(job_id))

    @application.delete("/api/agent/render/{job_id}", status_code=204)
    async def delete_agent_render(job_id: str) -> Response:
        service: RenderJobService = application.state.render_service
        service.delete_job(job_id)
        return Response(status_code=204)

    @application.get("/api/render-jobs/{job_id}")
    async def get_render_job(job_id: str):
        service: RenderJobService = application.state.render_service
        return service.status(job_id)

    @application.post("/api/render-jobs/{job_id}/cancel")
    async def cancel_render_job(job_id: str):
        service: RenderJobService = application.state.render_service
        return service.cancel(job_id)

    @application.delete("/api/render-jobs/{job_id}/output")
    async def delete_render_output(job_id: str):
        service: RenderJobService = application.state.render_service
        return service.delete_output(job_id)

    @application.delete("/api/render-jobs/{job_id}", status_code=204)
    async def delete_render_job(job_id: str) -> Response:
        service: RenderJobService = application.state.render_service
        service.delete_job(job_id)
        return Response(status_code=204)

    @application.get("/api/render-jobs/{job_id}/output")
    async def get_render_output(job_id: str) -> FileResponse:
        service: RenderJobService = application.state.render_service
        path, filename = service.output_path(job_id)
        return FileResponse(
            path,
            media_type="video/mp4",
            filename=filename,
            content_disposition_type="inline",
        )

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
    """Run HTTP and the independent renderer from the single documented command."""

    settings = Settings.from_env()
    service = RenderJobService(settings)
    service.initialize()
    application = create_app(settings, service)
    supervisor: WorkerSupervisor | None = None
    if settings.worker_enabled:
        supervisor = WorkerSupervisor(settings, service.readiness)
        supervisor.start()
    try:
        uvicorn.run(application, host=settings.host, port=settings.port, reload=False)
    finally:
        if supervisor is not None:
            supervisor.stop()


if __name__ == "__main__":
    run()
