"""Constants for the HA Scene Renderer integration."""
from __future__ import annotations

from datetime import timedelta

DOMAIN = "scene_renderer"

# Add-on discovery (Supervisor API).
ADDON_SLUG = "scene-renderer"
ADDON_PORT = 3000

# Config entry data keys.
CONF_SERVICE_URL = "service_url"
CONF_SUN_ENABLED = "sun_enabled"

# Config entry options keys.
CONF_MAPPING = "mapping"
CONF_CAMERAS = "cameras"

SUN_ENTITY_ID = "sun.sun"

# How long to wait after a light change before rendering (coalesces bursts).
DEBOUNCE_SECONDS = 1.0
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
