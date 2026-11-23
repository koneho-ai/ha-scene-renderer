"""Coordinator: watches light + sun state, drives renders.

The coordinator subscribes to state changes of the mapped light entities
and of ``sun.sun``. Light changes re-render (debounced); the sun re-renders
when its elevation crosses a 5-degree step, on above/below-horizon
transitions, or at most every 15 minutes while it is up. Renders are
serialized with a minimum interval and coalesced (latest state wins).

Each update is ONE batch render request carrying the light parameters,
the sun, the subscribed entity snapshot, and the selected cameras; the
service returns one image per camera — a PNG still, or an animated WebP
clip for cameras with a clip: entry in cameras.yaml — stored in
:attr:`renders` (bytes) and :attr:`content_types`, and served by one
image entity per camera.

Scripting (scene.js): the service exposes the script's ``subscribe``
list via GET /script. The coordinator resolves those patterns (exact
entity IDs, ``domain.*``, globs) against the state machine, subscribes
to the resolved entities, and sends their state in every render request
(``entities`` in the payload). When a render response carries a new
script hash, the coordinator re-fetches the subscriptions, re-subscribes,
and re-renders with the new entity set. No script -> the built-in set
(mapped lights + sun) only.

Light parametrization: each mapped entity is normalized into a render
parameter set (see :func:`normalize_light_state`):

    {"on": bool, "brightness": 0.0-1.0 | None,
     "color": [r, g, b] | None, "color_temp_k": int | None}

The render service applies these on top of the model's base light values
(intensity = base x brightness; color = entity color, else Kelvin->RGB,
else the model's base color).
"""
from __future__ import annotations

import asyncio
import fnmatch
import logging
import time
from collections.abc import Callable
from datetime import date, datetime
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, State, callback
from homeassistant.helpers.event import (
    async_call_later,
    async_track_state_change_event,
)
from homeassistant.util import color as color_util
from homeassistant.util import dt as dt_util

from .const import (
    CONF_CAMERAS,
    CONF_MAPPING,
    CONF_SERVICE_URL,
    CONF_SUN_ENABLED,
    DEBOUNCE_SECONDS,
    DOMAIN,
    MIN_RENDER_INTERVAL,
    SUN_ENTITY_ID,
    SUN_MAX_INTERVAL,
    SUN_STEP_DEGREES,
)
from .service import RenderServiceClient, RenderServiceError

_LOGGER = logging.getLogger(__name__)

STATUS_IDLE = "idle"
STATUS_RENDERING = "rendering"
STATUS_OK = "ok"
STATUS_ERROR = "error"


def _rgb_color(attrs: dict[str, Any]) -> list[int] | None:
    """Entity color as [r, g, b] 0-255, from rgb/hs/xy attributes."""
    rgb = attrs.get("rgb_color")
    if rgb is not None:
        return [int(rgb[0]), int(rgb[1]), int(rgb[2])]
    hs = attrs.get("hs_color")
    if hs is not None:
        return list(color_util.color_hs_to_RGB(hs[0], hs[1]))
    xy = attrs.get("xy_color")
    if xy is not None:
        return list(color_util.color_xy_to_RGB(xy[0], xy[1]))
    return None


def _color_temp_kelvin(attrs: dict[str, Any]) -> int | None:
    """Color temperature in kelvin, from the kelvin or legacy mireds attr."""
    kelvin = attrs.get("color_temp_kelvin")
    if isinstance(kelvin, (int, float)):
        return int(kelvin)
    # Legacy attribute (current HA uses color_temp_kelvin).
    mireds = attrs.get("color_temp")
    if isinstance(mireds, (int, float)) and mireds > 0:
        return int(1_000_000 / mireds)
    return None


