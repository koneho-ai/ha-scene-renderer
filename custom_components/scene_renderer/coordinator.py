"""Coordinator: watches light + sun state, drives renders.

The coordinator subscribes to state changes of the mapped light entities
and of the configured sun entity (``sun.sun`` by default, or none when
the sun is disabled in YAML). Light changes re-render on a 1-second trailing
debounce — a burst of changes collapses into one render 1 s after the
last change — with a 5-second max wait, so an entity that changes
non-stop forces a render instead of starving one. The sun re-renders
when its elevation crosses a 5-degree step, on above/below-horizon
transitions, or at most every 15 minutes while it is up. Renders are
serialized with a 2-second minimum interval and coalesced (latest state
wins).

Each update is ONE batch render request carrying the light parameters,
the sun, the subscribed entity snapshot, and the selected cameras; the
service returns one image per camera — a PNG still, or an animated WebP
clip for cameras with a clip: entry in cameras.yaml — stored in
:attr:`renders` (bytes) and :attr:`content_types`, and served by one
image entity per camera. The service also returns the projected position
of every model light in each camera's image (pixels + percentages +
in-frame flag, see scene.mjs projectLights), stored in
:attr:`light_positions`; the image entities expose them as attributes
with the mapped entity_id and live state added. The service also
reports the wall-clock milliseconds each camera's render took,
stored in :attr:`render_ms` and exposed as the image entity's
``render_ms`` attribute (``last_render_ms`` is the whole batch
including the HTTP round trip, for the status sensor).

Scripting (scene.js): the service exposes the script's ``subscribe``
list via GET /script. The coordinator resolves those patterns (exact
entity IDs, ``domain.*``, globs) against the state machine, subscribes
to the resolved entities, and sends their state in every render request
(``entities`` in the payload). When a render response carries a new
script hash, the coordinator re-fetches the subscriptions, re-subscribes,
and re-renders with the new entity set. No script -> the built-in set
(mapped lights + sun) only. The script may also declare
``objectDrivers`` (model object name -> driving entity ID); those
entities are tracked the same way, and the panel shows the objects
with their driving entity and a toggle.

The YAML ``objects`` mapping does the same for objects without a
script: model object name -> driving entity ID (e.g. the ceiling fan
-> a light). Its entities are tracked like the script's drivers, so a
change re-renders; the panel merges the YAML mapping with the
script's ``objectDrivers`` for the Objects section, YAML winning on
conflict. The mapping only links object and entity — the script (or
the panel viewer's own fan/TV handling) still does the animating.

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

from homeassistant.core import Event, HomeAssistant, State, callback
from homeassistant.helpers.event import (
    async_call_later,
    async_track_state_change_event,
)
from homeassistant.util import color as color_util
from homeassistant.util import dt as dt_util

from .const import (
    DEBOUNCE_MAX_WAIT_SECONDS,
    DEBOUNCE_SECONDS,
    DEFAULT_NAME,
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
    """Owns the render loop for the YAML-configured scene."""

    def __init__(
        self,
        hass: HomeAssistant,
        *,
        service_url: str,
        sun_entity_id: str | None = SUN_ENTITY_ID,
        sun_elevation: float | None = None,
        sun_azimuth: float | None = None,
        mapping: dict[str, str] | None = None,
        objects: dict[str, str] | None = None,
        cameras: list[str] | None = None,
        name: str = DEFAULT_NAME,
    ) -> None:
        self.hass = hass
        self.name = name
        self.service_url = service_url
        # The sun entity to follow, or None to disable the sun.
        self.sun_entity_id = sun_entity_id
        self.sun_enabled: bool = sun_entity_id is not None
        # A fixed sun position (elevation, azimuth) from YAML, or None
        # to follow the sun entity. Both coordinates together or
        # neither — the config schema enforces that; a lone value here
        # (direct construction) is ignored rather than half-applied.
        self.sun_fixed: tuple[float, float] | None = (
            (float(sun_elevation), float(sun_azimuth))
            if sun_elevation is not None and sun_azimuth is not None
            else None
        )
        self.mapping: dict[str, str] = dict(mapping or {})
        # YAML `objects` mapping: model object name -> driving entity
        # id. Its entities are tracked like the script's object
        # drivers (see _tracked_entities), and panel_data exposes the
        # mapping so the panel's Objects section can list the objects
        # without a script.
        self.objects: dict[str, str] = dict(objects or {})
        self.cameras: list[str] = list(cameras or [])
        self.service = RenderServiceClient(hass, self.service_url)

        # Latest render per camera: {camera_name: image bytes} and its
        # content type (image/png for stills, image/webp for clips).
        self.renders: dict[str, bytes] = {}
        self.content_types: dict[str, str] = {}
        # Projected light positions per camera from the latest render:
        # {camera_name: [{name, x_px, y_px, x_pct, y_pct, visible}]},
        # as returned by the service (see scene.mjs projectLights).
        # The image entities expose these as attributes, adding the
        # mapped entity_id + live state.
        self.light_positions: dict[str, list[dict[str, Any]]] = {}
        # Wall-clock milliseconds the service spent rendering each
        # camera's latest image (frames + encoding for clips), as
        # reported by the service; None when the service did not send
        # it (older versions). The image entities expose this as the
        # render_ms attribute. (last_render_ms below is the whole
        # batch including the HTTP round trip, for the status sensor.)
        self.render_ms: dict[str, int | None] = {}
        self.last_rendered: Any = None
        self.status: str = STATUS_IDLE
        self.last_error: str | None = None
        self.render_count: int = 0
        self.last_render_ms: int | None = None

        # User script (scene.js) status, from GET /script and each render
        # response: {"present", "hash", "subscribe", "object_drivers",
        # "status", "error", "last_error", "error_count"}. Starts as
        # "no script". object_drivers maps model object names to the
        # entity driving each one (the script's `objectDrivers` export);
        # the panel shows those objects with their entity and a toggle.
        self.script_status: dict[str, Any] = {
            "present": False,
            "hash": None,
            "subscribe": [],
            "object_drivers": {},
            "status": "none",
            "error": None,
            "last_error": None,
            "error_count": 0,
        }
        self._script_hash: str | None = None
        self._script_patterns: list[str] = []
        self._script_object_drivers: dict[str, str] = {}
        # Entities the script reads (resolved from the subscribe patterns
        # plus the object driver entities).
        self._script_entities: set[str] = set()

        self._listeners: list[Callable[[], None]] = []
        self._unsubs: list[Callable[[], None]] = []
        self._debounce_unsub: Callable[[], None] | None = None
        # Monotonic time the current debounce window opened (None when no
        # render is pending). A window that stays open past
        # DEBOUNCE_MAX_WAIT_SECONDS renders immediately instead of
        # rescheduling, so a constantly-changing entity cannot starve
        # renders by resetting the timer forever.
        self._debounce_since: float | None = None
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

    def light_positions_for(self, camera: str) -> list[dict[str, Any]]:
        """Projected light positions for a camera from the latest render."""
        return self.light_positions.get(camera, [])

    def render_ms_for(self, camera: str) -> int | None:
        """Milliseconds the service spent rendering a camera's latest image."""
        return self.render_ms.get(camera)

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

    def sun_position(self) -> dict[str, float] | None:
        """The sun position the renders use: fixed override, else the
        live sun entity's attributes, else None (sun disabled or no
        state yet). The panel viewer uses this so it agrees with the
        rendered images."""
        if not self.sun_enabled:
            return None
        if self.sun_fixed is not None:
            elevation, azimuth = self.sun_fixed
            return {"elevation": elevation, "azimuth": azimuth}
        state = self.hass.states.get(self.sun_entity_id)
        if state is None:
            return None
        elevation = state.attributes.get("elevation")
        azimuth = state.attributes.get("azimuth")
        if not isinstance(elevation, (int, float)) or not isinstance(
            azimuth, (int, float)
        ):
            return None
        return {"elevation": elevation, "azimuth": azimuth}

    @property
    def _tracked_entities(self) -> set[str]:
        """Every entity whose changes re-render: mapped lights + sun +
        the YAML object drivers + the script's resolved subscriptions."""
        entities = set(self.mapping.values())
        if self.sun_enabled and self.sun_fixed is None:
            entities.add(self.sun_entity_id)
        entities.update(self.objects.values())
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
        drivers = script_info.get("object_drivers") or {}
        if not isinstance(drivers, dict):
            drivers = {}
        drivers = {
            k: v
            for k, v in drivers.items()
            if isinstance(k, str) and isinstance(v, str)
        }
        self.script_status = {
            "present": script_info.get("present", False),
            "hash": script_info.get("hash"),
            "subscribe": list(script_info.get("subscribe") or []),
            "object_drivers": dict(drivers),
            "status": script_info.get("status", "none"),
            "error": script_info.get("error"),
            "last_error": script_info.get("last_error"),
            "error_count": script_info.get("error_count", 0),
        }
        new_hash = self.script_status["hash"]
        patterns = self.script_status["subscribe"]
        changed = (
            new_hash != self._script_hash
            or patterns != self._script_patterns
            or drivers != self._script_object_drivers
        )
        self._script_hash = new_hash
        self._script_patterns = patterns
        self._script_object_drivers = drivers
        if changed:
            self._script_entities = self._resolve_script_patterns(patterns)
            # The driver entities are entities the script reads too:
            # track them even when the author forgot to subscribe to
            # them, so a change re-renders (and the panel toggle feels
            # live) instead of silently doing nothing until the next
            # unrelated render.
            self._script_entities.update(drivers.values())
        return changed

    @property
    def script_entities(self) -> list[str]:
        """Entity IDs the script reads (resolved subscribe patterns plus
        object driver entities), sorted. For the panel."""
        return sorted(self._script_entities)

    @property
    def script_object_drivers(self) -> dict[str, str]:
        """Model object name -> driving entity ID, from the script's
        `objectDrivers` export. For the panel's Objects section."""
        return dict(self.script_status.get("object_drivers") or {})

    async def async_unload(self) -> None:
        """Cancel subscriptions and pending renders."""
        if self._debounce_unsub is not None:
            self._debounce_unsub()
            self._debounce_unsub = None
        self._debounce_since = None
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
        if entity_id == self.sun_entity_id:
            self._handle_sun_change()
        else:
            self._schedule_debounced_render()

    def _snapshot_sun(self) -> None:
        """Record the current sun state as the quantization baseline.

        Called at setup so the first sun change is compared against the
        state the initial render used, instead of always re-rendering.
        No-op when the sun is disabled or fixed (a fixed sun never
        changes).
        """
        if not self.sun_enabled or self.sun_fixed is not None:
            return
        state = self.hass.states.get(self.sun_entity_id)
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
        if not self.sun_enabled or self.sun_fixed is not None:
            return
        state = self.hass.states.get(self.sun_entity_id)
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
        now = time.monotonic()
        if self._debounce_since is None:
            self._debounce_since = now
        delay = DEBOUNCE_SECONDS
        if now - self._debounce_since >= DEBOUNCE_MAX_WAIT_SECONDS:
            # The window has been open too long: a constantly-changing
            # entity would otherwise keep rescheduling the timer forever.
            # Render now instead of debouncing again.
            delay = 0
        if self._debounce_unsub is not None:
            self._debounce_unsub()
        self._debounce_unsub = async_call_later(
            self.hass, delay, self._async_debounced_render
        )

    async def _async_debounced_render(self, _now: Any) -> None:
        self._debounce_unsub = None
        self._debounce_since = None
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
            self.renders = {name: data for name, (data, _, _, _) in renders.items()}
            self.content_types = {name: ctype for name, (_, ctype, _, _) in renders.items()}
            self.light_positions = {name: lights for name, (_, _, lights, _) in renders.items()}
            self.render_ms = {name: ms for name, (_, _, _, ms) in renders.items()}
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
            if self.sun_fixed is not None:
                elevation, azimuth = self.sun_fixed
                sun = {"azimuth": azimuth, "elevation": elevation}
            else:
                sun_state = self.hass.states.get(self.sun_entity_id)
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
