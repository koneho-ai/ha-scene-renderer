"""Config flow for the HA Scene Renderer integration.

Three steps, no free text for the mapping:

1. ``user``: name, render service URL (pre-filled by discovering the
   add-on via the Supervisor API, manual override always possible),
   sun on/off. Submitting probes the service: if the add-on is
   unreachable the flow fails with a clear error (install and start
   the add-on first), otherwise it fetches the model's lights and
   cameras and moves to step 2.
2. ``lights``: one entity picker per model light (HA light entities only),
   each optional — a light left unmapped renders at its model default.
   Skipped when the model has no named lights.
3. ``cameras``: multi-select of the scene cameras (model cameras, or
   the built-in virtual cameras when the model defines none), all
   selected by default. Each selected camera gets its own image entity.
   The step shows each camera's effective resolution (from the
   add-on's cameras.yaml, if any).

The mapping is stored as ``{model_light_name: entity_id}`` and the
camera selection as a list of names in the config entry options. The
options flow shows the same mapping + camera UI and re-enumerates the
lights and cameras from the add-on, since the model may have changed
since setup. Changing the camera selection adds/removes image entities
via the standard config-entry-reload-on-options-change pattern.
"""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_NAME
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_CAMERAS,
    CONF_MAPPING,
    CONF_SERVICE_URL,
    CONF_SUN_ENABLED,
    DOMAIN,
)
from .service import RenderServiceClient, RenderServiceError
from .supervisor import async_discover_addon_url


def build_mapping_schema(
    scene_lights: list[dict[str, Any]], current_mapping: dict[str, str]
) -> vol.Schema:
    """One optional light-entity picker per model light.

    The default is only set when a mapping already exists: an optional
    EntitySelector with a None/"" default fails validation when the user
    leaves the picker empty.
    """
    fields: dict[Any, Any] = {}
    for light in scene_lights:
        name = light["name"]
        key: Any = vol.Optional(name)
        if current_mapping.get(name):
            key = vol.Optional(name, default=current_mapping[name])
        fields[key] = selector.EntitySelector(
            selector.EntitySelectorConfig(domain="light")
        )
    return vol.Schema(fields)


def build_camera_schema(
    cameras: list[dict[str, Any]], current_selection: list[str] | None = None
) -> vol.Schema:
    """Multi-select of the scene cameras, all selected by default."""
    names = [camera["name"] for camera in cameras if camera.get("name")]
    default = (
        [name for name in current_selection if name in names]
        if current_selection
        else names
    )
    return vol.Schema(
        {
            vol.Required(CONF_CAMERAS, default=default): selector.SelectSelector(
                selector.SelectSelectorConfig(options=names, multiple=True)
            )
        }
    )


def format_camera_list(cameras: list[dict[str, Any]]) -> str:
    """One-line summary per camera: "name — WIDTH×HEIGHT"."""
    parts = []
    for camera in cameras:
        name = camera.get("name", "?")
        width = camera.get("width")
        height = camera.get("height")
        if width and height:
            parts.append(f"{name} — {width}×{height}")
        else:
            parts.append(name)
    return ", ".join(parts)


def filter_camera_selection(
    selection: list[str] | None, cameras: list[dict[str, Any]]
) -> list[str]:
    """Keep only known camera names; an empty selection means all."""
    names = [camera["name"] for camera in cameras if camera.get("name")]
    selected = [name for name in (selection or []) if name in names]
    return selected or names


class SceneRendererConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the config flow for HA Scene Renderer."""

    VERSION = 1

    def __init__(self) -> None:
        self._step1_data: dict[str, Any] | None = None
        self._scene_lights: list[dict[str, Any]] = []
        self._cameras: list[dict[str, Any]] = []
        self._mapping: dict[str, str] = {}

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        """Get the options flow for this handler."""
        return SceneRendererOptionsFlow(config_entry)

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Step 1: service URL, sun."""
        errors: dict[str, str] = {}
        discovered_url: str | None = None
        if user_input is None:
            discovered_url = await async_discover_addon_url(self.hass)

        if user_input is not None:
            url = user_input[CONF_SERVICE_URL].strip().rstrip("/")
            client = RenderServiceClient(self.hass, url)
            try:
                lights = await client.async_lights()
                cameras = await client.async_cameras()
            except RenderServiceError:
                errors["base"] = "cannot_connect"
            else:
                self._step1_data = {
                    CONF_NAME: user_input[CONF_NAME],
                    CONF_SERVICE_URL: url,
                    CONF_SUN_ENABLED: user_input[CONF_SUN_ENABLED],
                }
                self._scene_lights = lights
                self._cameras = cameras
                if not lights:
                    # Model has no named lights: nothing to map.
                    self._mapping = {}
                    return await self.async_step_cameras()
                return await self.async_step_lights()

        schema = vol.Schema(
            {
                vol.Required(CONF_NAME, default="Scene Renderer"): str,
                vol.Required(
                    CONF_SERVICE_URL, default=discovered_url or ""
                ): str,
                vol.Required(CONF_SUN_ENABLED, default=True): bool,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    async def async_step_lights(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Step 2: map each model light to an HA light entity."""
        if user_input is not None and self._step1_data is not None:
            self._mapping = {
                name: entity_id
                for name, entity_id in user_input.items()
                if entity_id
            }
            return await self.async_step_cameras()
        schema = build_mapping_schema(self._scene_lights, {})
        return self.async_show_form(
            step_id="lights",
            data_schema=schema,
            description_placeholders={"count": str(len(self._scene_lights))},
        )

    async def async_step_cameras(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Step 3: pick the cameras to render (one image entity each)."""
        if user_input is not None and self._step1_data is not None:
            cameras = filter_camera_selection(
                user_input.get(CONF_CAMERAS), self._cameras
            )
            return self.async_create_entry(
                title=self._step1_data[CONF_NAME],
                data=self._step1_data,
                options={CONF_MAPPING: self._mapping, CONF_CAMERAS: cameras},
            )
        if not self._cameras:
            # No cameras at all (should not happen — the service always
            # offers built-ins): create the entry; the coordinator falls
            # back to every camera the service offers.
            return self.async_create_entry(
                title=self._step1_data[CONF_NAME] if self._step1_data else "Scene Renderer",
                data=self._step1_data or {},
                options={CONF_MAPPING: self._mapping, CONF_CAMERAS: []},
            )
        schema = build_camera_schema(self._cameras)
        return self.async_show_form(
            step_id="cameras",
            data_schema=schema,
            description_placeholders={
                "count": str(len(self._cameras)),
                "camera_list": format_camera_list(self._cameras),
            },
        )


class SceneRendererOptionsFlow(OptionsFlow):
    """Handle the options flow: same mapping + camera UI, re-enumerated."""

    def __init__(self, config_entry: ConfigEntry) -> None:
        self.config_entry = config_entry
        self._scene_lights: list[dict[str, Any]] | None = None
        self._cameras: list[dict[str, Any]] | None = None

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Edit the service URL, sun toggle, light mapping, cameras."""
        errors: dict[str, str] = {}
        entry = self.config_entry
        current_url = (
            entry.options.get(CONF_SERVICE_URL)
            or entry.data.get(CONF_SERVICE_URL, "")
        )
        current_sun = entry.options.get(
            CONF_SUN_ENABLED, entry.data.get(CONF_SUN_ENABLED, True)
        )

        if user_input is not None:
            new_url = user_input[CONF_SERVICE_URL].strip().rstrip("/")
            client = RenderServiceClient(self.hass, new_url)
            try:
                lights = await client.async_lights()
                cameras = await client.async_cameras()
            except RenderServiceError:
                errors["base"] = "cannot_connect"
                lights = self._scene_lights or []
                cameras = self._cameras or []
            else:
                self._scene_lights = lights
                self._cameras = cameras
                known = {light["name"] for light in lights}
                mapping = {
                    name: entity_id
                    for name, entity_id in user_input.items()
                    if name in known and isinstance(entity_id, str) and entity_id
                }
                selected = filter_camera_selection(
                    user_input.get(CONF_CAMERAS), cameras
                )
                return self.async_create_entry(
                    title="",
                    data={
                        CONF_SERVICE_URL: new_url,
                        CONF_SUN_ENABLED: user_input[CONF_SUN_ENABLED],
                        CONF_MAPPING: mapping,
                        CONF_CAMERAS: selected,
                    },
                )

        if self._scene_lights is None or self._cameras is None:
            client = RenderServiceClient(self.hass, current_url)
            try:
                self._scene_lights = await client.async_lights()
                self._cameras = await client.async_cameras()
            except RenderServiceError:
                errors["base"] = "cannot_connect"
                self._scene_lights = self._scene_lights or []
                self._cameras = self._cameras or []

        fields: dict[Any, Any] = {
            vol.Required(CONF_SERVICE_URL, default=current_url): str,
            vol.Required(CONF_SUN_ENABLED, default=current_sun): bool,
        }
        fields.update(
            build_mapping_schema(
                self._scene_lights, entry.options.get(CONF_MAPPING, {})
            ).schema
        )
        if self._cameras:
            fields.update(
                build_camera_schema(
                    self._cameras, entry.options.get(CONF_CAMERAS)
                ).schema
            )
        return self.async_show_form(
            step_id="init", data_schema=vol.Schema(fields), errors=errors
        )