def normalize_light_state(state: State | None) -> dict[str, Any]:
    """Normalize an HA light state into a render parameter set.

    - on: only ``state == "on"``; unavailable/unknown/off all render as off.
    - brightness: brightness attr / 255; None when the entity has no
      brightness (on/off only) — the service treats that as 1.0.
    - color / color_temp_k: color_mode decides the priority when both are
      present (color_temp mode -> temperature, hs/xy/rgb modes -> color).
    """
    if state is None or state.state != "on":
        return {"on": False, "brightness": None, "color": None, "color_temp_k": None}
    attrs = state.attributes
    brightness = attrs.get("brightness")
    brightness = (
        brightness / 255 if isinstance(brightness, (int, float)) else None
    )
    color: list[int] | None = None
    color_temp_k: int | None = None
    if attrs.get("color_mode") == "color_temp":
        color_temp_k = _color_temp_kelvin(attrs)
    else:
        color = _rgb_color(attrs)
        if color is None:
            color_temp_k = _color_temp_kelvin(attrs)
    return {
        "on": True,
        "brightness": brightness,
        "color": color,
        "color_temp_k": color_temp_k,
    }


def _jsonable(value: Any) -> Any:
    """Recursively convert a value to something json.dumps accepts.

    HA state attributes can hold datetimes, sets, and other non-JSON
    values; the entity snapshot sent to the render service must survive
    serialization. Unknown types fall back to str().
    """
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (set, frozenset)):
        return sorted((_jsonable(v) for v in value), key=str)
    return str(value)


def _entity_snapshot(state: State | None) -> dict[str, Any] | None:
    """An entity's state + attributes as the script sees it, or None."""
    if state is None:
        return None
    return {
        "state": state.state,
        "attributes": _jsonable(dict(state.attributes)),
    }


