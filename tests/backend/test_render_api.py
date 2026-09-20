import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.render_jobs.models import JobErrorCode, JobState
from app.render_jobs.service import RenderJobService, WorkerReadiness
from app.render_jobs.validation import MediaValidator


def config_json() -> str:
    return json.dumps(
        {
            "schemaVersion": 1,
            "templateId": "night-orbit",
            "text": {"title": "API Song", "artist": "Artist"},
            "output": {
                "aspectRatio": "16:9",
                "width": 1280,
                "height": 720,
                "frameRate": 30,
            },
        }
    )


def successful_probe(_path: Path) -> dict:
    return {
        "streams": [{"codec_type": "audio", "codec_name": "wav"}],
        "format": {"duration": "2.0"},
    }


@pytest.fixture
def api(tmp_path: Path):
    settings = Settings(
        frontend_dist=str(tmp_path / "frontend"),
        data_root=tmp_path / "data",
        minimum_free_bytes=1,
        storage_ceiling_bytes=10 * 1024 * 1024,
        worker_enabled=False,
    )
    service = RenderJobService(
        settings,
        validator=MediaValidator(probe=successful_probe),
        readiness=WorkerReadiness(True, None),
    )
    with TestClient(create_app(settings, service)) as client:
        yield client, service


def create_job(client: TestClient) -> dict:
    response = client.post(
        "/api/render-jobs",
        data={"config": config_json()},
        files={"audio": ("song.wav", b"RIFF-audio-fixture", "audio/wav")},
    )
    assert response.status_code == 201, response.text
    return response.json()


def agent_request_json(**overrides) -> str:
    request = {
        "template": "quiet-editorial",
        "title": "Agent Song",
        "artist": "Agent Artist",
        "aspectRatio": "16:9",
        "resolution": "4k",
        "frameRate": 60,
    }
    request.update(overrides)
    return json.dumps(request)


def test_capability_create_and_status_contract(api) -> None:
    client, _service = api
    capability = client.get("/api/render-capabilities")
    assert capability.status_code == 200
    assert capability.json()["ready"] is True
    assert capability.json()["videoCodec"] == "h264_nvenc"

    created = create_job(client)
    assert created["state"] == "queued"
    assert created["schemaVersion"] == 1

    status = client.get(f"/api/render-jobs/{created['id']}")
    assert status.status_code == 200
    assert status.json()["id"] == created["id"]


def test_agent_api_creates_server_only_job_with_compact_request(api) -> None:
    client, service = api
    response = client.post(
        "/api/agent/render",
        data={"request": agent_request_json()},
        files={"audio": ("song.wav", b"RIFF-audio-fixture", "audio/wav")},
    )

    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["renderMode"] == "server"
    assert payload["job"]["state"] == "queued"
    job_id = payload["job"]["id"]
    assert payload["statusUrl"] == f"/api/agent/render/{job_id}"
    assert payload["cancelUrl"] == f"/api/agent/render/{job_id}/cancel"
    assert payload["outputUrl"] == f"/api/render-jobs/{job_id}/output"
    assert payload["deleteUrl"] == f"/api/agent/render/{job_id}"

    record = service.repository.require(job_id)
    assert record.configuration.template_id == "quiet-editorial"
    assert record.configuration.output.width == 3840
    assert record.configuration.output.height == 2160
    assert record.configuration.output.frame_rate == 60

    status = client.get(payload["statusUrl"])
    assert status.status_code == 200
    assert status.json()["job"]["id"] == job_id


def test_agent_api_rejects_client_mode_and_invalid_lyric_request(api) -> None:
    client, service = api
    client_mode = client.post(
        "/api/agent/render",
        data={"request": agent_request_json(renderMode="client")},
        files={"audio": ("song.wav", b"RIFF-audio-fixture", "audio/wav")},
    )
    lyrics_missing = client.post(
        "/api/agent/render",
        data={"request": agent_request_json(template="poetry-lyrics")},
        files={"audio": ("song.wav", b"RIFF-audio-fixture", "audio/wav")},
    )

    assert client_mode.status_code == 422
    assert client_mode.json()["error"]["code"] == "invalid_request"
    assert lyrics_missing.status_code == 422
    assert lyrics_missing.json()["error"]["code"] == "invalid_request"
    assert list(service.repository.iter_jobs()) == []


