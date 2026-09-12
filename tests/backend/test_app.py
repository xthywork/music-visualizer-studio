from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_settings_use_documented_defaults(monkeypatch) -> None:
    monkeypatch.delenv("VISUALIZER_HOST", raising=False)
    monkeypatch.delenv("VISUALIZER_PORT", raising=False)

    settings = Settings.from_env()

    assert settings.host == "0.0.0.0"
    assert settings.port == 34388


def test_settings_can_be_overridden_by_environment(monkeypatch) -> None:
    monkeypatch.setenv("VISUALIZER_HOST", "127.0.0.1")
    monkeypatch.setenv("VISUALIZER_PORT", "9000")

    settings = Settings.from_env()

    assert settings.host == "127.0.0.1"
    assert settings.port == 9000


def test_health_endpoint_is_available_without_audio_api() -> None:
    client = TestClient(create_app(Settings(frontend_dist="/does/not/exist")))

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["service"] == "music-visualizer"


def test_api_health_alias_is_available() -> None:
    client = TestClient(create_app(Settings(frontend_dist="/does/not/exist")))

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