class SceneRenderCoordinator:
    """Owns the render loop for one config entry."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.service_url: str = (
            entry.options.get(CONF_SERVICE_URL)
            or entry.data.get(CONF_SERVICE_URL, "")
        )
        self.sun_enabled: bool = entry.options.get(
            CONF_SUN_ENABLED, entry.data.get(CONF_SUN_ENABLED, True)
        )
        self.mapping: dict[str, str] = dict(entry.options.get(CONF_MAPPING, {}))
        self.cameras: list[str] = list(entry.options.get(CONF_CAMERAS, []))
        self.service = RenderServiceClient(hass, self.service_url)

        # Latest render per camera: {camera_name: image bytes} and its
        # content type (image/png for stills, image/webp for clips).
        self.renders: dict[str, bytes] = {}
        self.content_types: dict[str, str] = {}
        self.last_rendered: Any = None
        self.status: str = STATUS_IDLE
        self.last_error: str | None = None
        self.render_count: int = 0
        self.last_render_ms: int | None = None

        # User script (scene.js) status, from GET /script and each render
        # response: {"present", "hash", "subscribe", "status", "error",
        # "last_error", "error_count"}. Starts as "no script".
        self.script_status: dict[str, Any] = {
            "present": False,
            "hash": None,
            "subscribe": [],
            "status": "none",
            "error": None,
            "last_error": None,
            "error_count": 0,
        }
        self._script_hash: str | None = None
        self._script_patterns: list[str] = []
        # Entities the script reads (resolved from the subscribe patterns).
        self._script_entities: set[str] = set()

        self._listeners: list[Callable[[], None]] = []
        self._unsubs: list[Callable[[], None]] = []
        self._debounce_unsub: Callable[[], None] | None = None
        self._render_lock = asyncio.Lock()
        self._render_pending = False
        self._last_render_at = 0.0
        self._sun_above: bool | None = None
        self._sun_last_step: int | None = None
        self._sun_last_render_at = 0.0

    # -- lifecycle ------------------------------------------------------
    async def async_setup(self) -> None:
        """Subscribe to state changes and do the initial render."""
        if not self.cameras:
            # No cameras stored (e.g. an entry from before cameras
            # existed): fall back to every camera the service offers.
            try:
                cameras = await self.service.async_cameras()
            except RenderServiceError as err:
                _LOGGER.warning("Could not list cameras, no cameras to render: %s", err)
            else:
                self.cameras = [c["name"] for c in cameras if c.get("name")]
        # Fetch the script's subscriptions before subscribing, so the
        # initial render already carries the entities the script reads.
        # A failure here is not fatal: the built-in set still renders,
        # and the next render response carries the script status again.
        try:
            script_info = await self.service.async_script()
        except RenderServiceError as err:
            _LOGGER.warning("Could not fetch scene.js status, rendering without a script: %s", err)
        else:
            self._update_script_subscription(script_info)
        self._subscribe_to_tracked_entities()
        # Snapshot the sun baseline BEFORE the initial render: otherwise the
        # first sun change after setup always re-renders (baseline None),
        # defeating the 5-degree quantization.
        self._snapshot_sun()
        await self.async_request_render()

    def render_for(self, camera: str) -> bytes | None:
        """Latest render bytes for a camera, or None if not rendered yet."""
        return self.renders.get(camera)

    def content_type_for(self, camera: str) -> str:
        """Content type of the latest render for a camera."""
        return self.content_types.get(camera, "image/png")

    # -- script subscriptions -------------------------------------------
    def _resolve_script_patterns(self, patterns: list[str]) -> set[str]:
        """Resolve subscribe patterns to entity IDs.

        Exact entity IDs are kept unconditionally (the entity may not
        exist yet — it is still worth tracking). Patterns containing
        glob characters are matched against the current state machine
        (``domain.*`` is just a glob here).
        """
        resolved: set[str] = set()
        entity_ids = self.hass.states.async_entity_ids()
        for pattern in patterns:
            if not isinstance(pattern, str) or not pattern:
                continue
            if any(ch in pattern for ch in "*?["):
                resolved.update(fnmatch.filter(entity_ids, pattern))
            else:
                resolved.add(pattern)
        return resolved

    @property
    def _tracked_entities(self) -> set[str]:
        """Every entity whose changes re-render: mapped lights + sun +
        the script's resolved subscriptions."""
        entities = set(self.mapping.values())
        if self.sun_enabled:
            entities.add(SUN_ENTITY_ID)
        entities.update(self._script_entities)
        return entities

    def _subscribe_to_tracked_entities(self) -> None:
        """(Re)subscribe to state changes of the tracked entities."""
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        entities = self._tracked_entities
        if entities:
            self._unsubs.append(
                async_track_state_change_event(
                    self.hass, list(entities), self._async_state_changed
                )
            )

    def _update_script_subscription(self, script_info: dict[str, Any]) -> bool:
        """Apply a script status block. Returns True if the script's
        subscriptions changed (caller re-subscribes and re-renders)."""
        self.script_status = {
            "present": script_info.get("present", False),
            "hash": script_info.get("hash"),
            "subscribe": list(script_info.get("subscribe") or []),
            "status": script_info.get("status", "none"),
            "error": script_info.get("error"),
            "last_error": script_info.get("last_error"),
            "error_count": script_info.get("error_count", 0),
        }
        new_hash = self.script_status["hash"]
        patterns = self.script_status["subscribe"]
        changed = new_hash != self._script_hash or patterns != self._script_patterns
        self._script_hash = new_hash
        self._script_patterns = patterns
        if changed:
            self._script_entities = self._resolve_script_patterns(patterns)
        return changed

    async def async_unload(self) -> None:
        """Cancel subscriptions and pending renders."""
        if self._debounce_unsub is not None:
            self._debounce_unsub()
            self._debounce_unsub = None
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        self._listeners.clear()

    # -- listeners (entities) -------------------------------------------
    def async_add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Register a listener; returns an unsubscribe callable."""
        self._listeners.append(listener)

        def _unsub() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return _unsub

    def _notify(self) -> None:
        for listener in list(self._listeners):
            listener()

    # -- state tracking -------------------------------------------------
    @callback
    def _async_state_changed(self, event: Event) -> None:
        entity_id = event.data.get("entity_id")
        if entity_id == SUN_ENTITY_ID:
            self._handle_sun_change()
        else:
            self._schedule_debounced_render()

    def _snapshot_sun(self) -> None:
        """Record the current sun state as the quantization baseline.

        Called at setup so the first sun change is compared against the
        state the initial render used, instead of always re-rendering.
        """
        if not self.sun_enabled:
            return
        state = self.hass.states.get(SUN_ENTITY_ID)
        if state is None:
            return
        elevation = state.attributes.get("elevation")
        if not isinstance(elevation, (int, float)):
            return
        self._sun_above = state.state == "above_horizon"
        self._sun_last_step = int(elevation // SUN_STEP_DEGREES)
        self._sun_last_render_at = time.monotonic()

    def _handle_sun_change(self) -> None:
        """Decide whether a sun update warrants a re-render (quantized)."""
        state = self.hass.states.get(SUN_ENTITY_ID)
        if state is None:
            return
        above = state.state == "above_horizon"
        elevation = state.attributes.get("elevation")
        if not isinstance(elevation, (int, float)):
            return
        step = int(elevation // SUN_STEP_DEGREES)
        now = time.monotonic()
        should_render = (
            self._sun_above is None
            or above != self._sun_above
            or step != self._sun_last_step
            or (above and now - self._sun_last_render_at >= SUN_MAX_INTERVAL.total_seconds())
        )
        self._sun_above = above
        self._sun_last_step = step
        if should_render:
            self._sun_last_render_at = now
            self._schedule_debounced_render()

    def _schedule_debounced_render(self) -> None:
        if self._debounce_unsub is not None:
            self._debounce_unsub()
        self._debounce_unsub = async_call_later(
            self.hass, DEBOUNCE_SECONDS, self._async_debounced_render
        )

    async def _async_debounced_render(self, _now: Any) -> None:
        self._debounce_unsub = None
        await self.async_request_render()

    # -- rendering ------------------------------------------------------
    async def async_request_render(self) -> None:
        """Request a render. Serialized; concurrent requests coalesce."""
        if self._render_lock.locked():
            self._render_pending = True
            return
        async with self._render_lock:
            while True:
                elapsed = time.monotonic() - self._last_render_at
                remaining = MIN_RENDER_INTERVAL.total_seconds() - elapsed
                if remaining > 0:
                    await asyncio.sleep(remaining)
                await self._async_render()
                if not self._render_pending:
                    break
                self._render_pending = False

    async def _async_render(self) -> None:
        self.status = STATUS_RENDERING
        self._notify()
        if not self.cameras:
            self.status = STATUS_ERROR
            self.last_error = "no cameras selected"
            self._notify()
            return
        payload = self._build_payload()
        started = time.monotonic()
        try:
            renders, script_info = await self.service.async_render(payload)
        except RenderServiceError as err:
            self.status = STATUS_ERROR
            self.last_error = str(err)
        else:
            self.renders = {name: data for name, (data, _) in renders.items()}
            self.content_types = {name: ctype for name, (_, ctype) in renders.items()}
            self.last_rendered = dt_util.utcnow()
            self.status = STATUS_OK
            self.last_error = None
            self.render_count += 1
            self.last_render_ms = int((time.monotonic() - started) * 1000)
            self._last_render_at = time.monotonic()
            # A new script hash means scene.js changed: re-resolve its
            # subscriptions and re-render with the new entity set. (The
            # re-render's response carries the same hash, so this does
            # not loop.)
            if script_info and self._update_script_subscription(script_info):
                self._subscribe_to_tracked_entities()
                self._render_pending = True
        self._notify()

    def _build_payload(self) -> dict[str, Any]:
        lights = {
            model_name: normalize_light_state(self.hass.states.get(entity_id))
            for model_name, entity_id in self.mapping.items()
        }
        sun: dict[str, Any] | None = None
        if self.sun_enabled:
            sun_state = self.hass.states.get(SUN_ENTITY_ID)
            if sun_state is not None:
                sun = {
                    "azimuth": sun_state.attributes.get("azimuth"),
                    "elevation": sun_state.attributes.get("elevation"),
                }
        # Entity snapshot for the user script: mapped lights + sun + the
        # script's subscriptions, sanitized to JSON-safe values. Entities
        # that do not exist (yet) are omitted.
        entities: dict[str, Any] = {}
        for entity_id in sorted(self._tracked_entities):
            snapshot = _entity_snapshot(self.hass.states.get(entity_id))
            if snapshot is not None:
                entities[entity_id] = snapshot
        return {
            "lights": lights,
            "sun": sun,
            "entities": entities,
            "cameras": list(self.cameras),
        }
