"""HA Scene Renderer integration (YAML-only).

There is no config flow: the integration is configured in
``configuration.yaml`` under the ``scene_renderer`` key, and only the
lights you map are linked — unmapped lights render at their model
defaults, so the demo model needs no onboarding at all:

.. code-block:: yaml

    scene_renderer:
      lights:
        living_room_1: light.living_room
        kitchen_1: light.kitchen

Full reference (all keys optional):

- ``service_url``: base URL of the render service. When omitted, the
  add-on is discovered via the Supervisor API.
- ``sun_entity``: sun entity to follow (default ``sun.sun``); set to
  null to disable the sun.
- ``sun_elevation`` / ``sun_azimuth``: fix the sun at a position
  (degrees, 0–90 / 0–360) instead of following ``sun_entity`` — e.g.
  a high noon sun in winter, when the real sun never gets above the
  rooftops. Both keys together or neither; the sun entity is then
  only used by scene.js, if the script reads it.
- ``name``: scene name, used for the device and entities
  (default "Scene Renderer").
- ``lights``: mapping of model light names to HA entity ids. Only
  mapped lights follow live state; the rest render at base values.
- ``cameras``: camera names to expose, one image entity each; when
  omitted, all cameras the service offers.

Changing the YAML needs a Home Assistant restart (standard for
YAML-only integrations). There is no unload: remove the YAML block and
restart to remove the integration.
"""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.const import CONF_NAME, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.discovery import async_load_platform
from homeassistant.util import slugify

from .const import (
    CONF_CAMERAS,
    CONF_LIGHTS,
    CONF_SERVICE_URL,
    CONF_SUN_AZIMUTH,
    CONF_SUN_ELEVATION,
    CONF_SUN_ENTITY,
    DEFAULT_NAME,
    DOMAIN,
    SUN_ENTITY_ID,
    YAML_CONFIG_ID,
)
from .coordinator import SceneRenderCoordinator
from .panel import async_register_panel
from .supervisor import async_discover_addon_url

_LOGGER = logging.getLogger(__name__)

def _validate_sun_override(conf: dict[str, Any]) -> dict[str, Any]:
    """Require sun_elevation and sun_azimuth together or neither.

    A fixed sun needs both coordinates; one without the other is a
    typo, not a partial override, so fail the config check loudly.
    """
    has_el = CONF_SUN_ELEVATION in conf
    has_az = CONF_SUN_AZIMUTH in conf
    if has_el != has_az:
        raise vol.Invalid(
            "Scene Renderer: sun_elevation and sun_azimuth must be "
            "set together (or neither) — the sun needs both coordinates"
        )
    return conf


CONFIG_SCHEMA = vol.Schema(
    {
        vol.Optional(DOMAIN): vol.Any(
            # A bare `scene_renderer:` line parses as None — that is a
            # valid (empty) configuration.
            None,
            vol.All(
                vol.Schema(
                    {
                        vol.Optional(CONF_SERVICE_URL): cv.string,
                        vol.Optional(
                            CONF_SUN_ENTITY, default=SUN_ENTITY_ID
                        ): vol.Any(cv.entity_id, None),
                        vol.Optional(CONF_SUN_ELEVATION): vol.All(
                            vol.Coerce(float), vol.Range(min=0, max=90)
                        ),
                        vol.Optional(CONF_SUN_AZIMUTH): vol.All(
                            vol.Coerce(float), vol.Range(min=0, max=360)
                        ),
                        vol.Optional(CONF_NAME, default=DEFAULT_NAME): cv.string,
                        vol.Optional(CONF_LIGHTS, default={}): {
                            cv.string: cv.entity_id
                        },
                        vol.Optional(CONF_CAMERAS): [cv.string],
                    }
                ),
                _validate_sun_override,
            ),
        ),
    },
    extra=vol.ALLOW_EXTRA,
)

PLATFORMS = [Platform.IMAGE, Platform.SENSOR, Platform.BUTTON]


def _migrate_bare_entity_ids(
    hass: HomeAssistant, coordinator: SceneRenderCoordinator
) -> None:
    """One-time migration of the bare entity ids 0.3.0 registered.

    0.3.0 used ``has_entity_name`` + ``device_info``, but a YAML-only
    setup has no config entry, so no device ever attached and the
    entities registered as ``image.overview``,
    ``sensor.render_status`` and ``button.re_render``. The registry
    keeps a registered id even when the suggested name changes, so
    the entries are renamed in place to their scene-prefixed ids.

    Rename, not remove + re-add: ``async_remove`` stashes the entry
    in ``deleted_entities``, and ``async_get_or_create`` restores
    the old entity_id when the entity is re-added moments later —
    0.3.1/0.3.2 removed the entries and HA faithfully gave the bare
    ids straight back. Only entries that still carry the exact bare
    id are renamed — an entry the user renamed, or one already
    migrated, is left alone, and the migration is a no-op on fresh
    installs.
    """
    registry = er.async_get(hass)
    name = coordinator.name
    candidates: list[tuple[str, str, str, str]] = [
        ("sensor", f"{YAML_CONFIG_ID}_status", "Render status",
         f"{name} Render status"),
        ("button", f"{YAML_CONFIG_ID}_rerender", "Re-render",
         f"{name} Re-render"),
    ]
    for camera in coordinator.cameras:
        title = camera.replace("_", " ").title()
        candidates.append(
            ("image", f"{YAML_CONFIG_ID}_render_{camera}", title,
             f"{name} {title}")
        )
    for domain, unique_id, old_name, new_name in candidates:
        old_id = f"{domain}.{slugify(old_name)}"
        new_id = f"{domain}.{slugify(new_name)}"
        if old_id == new_id:
            continue
        entity_id = registry.async_get_entity_id(domain, DOMAIN, unique_id)
        if entity_id != old_id:
            continue
        try:
            registry.async_update_entity(entity_id, new_entity_id=new_id)
        except ValueError:
            _LOGGER.warning(
                "Scene Renderer: could not migrate %s to %s "
                "(new id already in use?)",
                entity_id,
                new_id,
            )
            continue
        _LOGGER.info(
            "Scene Renderer: migrated %s to %s", entity_id, new_id
        )


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Set up HA Scene Renderer from YAML configuration."""
    conf: dict[str, Any] = config.get(DOMAIN) or {}
    service_url = conf.get(CONF_SERVICE_URL)
    if not service_url:
        service_url = await async_discover_addon_url(hass)
    if not service_url:
        _LOGGER.error(
            "Scene Renderer: could not find the render service — install "
            "and start the Scene Renderer app first, or set service_url "
            "in the scene_renderer YAML block"
        )
        return False
    coordinator = SceneRenderCoordinator(
        hass,
        service_url=service_url,
        sun_entity_id=conf.get(CONF_SUN_ENTITY, SUN_ENTITY_ID),
        sun_elevation=conf.get(CONF_SUN_ELEVATION),
        sun_azimuth=conf.get(CONF_SUN_AZIMUTH),
        mapping=conf.get(CONF_LIGHTS, {}),
        cameras=conf.get(CONF_CAMERAS),
        name=conf.get(CONF_NAME, DEFAULT_NAME),
    )
    await coordinator.async_setup()
    hass.data.setdefault(DOMAIN, {})[YAML_CONFIG_ID] = coordinator
    _migrate_bare_entity_ids(hass, coordinator)
    await async_register_panel(hass)
    # Platform loads go through tasks (the discovery helper's own advice:
    # loading a base component can be slow, so setup does not wait).
    for platform in PLATFORMS:
        hass.async_create_task(
            async_load_platform(hass, platform, DOMAIN, {}, config)
        )
    return True
