"""Client for the scene-renderer add-on HTTP API."""
from __future__ import annotations

import asyncio
import base64
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import PROBE_TIMEOUT, RENDER_TIMEOUT


class RenderServiceError(Exception):
    """Raised when the render service cannot be reached or fails."""


class RenderServiceClient:
    """Minimal async client for the render service."""

    def __init__(self, hass: HomeAssistant, base_url: str) -> None:
        self._session = async_get_clientsession(hass)
        self.base_url = base_url.rstrip("/")

    async def async_health(self) -> dict[str, Any]:
        """GET /health. Raises RenderServiceError on any failure."""
        try:
            async with asyncio.timeout(PROBE_TIMEOUT):
                async with self._session.get(f"{self.base_url}/health") as resp:
                    if resp.status != 200:
                        raise RenderServiceError(f"health check failed: HTTP {resp.status}")
                    return await resp.json()
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
            raise RenderServiceError(f"cannot reach render service: {err}") from err

    async def async_lights(self) -> list[dict[str, Any]]:
        """GET /lights. Returns the scene lights from the loaded model."""
        try:
            async with asyncio.timeout(PROBE_TIMEOUT):
                async with self._session.get(f"{self.base_url}/lights") as resp:
                    if resp.status != 200:
                        raise RenderServiceError(f"lights request failed: HTTP {resp.status}")
                    data = await resp.json()
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
            raise RenderServiceError(f"cannot reach render service: {err}") from err
        lights = data.get("lights")
        if not isinstance(lights, list):
            raise RenderServiceError("render service returned an unexpected /lights response")
        return lights

    async def async_cameras(self) -> list[dict[str, Any]]:
        """GET /cameras. Returns the scene cameras with effective config."""
        try:
            async with asyncio.timeout(PROBE_TIMEOUT):
                async with self._session.get(f"{self.base_url}/cameras") as resp:
                    if resp.status != 200:
                        raise RenderServiceError(f"cameras request failed: HTTP {resp.status}")
                    data = await resp.json()
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
            raise RenderServiceError(f"cannot reach render service: {err}") from err
        cameras = data.get("cameras")
        if not isinstance(cameras, list):
            raise RenderServiceError("render service returned an unexpected /cameras response")
        return cameras

    async def async_script(self) -> dict[str, Any]:
        """GET /script. Returns the user script (scene.js) status.

        Shape: {"script": {"present": bool, "hash": str | None,
        "subscribe": [...], "object_drivers": {object_name: entity_id},
        "light_mapping": {light_name: entity_id},
        "status": "none"|"ok"|"error", "error": ..., "last_error": ...,
        "error_count": int}}.
        """
        try:
            async with asyncio.timeout(PROBE_TIMEOUT):
                async with self._session.get(f"{self.base_url}/script") as resp:
                    if resp.status != 200:
                        raise RenderServiceError(f"script request failed: HTTP {resp.status}")
                    data = await resp.json()
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
            raise RenderServiceError(f"cannot reach render service: {err}") from err
        script = data.get("script")
        if not isinstance(script, dict):
            raise RenderServiceError("render service returned an unexpected /script response")
        return script

    async def async_model(self) -> bytes:
        """GET /model. Returns the loaded model GLB bytes.

        Used by the sidebar panel (via the integration's HTTP proxy —
        the browser cannot reach the render service directly).
        """
        try:
            async with asyncio.timeout(PROBE_TIMEOUT):
                async with self._session.get(f"{self.base_url}/model") as resp:
                    if resp.status != 200:
                        raise RenderServiceError(f"model request failed: HTTP {resp.status}")
                    return await resp.read()
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            raise RenderServiceError(f"cannot reach render service: {err}") from err

    async def async_render(
        self, payload: dict[str, Any]
    ) -> tuple[dict[str, tuple[bytes, str, list[dict[str, Any]], int | None]], dict[str, Any]]:
        """POST /render.

        Returns ({camera_name: (bytes, content_type, lights, render_ms)},
        script_info).
        Stills come back as image/png; cameras with a clip: entry in
        cameras.yaml come back as image/webp (animated). ``lights`` is the
        per-camera projection of the model lights into image coordinates
        ([{name, x_px, y_px, x_pct, y_pct, visible}], see scene.mjs
        projectLights); [] when the service does not send it (older
        versions). ``render_ms`` is the wall-clock milliseconds the
        service spent rendering that camera (frames + encoding for
        clips); None when the service does not send it (older versions
        or the legacy shape). The script info is the /script status block
        (present/hash/subscribe/status/...), so the coordinator can
        re-subscribe when the script changes.

        Accepts the legacy v1 response shape too (renders as plain base64
        strings), treating those as image/png with no light projections
        and no render time.
        """

        try:
            async with asyncio.timeout(RENDER_TIMEOUT):
                async with self._session.post(
                    f"{self.base_url}/render", json=payload
                ) as resp:
                    if resp.status != 200:
                        text = await resp.text()
                        raise RenderServiceError(
                            f"render failed: HTTP {resp.status}: {text[:200]}"
                        )
                    data = await resp.json()
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
            raise RenderServiceError(f"cannot reach render service: {err}") from err
        renders = data.get("renders")
        if not isinstance(renders, dict):
            raise RenderServiceError("render service returned an unexpected /render response")
        out: dict[str, tuple[bytes, str, list[dict[str, Any]], int | None]] = {}
        for name, rendered in renders.items():
            if isinstance(rendered, str):
                # Legacy v1 shape: plain base64 PNG.
                encoded, content_type, lights = rendered, "image/png", []
                render_ms = None
            elif isinstance(rendered, dict):
                encoded = rendered.get("data")
                content_type = rendered.get("content_type", "image/png")
                lights = rendered.get("lights", [])
                render_ms = rendered.get("render_ms")
                if not isinstance(encoded, str) or not isinstance(content_type, str):
                    raise RenderServiceError(
                        "render service returned an unexpected /render response"
                    )
                if not isinstance(lights, list):
                    raise RenderServiceError(
                        "render service returned an unexpected /render response"
                    )
                if render_ms is not None and not isinstance(render_ms, (int, float)):
                    raise RenderServiceError(
                        "render service returned an unexpected /render response"
                    )
                render_ms = int(render_ms) if render_ms is not None else None
            else:
                raise RenderServiceError("render service returned an unexpected /render response")
            try:
                out[name] = (base64.b64decode(encoded, validate=True), content_type, lights, render_ms)
            except ValueError as err:
                raise RenderServiceError(f"render service returned invalid image data for camera {name!r}") from err
        script = data.get("script")
        if not isinstance(script, dict):
            script = {}
        return out, script
