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

    async def async_render(self, payload: dict[str, Any]) -> dict[str, bytes]:
        """POST /render. Returns {camera_name: PNG bytes}."""

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
        out: dict[str, bytes] = {}
        for name, encoded in renders.items():
            if not isinstance(encoded, str):
                raise RenderServiceError("render service returned an unexpected /render response")
            try:
                out[name] = base64.b64decode(encoded, validate=True)
            except ValueError as err:
                raise RenderServiceError(f"render service returned invalid PNG data for camera {name!r}") from err
        return out
