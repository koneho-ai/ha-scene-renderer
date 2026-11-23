"""Button entity: force a re-render (diagnostic)."""
from __future__ import annotations

from typing import Any

from homeassistant.components.button import ButtonEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, YAML_CONFIG_ID
from .coordinator import SceneRenderCoordinator


async def async_setup_platform(
    hass: HomeAssistant,
    config: dict[str, Any],
    async_add_entities: AddEntitiesCallback,
    discovery_info: Any | None = None,
) -> None:
    """Set up the re-render button (YAML setup)."""
    coordinator: SceneRenderCoordinator = hass.data[DOMAIN][YAML_CONFIG_ID]
    async_add_entities([SceneRenderButton(coordinator)])


class SceneRenderButton(ButtonEntity):
    """Force a re-render of the scene."""

    _attr_has_entity_name = True
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: SceneRenderCoordinator) -> None:
        self.coordinator = coordinator
        self._attr_unique_id = f"{YAML_CONFIG_ID}_rerender"
        self._attr_name = "Re-render"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, YAML_CONFIG_ID)},
            name=coordinator.name,
            manufacturer="HA Scene Renderer",
            model="3D scene render",
        )

    async def async_press(self) -> None:
        """Request a render with the current state."""
        await self.coordinator.async_request_render()