def test_unavailable_worker_rejects_job_before_writing(api) -> None:
    client, service = api
    service.readiness.set(False, "NVENC preflight failed")

    response = client.post(
        "/api/render-jobs",
        data={"config": config_json()},
        files={"audio": ("song.wav", b"RIFF", "audio/wav")},
    )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "worker_unavailable"
    assert list(service.repository.iter_jobs()) == []


def test_invalid_configuration_and_audio_use_stable_errors(api) -> None:
    client, service = api
    invalid_config = client.post(
        "/api/render-jobs",
        data={"config": "{}"},
        files={"audio": ("song.wav", b"RIFF", "audio/wav")},
    )
    assert invalid_config.status_code == 422
    assert invalid_config.json()["error"]["code"] == "invalid_request"

    invalid_audio = client.post(
        "/api/render-jobs",
        data={"config": config_json()},
        files={"audio": ("song.svg", b"svg", "image/svg+xml")},
    )
    assert invalid_audio.status_code == 422
    assert invalid_audio.json()["error"]["code"] == "invalid_audio"
    assert list(service.repository.iter_jobs()) == []


def test_queued_cancel_is_terminal_idempotent_and_deletable(api) -> None:
    client, service = api
    created = create_job(client)
    job_id = created["id"]

    first = client.post(f"/api/render-jobs/{job_id}/cancel")
    second = client.post(f"/api/render-jobs/{job_id}/cancel")

    assert first.json()["state"] == "cancelled"
    assert second.json()["state"] == "cancelled"
    assert service.repository.claim_next("late-worker") is None
    assert client.delete(f"/api/render-jobs/{job_id}").status_code == 204
    assert service.repository.get(job_id) is None


def test_running_cancel_and_late_complete_keep_cancelled_terminal_state(api) -> None:
    client, service = api
    job_id = create_job(client)["id"]
    service.repository.claim_next("worker")

    response = client.post(f"/api/render-jobs/{job_id}/cancel")
    assert response.status_code == 200
    assert response.json()["state"] == "running"
    assert service.repository.is_cancel_requested(job_id, "worker")

    assert service.repository.finish(
        job_id,
        "worker",
        JobState.CANCELLED,
        error_code=JobErrorCode.CANCELLED,
        error_message="cancelled",
    )
    service.lifecycle.cleanup_terminal(job_id)
    assert not service.repository.finish(
        job_id,
        "worker",
        JobState.COMPLETED,
        output_relpath=service.storage.output_relative_path(job_id),
    )
    assert client.get(f"/api/render-jobs/{job_id}").json()["state"] == "cancelled"


def test_completed_output_supports_range_and_explicit_delete(api) -> None:
    client, service = api
    job_id = create_job(client)["id"]
    service.repository.claim_next("worker")
    output = service.storage.output_path(job_id)
    output.write_bytes(b"0123456789")
    assert service.repository.finish(
        job_id,
        "worker",
        JobState.COMPLETED,
        output_relpath=service.storage.output_relative_path(job_id),
    )
    service.lifecycle.cleanup_terminal(job_id)

    full = client.get(f"/api/render-jobs/{job_id}/output")
    partial = client.get(
        f"/api/render-jobs/{job_id}/output", headers={"Range": "bytes=2-5"}
    )

    assert full.status_code == 200
    assert full.headers["content-type"] == "video/mp4"
    assert full.headers["content-length"] == "10"
    assert partial.status_code == 206
    assert partial.content == b"2345"
    deleted = client.delete(f"/api/render-jobs/{job_id}/output")
    assert deleted.status_code == 200
    assert deleted.json()["outputAvailable"] is False
    missing = client.get(f"/api/render-jobs/{job_id}/output")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "output_unavailable"


def test_active_job_delete_requests_cancel_and_requires_retry(api) -> None:
    client, service = api
    job_id = create_job(client)["id"]
    service.repository.claim_next("worker")

    response = client.delete(f"/api/render-jobs/{job_id}")

    assert response.status_code == 409
    assert service.repository.is_cancel_requested(job_id, "worker")


def test_health_reports_degraded_without_leaking_worker_reason(api) -> None:
    client, service = api
    service.readiness.set(False, "/private/path/ffmpeg emitted secret diagnostics")

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "degraded"
    assert response.json()["renderWorkerReady"] is False
    assert "/private/path" not in response.text
