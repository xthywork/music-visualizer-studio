from pathlib import Path

from fastapi.testclient import TestClient

import app.main as main_module
from app.config import Settings
from app.main import create_app


def test_settings_use_documented_defaults(monkeypatch) -> None:
    monkeypatch.delenv("VISUALIZER_HOST", raising=False)
    monkeypatch.delenv("VISUALIZER_PORT", raising=False)

    settings = Settings.from_env()

    assert settings.host == "0.0.0.0"
    assert settings.port == 34388
    assert settings.ffmpeg_path == "ffmpeg"
    assert settings.ffprobe_path == "ffprobe"
    assert settings.worker_enabled is True
    assert settings.worker_poll_ms == 250
    assert settings.max_audio_bytes == 256 * 1024 * 1024
    assert settings.max_image_bytes == 3840 * 2160


def test_settings_can_be_overridden_by_environment(monkeypatch) -> None:
    monkeypatch.setenv("VISUALIZER_HOST", "127.0.0.1")
    monkeypatch.setenv("VISUALIZER_PORT", "9000")
    monkeypatch.setenv("VISUALIZER_DATA_ROOT", "/tmp/music-visualizer-test-data")
    monkeypatch.setenv("VISUALIZER_FFMPEG", "/usr/local/bin/ffmpeg")
    monkeypatch.setenv("VISUALIZER_WORKER_ENABLED", "false")
    monkeypatch.setenv("VISUALIZER_WORKER_POLL_MS", "500")

    settings = Settings.from_env()

    assert settings.host == "127.0.0.1"
    assert settings.port == 9000
    assert settings.data_root == Path("/tmp/music-visualizer-test-data")
    assert settings.ffmpeg_path == "/usr/local/bin/ffmpeg"
    assert settings.worker_enabled is False
    assert settings.worker_poll_ms == 500


def test_invalid_runtime_limits_fall_back_to_safe_defaults(monkeypatch) -> None:
    monkeypatch.setenv("VISUALIZER_MAX_QUEUE_DEPTH", "0")
    monkeypatch.setenv("VISUALIZER_MAX_AUDIO_BYTES", "not-a-number")
    monkeypatch.setenv("VISUALIZER_WORKER_ENABLED", "maybe")

    settings = Settings.from_env()

    assert settings.max_queue_depth == 100
    assert settings.max_audio_bytes == 256 * 1024 * 1024
    assert settings.worker_enabled is True


def test_health_endpoint_is_available_without_audio_api() -> None:
    client = TestClient(create_app(Settings(frontend_dist="/does/not/exist", worker_enabled=False)))

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "degraded"
    assert response.json()["service"] == "music-visualizer"
    assert response.json()["renderWorkerReady"] is False


def test_api_health_alias_is_available() -> None:
    client = TestClient(create_app(Settings(frontend_dist="/does/not/exist", worker_enabled=False)))

    assert client.get("/api/health").status_code == 200


def test_unbuilt_root_is_a_non_upload_service_response() -> None:
    client = TestClient(create_app(Settings(frontend_dist="/does/not/exist")))

    response = client.get("/")

    assert response.status_code == 200
    assert response.json()["frontend"] == "not-built"
    assert client.post("/upload").status_code == 405


def test_built_frontend_assets_and_spa_fallback(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html><body>visualizer</body></html>", encoding="utf-8")
    (dist / "asset.js").write_text("console.log('ok')", encoding="utf-8")
    client = TestClient(create_app(Settings(frontend_dist=str(dist))))

    assert "visualizer" in client.get("/").text
    assert "console.log" in client.get("/asset.js").text
    assert "visualizer" in client.get("/projects/example").text
    missing_asset = client.get("/assets/missing.js")
    assert missing_asset.status_code == 404
    assert missing_asset.json() == {"detail": "Not found"}


def test_frontend_path_traversal_is_rejected(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("app", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("secret", encoding="utf-8")
    client = TestClient(create_app(Settings(frontend_dist=str(dist))))

    # Percent-encoding keeps the traversal segment intact through the test
    # client's URL normalization.
    response = client.get("/%2e%2e/secret.txt")

    assert response.status_code == 404
    assert "secret" not in response.text


def test_documented_run_entrypoint_owns_worker_supervisor(monkeypatch, tmp_path: Path) -> None:
    settings = Settings(data_root=tmp_path / "data", worker_enabled=True)
    events: list[str] = []

    class FakeSupervisor:
        def __init__(self, received_settings, _readiness) -> None:  # type: ignore[no-untyped-def]
            assert received_settings is settings
            events.append("constructed")

        def start(self) -> bool:
            events.append("started")
            return True

        def stop(self) -> None:
            events.append("stopped")

    monkeypatch.setattr(main_module.Settings, "from_env", classmethod(lambda _cls: settings))
    monkeypatch.setattr(main_module, "WorkerSupervisor", FakeSupervisor)
    def run_http(application, **options) -> None:  # type: ignore[no-untyped-def]
        assert options["host"] == settings.host
        assert application.state.render_service.initialized
        events.append("http")

    monkeypatch.setattr(main_module.uvicorn, "run", run_http)

    main_module.run()

    assert events == ["constructed", "started", "http", "stopped"]
