"""Constants for the HA Scene Renderer integration."""
from __future__ import annotations

from datetime import timedelta

DOMAIN = "scene_renderer"

# Add-on discovery (Supervisor API).
ADDON_SLUG = "scene-renderer"
ADDON_PORT = 3000

# YAML configuration keys (configuration.yaml, domain `scene_renderer`).
# The integration is YAML-only: there is no config flow.
CONF_SERVICE_URL = "service_url"
CONF_SUN_ENTITY = "sun_entity"
CONF_SUN_ELEVATION = "sun_elevation"
CONF_SUN_AZIMUTH = "sun_azimuth"
CONF_LIGHTS = "lights"
CONF_CAMERAS = "cameras"

# Default sun entity, and the default scene name.
SUN_ENTITY_ID = "sun.sun"
DEFAULT_NAME = "Scene Renderer"

# YAML-only setup has a single instance, identified as "yaml" everywhere
# an id is needed: the hass.data key, entity unique_ids, and the panel
# API's entry_id. (There is no device: YAML-only setups have no config
# entry, so no device attaches — see image.py.)
YAML_CONFIG_ID = "yaml"

# How long to wait after a light change before rendering (coalesces bursts).
DEBOUNCE_SECONDS = 1.0
# Longest a debounce window may stay open: a change arriving after the
# window has been open this long renders immediately instead of
# rescheduling, so a constantly-changing entity cannot starve renders.
DEBOUNCE_MAX_WAIT_SECONDS = 5.0
# Minimum time between two renders.
MIN_RENDER_INTERVAL = timedelta(seconds=2)
# The sun re-renders when its elevation crosses a step of this size, on
# above/below-horizon transitions, or at most this often while it is up.
SUN_STEP_DEGREES = 5.0
SUN_MAX_INTERVAL = timedelta(minutes=15)

# HTTP timeout for a single render request.
RENDER_TIMEOUT = 60
# HTTP timeout for health/lights probes.
PROBE_TIMEOUT = 10
