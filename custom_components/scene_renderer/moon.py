"""Lunar position for the Scene Renderer (Python port of the JS
``lunar-position.mjs`` used by the service and the panel).

Compact lunar position (Paul Schlyter's algorithm, "How to compute
planetary positions"): moon elevation/azimuth for a datetime +
latitude/longitude. Accuracy ~0.3 deg: the orbital elements plus the
12 longitude / 5 latitude perturbation terms give ~0.3 deg
geocentric, and the topocentric parallax correction below (the Moon is
only ~60 Earth radii away, so the surface-vs-center difference reaches
~1 deg) keeps the as-seen position at the same accuracy. No
dependencies beyond the standard library.

The coordinator calls :func:`moon_position` with ``dt_util.utcnow()``
and the HA config lat/lon, and passes the result in the render payload
and panel_data exactly like the sun field, so the service's moonlight
and the panel viewer's moon agree.

Validated against weather.com's Zurich moonrise/moonset (Nov 24-25,
2026): at the published rise/set times the computed elevation is
-0.80..-0.91 deg, i.e. within ~0.1 deg of the -0.83 deg the
rise/set definition implies (0.57 deg refraction + 0.27 deg lunar
semidiameter). Keep this file in sync with the JS implementation —
the Python tests check the same reference values as the node tests.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

# Julian day of the Unix epoch (1970-01-01 00:00 UTC).
_JD_UNIX_EPOCH = 2440587.5


def _norm360(angle: float) -> float:
    value = angle % 360.0
    return value if value >= 0 else value + 360.0


def moon_position(
    when: datetime, latitude: float, longitude: float
) -> dict[str, float]:
    """Moon position at ``when`` for ``latitude``/``longitude``.

    ``when`` must be timezone-aware (any zone; converted to UTC).
    Returns ``{"elevation": ..., "azimuth": ..., "illumination": ...}``
    in degrees: azimuth clockwise from north (0 = north, 90 = east,
    180 = south), elevation above the horizon (negative when the moon
    is down), illumination 0..1 (0 = new, 1 = full).
    """
    if when.tzinfo is None:
        raise ValueError("moon_position needs a timezone-aware datetime")
    utc = when.astimezone(timezone.utc)
    jd = (utc - datetime(1970, 1, 1, tzinfo=timezone.utc)).total_seconds() / 86400.0 + _JD_UNIX_EPOCH
    d = jd - 2451543.5  # days since Jan 0.0, 2000 (Schlyter's day number)

    # Moon's orbital elements (Schlyter).
    node = _norm360(125.1228 - 0.0529538083 * d)  # longitude of ascending node
    incl = 5.1454  # inclination
    perigee = _norm360(318.0634 + 0.1643573223 * d)  # argument of perigee
    dist = 60.2666  # mean distance, Earth radii
    ecc = 0.0549  # eccentricity
    anomaly = _norm360(115.3654 + 13.0649929509 * d)  # mean anomaly

    # Solve Kepler's equation (Schlyter's one-step approximation).
    anomaly_rad = math.radians(anomaly)
    eccentric = anomaly + (180.0 / math.pi) * ecc * math.sin(anomaly_rad) * (
        1 + ecc * math.cos(anomaly_rad)
    )
    eccentric_rad = math.radians(eccentric)
    xv = dist * (math.cos(eccentric_rad) - ecc)
    yv = dist * math.sqrt(1 - ecc * ecc) * math.sin(eccentric_rad)
    radius = math.hypot(xv, yv)  # distance, Earth radii
    true_anomaly = math.degrees(math.atan2(yv, xv))

    # Geocentric ecliptic coordinates.
    node_rad = math.radians(node)
    incl_rad = math.radians(incl)
    vw_rad = math.radians(true_anomaly + perigee)
    xh = radius * (
        math.cos(node_rad) * math.cos(vw_rad)
        - math.sin(node_rad) * math.sin(vw_rad) * math.cos(incl_rad)
    )
    yh = radius * (
        math.sin(node_rad) * math.cos(vw_rad)
        + math.cos(node_rad) * math.sin(vw_rad) * math.cos(incl_rad)
    )
    zh = radius * (math.sin(vw_rad) * math.sin(incl_rad))
    lon = math.degrees(math.atan2(yh, xh))
    lat = math.degrees(math.atan2(zh, math.hypot(xh, yh)))

    # Perturbations (Schlyter). NOTE on epochs: the Meeus/Schlyter
    # J2000.0 values are D = 297.8502 and F = 93.2721, but d counts
    # days since Jan 0.0, 2000 (1.5 days before J2000.0), so the
    # constants here are shifted back by 1.5 days of motion (D:
    # -18.286, F: -19.844) — using the J2000.0 constants verbatim puts
    # D/F ~19 deg off and corrupts every perturbation term.
    sun_anomaly = _norm360(356.047 + 0.9856002585 * d)
    moon_anomaly = anomaly
    elong = _norm360(279.5642 + 12.190749141 * d)
    arg_lat = _norm360(73.4281 + 13.229350129 * d)

    def s(angle: float) -> float:
        return math.sin(math.radians(angle))

    lon += (
        -1.274 * s(moon_anomaly - 2 * elong)
        + 0.658 * s(2 * elong)
        - 0.186 * s(sun_anomaly)
        - 0.059 * s(2 * moon_anomaly - 2 * elong)
        - 0.057 * s(moon_anomaly - 2 * elong + sun_anomaly)
        + 0.053 * s(moon_anomaly + 2 * elong)
        + 0.046 * s(2 * elong - sun_anomaly)
        + 0.041 * s(moon_anomaly - sun_anomaly)
        - 0.035 * s(elong)
        - 0.031 * s(moon_anomaly + sun_anomaly)
        - 0.015 * s(2 * arg_lat - 2 * elong)
        + 0.011 * s(2 * arg_lat - moon_anomaly)
    )
    lat += (
        -0.173 * s(arg_lat - 2 * elong)
        - 0.055 * s(moon_anomaly - arg_lat - 2 * elong)
        - 0.046 * s(moon_anomaly + arg_lat - 2 * elong)
        + 0.033 * s(arg_lat + 2 * elong)
        + 0.017 * s(2 * moon_anomaly + arg_lat)
    )

    # Ecliptic -> equatorial (RA/Dec), obliquity of the ecliptic.
    ecl = math.radians(23.4393 - 3.563e-7 * d)
    lon_rad = math.radians(lon)
    lat_rad = math.radians(lat)
    xe = math.cos(lon_rad) * math.cos(lat_rad)
    ye = (
        math.sin(lon_rad) * math.cos(lat_rad) * math.cos(ecl)
        - math.sin(lat_rad) * math.sin(ecl)
    )
    ze = (
        math.sin(lon_rad) * math.cos(lat_rad) * math.sin(ecl)
        + math.sin(lat_rad) * math.cos(ecl)
    )
    ra = _norm360(math.degrees(math.atan2(ye, xe)))
    dec = math.degrees(math.atan2(ze, math.hypot(xe, ye)))

    # Greenwich Mean Sidereal Time (USNO formula) and Local Sidereal Time.
    gmst = _norm360((18.697374558 + 24.06570982441908 * (jd - 2451545.0)) * 15)
    lst = _norm360(gmst + longitude)

    # Topocentric correction (vector method): subtract the observer's
    # geocentric position from the Moon's geocentric position.
    lat_rad = math.radians(latitude)
    gclat = math.radians(latitude - 0.1924 * math.sin(2 * lat_rad))
    rho = 0.99833 + 0.00167 * math.cos(2 * lat_rad)
    lst_rad = math.radians(lst)
    ra_rad = math.radians(ra)
    dec_rad = math.radians(dec)
    ox = rho * math.cos(gclat) * math.cos(lst_rad)
    oy = rho * math.cos(gclat) * math.sin(lst_rad)
    oz = rho * math.sin(gclat)
    mx = radius * math.cos(dec_rad) * math.cos(ra_rad)
    my = radius * math.cos(dec_rad) * math.sin(ra_rad)
    mz = radius * math.sin(dec_rad)
    tx, ty, tz = mx - ox, my - oy, mz - oz
    ra_top = math.degrees(math.atan2(ty, tx))
    dec_top = math.degrees(math.atan2(tz, math.hypot(tx, ty)))

    # Hour angle -> altitude/azimuth (same formulas as solarPosition).
    ha = _norm360(lst - ra_top)
    if ha > 180:
        ha -= 360
    ha_rad = math.radians(ha)
    dec_top_rad = math.radians(dec_top)
    cos_zen = (
        math.sin(lat_rad) * math.sin(dec_top_rad)
        + math.cos(lat_rad) * math.cos(dec_top_rad) * math.cos(ha_rad)
    )
    cos_zen = min(1.0, max(-1.0, cos_zen))
    elevation = 90.0 - math.degrees(math.acos(cos_zen))
    azimuth = (
        math.degrees(
            math.atan2(
                math.sin(ha_rad),
                math.cos(ha_rad) * math.sin(lat_rad)
                - math.tan(dec_top_rad) * math.cos(lat_rad),
            )
        )
        + 180.0
    ) % 360.0

    # Illuminated fraction from the mean elongation.
    illumination = (1 - math.cos(math.radians(elong))) / 2
    return {"elevation": elevation, "azimuth": azimuth, "illumination": illumination}
