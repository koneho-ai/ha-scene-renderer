"""Sidebar panel for HA Scene Renderer: registration, model proxy, websocket API.

The panel is a native Home Assistant sidebar page with an interactive 3D
viewer (three.js, vendored under ``frontend/`` with no build step). The
browser cannot reach the render service directly, so this module also
provides:

- an authenticated HTTP view proxying the model GLB
  (``GET /api/scene_renderer/{entry_id}/model``), and
- two websocket commands the panel uses to discover config entries and
  fetch the mapping + effective camera configs + image entity ids.

Panel registration follows the exact pattern Home Assistant core itself
uses in ``panel_custom`` (verified against HA core 2026.11.3):
``frontend.async_register_built_in_panel`` with ``component_name="custom"``
and a ``config`` carrying the ``_panel_custom`` block. That function is a
``@callback`` — it is called synchronously, never awaited — and raises
``ValueError`` if the URL path is already registered, so registration is
guarded by a ``hass.data`` flag plus ``frontend.async_panel_exists`` and
treats an already-registered panel as success. (YAML-only setup runs
once per Home Assistant start, so the guard is belt-and-braces.)

Websocket schemas use ``probatio``, not voluptuous: HA 2026.11 moved the
websocket API to probatio (``BASE_COMMAND_MESSAGE_SCHEMA`` is a
probatio schema; no core integration uses voluptuous there anymore).
Handlers send their answer explicitly with ``connection.send_result`` /
``connection.send_message(websocket_api.error_message(...))`` — the
``@websocket_api.async_response`` decorator discards the handler's return
value, so returning a payload would silently send nothing.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

import probatio
from aiohttp import web

from homeassistant.components import frontend, websocket_api
from homeassistant.components.http import HomeAssistantView, StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN
from .service import RenderServiceError

_LOGGER = logging.getLogger(__name__)

PANEL_URL_PATH = "scene_renderer"
PANEL_TITLE = "Scene Renderer"
PANEL_ICON = "mdi:video-3d"
PANEL_COMPONENT_NAME = "scene-renderer-panel"
STATIC_URL_PATH = "/scene_renderer_static"


def _integration_version() -> str:
    """Version from this integration's manifest.json (next to this file).

    Falls back to "0" if the manifest is unreadable — the URL still
    works, it just won't bust the cache on that install.
    """
    try:
        with open(os.path.join(os.path.dirname(__file__), "manifest.json")) as f:
            return json.load(f).get("version", "0")
    except (OSError, ValueError):
        return "0"


# The module URL carries the integration version as a query string so
# every release is a fresh URL for the browser. Without it the panel JS
# is served at a fixed URL and browsers keep running a stale cached copy
# across updates (0.3.1's toggles and gap fix never appeared until a
# manual hard refresh). The static file handler ignores the query.
PANEL_MODULE_URL = (
    f"{STATIC_URL_PATH}/scene-renderer-panel.js?v={_integration_version()}"
)

# hass.data flag marking the panel as registered for this hass instance.
# The panel is registered once no matter how many config entries exist.
PANEL_REGISTERED_KEY = f"{DOMAIN}_panel_registered"


def _frontend_dir() -> str:
    """Directory holding the panel's static frontend files."""
    return os.path.join(os.path.dirname(__file__), "frontend")


