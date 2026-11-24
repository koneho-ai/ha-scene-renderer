"""Image entities: one per selected camera, each serving its latest render."""
from __future__ import annotations

from typing import Any

from homeassistant.components.image import ImageEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, YAML_CONFIG_ID
from .coordinator import SceneRenderCoordinator


async def async_setup_platform(
    hass: HomeAssistant,
    config: dict[str, Any],
    async_add_entities: AddEntitiesCallback,
    discovery_info: Any | None = None,
) -> None:
    """Set up one image entity per selected camera (YAML setup)."""
    coordinator: SceneRenderCoordinator = hass.data[DOMAIN][YAML_CONFIG_ID]
    async_add_entities(
        [SceneRenderImage(hass, coordinator, camera) for camera in coordinator.cameras]
    )


class SceneRenderImage(ImageEntity):
    """The latest render for one camera as an image entity."""

    _attr_content_type = "image/png"

    def __init__(
        self,
        hass: HomeAssistant,
        coordinator: SceneRenderCoordinator,
        camera: str,
    ) -> None:
        super().__init__(hass)
        self.coordinator = coordinator
        self.camera = camera
        self._attr_unique_id = f"{YAML_CONFIG_ID}_render_{camera}"
        # Full name, scene included: YAML-only setups have no config
        # entry, so no device attaches (HA warns about it and drops
        # device attachment entirely in 2027.8) — with has_entity_name
        # the id would collapse to the bare camera name
        # (image.overview). The full name yields
        # image.scene_renderer_overview.
        self._attr_name = (
            f"{coordinator.name} {camera.replace('_', ' ').title()}"
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
        # The content type can change per render (a cameras.yaml edit
        # turns a still into a clip or back); read it fresh each update.
        self._attr_content_type = self.coordinator.content_type_for(self.camera)
        self.async_write_ha_state()

    async def async_image(self) -> bytes | None:
        """Return the latest render bytes for this camera (no re-render)."""
        return self.coordinator.render_for(self.camera)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Camera, image type, render time, and the projected light positions.

        ``render_ms`` is the wall-clock milliseconds the render service
        spent rendering this camera's latest image (frames + encoding
        for clips); None when the service did not report it.
        ``lights`` is one entry per model light, with the position the
        service projected it to in this camera's latest render (pixels at
        the camera's configured resolution + percentages of the image,
        ``visible`` when the light is in frame) plus the mapped entity_id
        and that entity's live state/brightness — the pieces a dashboard
        needs to overlay markers or controls on the render. Unmapped
        lights carry entity_id/state/brightness None; a light behind the
        camera carries null coordinates (see scene.mjs projectLights).
        """
        lights: list[dict[str, Any]] = []
        hass = getattr(self, "hass", None)
        for proj in self.coordinator.light_positions_for(self.camera):
            name = proj.get("name")
            entity_id = self.coordinator.script_light_mapping.get(name) if name else None
            state: str | None = None
            brightness: float | None = None
            if entity_id is not None and hass is not None:
                entity_state = hass.states.get(entity_id)
                if entity_state is not None:
                    state = entity_state.state
                    raw = entity_state.attributes.get("brightness")
                    brightness = (
                        round(raw / 255, 2)
                        if isinstance(raw, (int, float))
                        else None
                    )
            lights.append(
                {
                    "name": name,
                    "entity_id": entity_id,
                    "state": state,
                    "brightness": brightness,
                    "x_px": proj.get("x_px"),
                    "y_px": proj.get("y_px"),
                    "x_pct": proj.get("x_pct"),
                    "y_pct": proj.get("y_pct"),
                    "visible": proj.get("visible", False),
                }
            )
        return {
            "camera": self.camera,
            "content_type": self.coordinator.content_type_for(self.camera),
            "render_ms": self.coordinator.render_ms_for(self.camera),
            "lights": lights,
        }
