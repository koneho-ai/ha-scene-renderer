"""Discover the scene-renderer add-on via the Supervisor API.

The add-on runs in its own container on the Supervisor's internal network.
Its hostname is its full slug (repository prefix + slug) with underscores
replaced by hyphens, e.g. ``a1b2c3d4-scene-renderer`` — or ``local-...`` for
a locally built add-on. The Supervisor's ``/addons/<slug>/info`` endpoint
returns that hostname directly, so discovery reads it from there instead of
guessing the format.

Returns None when the hassio integration is absent (Container/Core installs
have no Supervisor) or the add-on is not installed; async_setup then fails
with a clear error unless the user set ``service_url`` in YAML.
"""
from __future__ import annotations

from homeassistant.core import HomeAssistant

from .const import ADDON_PORT, ADDON_SLUG


async def async_discover_addon_url(hass: HomeAssistant) -> str | None:
    """Return the add-on's internal base URL, or None if not discoverable."""
    hassio = hass.data.get("hassio")
    if hassio is None:
        return None
    try:
        result = await hassio.send_command("/addons", method="get")
        data = result.get("data", result) if isinstance(result, dict) else {}
        addons = data.get("addons", [])
        slug = None
        for addon in addons:
            candidate = addon.get("slug", "")
            if candidate == f"local_{ADDON_SLUG}" or candidate.endswith(f"_{ADDON_SLUG}"):
                slug = candidate
                break
        if slug is None:
            return None
        info = await hassio.send_command(f"/addons/{slug}/info", method="get")
        info_data = info.get("data", info) if isinstance(info, dict) else {}
        hostname = info_data.get("hostname") or slug.replace("_", "-")
        return f"http://{hostname}:{ADDON_PORT}"
    except Exception:  # noqa: BLE001 - discovery is best-effort by design
        return None