async def async_register_panel(hass: HomeAssistant) -> None:
    """Register the sidebar panel, static files, view and commands.

    Idempotent: a second call is a no-op success. (YAML-only setup runs
    once per Home Assistant start; the guard is belt-and-braces.)
    Static paths are registered first so the panel's module URL resolves
    as soon as the panel exists.
    """
    if hass.data.get(PANEL_REGISTERED_KEY):
        return
    if frontend.async_panel_exists(hass, PANEL_URL_PATH):
        # Registered outside this integration (or by an earlier setup
        # whose flag was lost): treat as success, do not re-register.
        hass.data[PANEL_REGISTERED_KEY] = True
        return
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                STATIC_URL_PATH, _frontend_dir(), cache_headers=False
            )
        ]
    )
    # @callback — call synchronously, do NOT await. Raises ValueError if
    # the URL path is already registered (a concurrent setup could still
    # race the guards above); that is success, not an error.
    try:
        frontend.async_register_built_in_panel(
            hass,
            component_name="custom",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            frontend_url_path=PANEL_URL_PATH,
            config={
                "_panel_custom": {
                    "name": PANEL_COMPONENT_NAME,
                    "module_url": PANEL_MODULE_URL,
                    "embed_iframe": False,
                    "trust_external": False,
                }
            },
            require_admin=False,
        )
    except ValueError:
        _LOGGER.debug("Scene Renderer panel was already registered")
    hass.http.register_view(SceneRendererModelView())
    websocket_api.async_register_command(hass, websocket_panel_entries)
    websocket_api.async_register_command(hass, websocket_panel_data)
    hass.data[PANEL_REGISTERED_KEY] = True


class SceneRendererModelView(HomeAssistantView):
    """Proxy the model GLB from the render service to the panel.

    The browser cannot reach the render service (internal Docker
    network), so the panel fetches the model through this authenticated
    view instead. ``requires_auth`` defaults to True and is kept.
    """

    url = "/api/scene_renderer/{entry_id}/model"
    name = "api:scene_renderer:model"

    async def get(
        self, request: web.Request, entry_id: str
    ) -> web.Response:
        """Return the loaded model's GLB bytes for a scene."""
        coordinator = request.app["hass"].data.get(DOMAIN, {}).get(entry_id)
        if coordinator is None:
            return web.Response(
                status=404, text=f"Unknown Scene Renderer scene: {entry_id}"
            )
        try:
            data = await coordinator.service.async_model()
        except RenderServiceError as err:
            _LOGGER.warning(
                "Scene Renderer panel: render service unreachable for entry %s: %s",
                entry_id,
                err,
            )
            return web.Response(
                status=502, text=f"Render service unreachable: {err}"
            )
        return web.Response(body=data, content_type="model/gltf-binary")


@websocket_api.websocket_command(
    {
        probatio.Required("type"): "scene_renderer/panel_entries",
    }
)
@websocket_api.async_response
async def websocket_panel_entries(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """List the Scene Renderer scenes (for the entry picker)."""
    entries = [
        {"entry_id": entry_id, "name": coordinator.name}
        for entry_id, coordinator in hass.data.get(DOMAIN, {}).items()
    ]
    connection.send_result(msg["id"], entries)


@websocket_api.websocket_command(
    {
        probatio.Required("type"): "scene_renderer/panel_data",
        probatio.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def websocket_panel_data(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return one entry's mapping, cameras and image entity ids.

    Cameras are the service's effective configs (model + cameras.yaml +
    defaults, merged). Image entity ids are resolved through the entity
    registry from the unique id ``image.py`` uses
    (``{entry_id}_render_{camera}``); a camera with no image entity yet
    (not selected in the YAML cameras list) maps to None.
    """
    entry_id = msg["entry_id"]
    coordinator = hass.data.get(DOMAIN, {}).get(entry_id)
    if coordinator is None:
        connection.send_message(
            websocket_api.error_message(
                msg["id"],
                "not_found",
                f"Unknown Scene Renderer scene: {entry_id}",
            )
        )
        return
    try:
        cameras = await coordinator.service.async_cameras()
    except RenderServiceError as err:
        connection.send_message(
            websocket_api.error_message(
                msg["id"],
                "service_unreachable",
                f"Render service unreachable: {err}",
            )
        )
        return
    registry = er.async_get(hass)
    image_entities = {
        camera["name"]: registry.async_get_entity_id(
            "image", DOMAIN, f"{entry_id}_render_{camera['name']}"
        )
        for camera in cameras
        if camera.get("name")
    }
    connection.send_result(
        msg["id"],
        {
            "mapping": dict(coordinator.mapping),
            "cameras": cameras,
            "image_entities": image_entities,
        },
    )
