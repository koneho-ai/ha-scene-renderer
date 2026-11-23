"""Sensor entity: render status (diagnostic)."""
from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_NAME, EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import SceneRenderCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the render status sensor."""
    coordinator: SceneRenderCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([SceneRenderSensor(coordinator, entry)])


class SceneRenderSensor(SensorEntity):
    """Render status: idle, rendering, ok, or error."""

    _attr_has_entity_name = True
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: SceneRenderCoordinator, entry: ConfigEntry) -> None:
        self.coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_status"
        self._attr_name = "Render status"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.data.get(CONF_NAME, "Scene Renderer"),
            manufacturer="HA Scene Renderer",
            model="3D scene render",
        )

    async def async_added_to_hass(self) -> None:
        """Register for coordinator updates."""
        self.async_on_remove(
            self.coordinator.async_add_listener(self.async_write_ha_state)
        )

    @property
    def native_value(self) -> str:
        """Return the render status."""
        return self.coordinator.status

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return render diagnostics."""
        coordinator = self.coordinator
        script = coordinator.script_status
        return {
            "last_render": (
                coordinator.last_rendered.isoformat()
                if coordinator.last_rendered is not None
                else None
            ),
            "renders": coordinator.render_count,
            "last_render_ms": coordinator.last_render_ms,
            "last_error": coordinator.last_error,
            "service_url": coordinator.service_url,
            "cameras": list(coordinator.cameras),
            "mapped_lights": len(coordinator.mapping),
            "script_status": script.get("status"),
            "script_hash": script.get("hash"),
            "script_subscriptions": list(script.get("subscribe") or []),
            "script_error": script.get("error"),
            "script_last_error": script.get("last_error"),
            "script_error_count": script.get("error_count", 0),
        }
