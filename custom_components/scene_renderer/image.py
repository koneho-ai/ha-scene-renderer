"""Image entities: one per selected camera, each serving its latest render."""
from __future__ import annotations

from homeassistant.components.image import ImageEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_NAME
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
    """Set up one image entity per selected camera."""
    coordinator: SceneRenderCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            SceneRenderImage(hass, coordinator, entry, camera)
            for camera in coordinator.cameras
        ]
    )


class SceneRenderImage(ImageEntity):
    """The latest render for one camera as an image entity."""

    _attr_content_type = "image/png"
    _attr_has_entity_name = True

    def __init__(
        self,
        hass: HomeAssistant,
        coordinator: SceneRenderCoordinator,
        entry: ConfigEntry,
        camera: str,
    ) -> None:
        super().__init__(hass)
        self.coordinator = coordinator
        self.camera = camera
        self._attr_unique_id = f"{entry.entry_id}_render_{camera}"
        # Snake_case camera name -> Title Case display name.
        self._attr_name = camera.replace("_", " ").title()
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.data.get(CONF_NAME, "Scene Renderer"),
            manufacturer="HA Scene Renderer",
            model="3D scene render",
        )
        if coordinator.last_rendered is not None:
            self._attr_image_last_updated = coordinator.last_rendered

    async def async_added_to_hass(self) -> None:
        """Register for coordinator updates."""
        self.async_on_remove(
            self.coordinator.async_add_listener(self._handle_coordinator_update)
        )

    def _handle_coordinator_update(self) -> None:
        """Bump image_last_updated so the frontend refetches the image."""
        if self.coordinator.last_rendered is not None:
            self._attr_image_last_updated = self.coordinator.last_rendered
        self.async_write_ha_state()

    async def async_image(self) -> bytes | None:
        """Return the latest render bytes for this camera (no re-render)."""
        return self.coordinator.png_for(self.camera)

    @property
    def extra_state_attributes(self) -> dict[str, str]:
        """Return the camera this entity renders."""
        return {"camera": self.camera}
