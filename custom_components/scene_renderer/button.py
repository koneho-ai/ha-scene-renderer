"""Button entity: force a re-render (diagnostic)."""
from __future__ import annotations

from homeassistant.components.button import ButtonEntity
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
    """Set up the re-render button."""
    coordinator: SceneRenderCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([SceneRenderButton(coordinator, entry)])


class SceneRenderButton(ButtonEntity):
    """Force a re-render of the scene."""

    _attr_has_entity_name = True
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: SceneRenderCoordinator, entry: ConfigEntry) -> None:
        self.coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_rerender"
        self._attr_name = "Re-render"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.data.get(CONF_NAME, "Scene Renderer"),
            manufacturer="HA Scene Renderer",
            model="3D scene render",
        )

    async def async_press(self) -> None:
        """Request a render with the current state."""
        await self.coordinator.async_request_render()
