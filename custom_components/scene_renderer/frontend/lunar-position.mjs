// Compact lunar position (Paul Schlyter's algorithm, "How to compute
// planetary positions"): moon elevation/azimuth for a date + local time
// + latitude/longitude. Accuracy ~0.3 deg: the orbital elements plus
// the 12 longitude / 5 latitude perturbation terms give ~0.3 deg
// geocentric, and the topocentric parallax correction below (the Moon
// is only ~60 Earth radii away, so the surface-vs-center difference
// reaches ~1 deg) keeps the as-seen position at the same accuracy.
// No dependencies, so the panel and the Node tests share this one
// implementation. The service carries an identical copy at
// scene-renderer/lunar-position.mjs — the two packages deploy
// separately and cannot share a file, so keep them in sync (the node
// tests assert they agree).
//
//   lunarPosition({ year, month, day, minutes, latitude, longitude,
//                   tzOffsetMinutes })
//     (same inputs as solarPosition in solar-position.mjs)
//     year/month/day: the calendar date (month 1..12)
//     minutes: local time, minutes from midnight (0..1439)
//     latitude/longitude: decimal degrees (north/east positive)
//     tzOffsetMinutes: Date.getTimezoneOffset() for that date — minutes
//       WEST of UTC, DST-aware (e.g. -60 for CET, -120 for CEST)
//   -> { elevation, azimuth, illumination } in degrees; azimuth
//      clockwise from north (0 = north, 90 = east, 180 = south),
//      elevation above the horizon (negative when the moon is down),
//      illumination 0..1 (0 = new, 1 = full — the renderer ignores
//      it; it is there for tests and future use).
export function lunarPosition({
  year,
  month,
  day,
  minutes,
  latitude,
  longitude,
  tzOffsetMinutes,
}) {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const norm360 = (a) => {
    let v = a % 360;
    if (v < 0) v += 360;
    return v;
  };

  // Julian day at the given UTC time (Meeus — same as solarPosition).
  const utcMinutes = minutes + tzOffsetMinutes;
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  const jd =
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day +
    b -
    1524.5 +
    utcMinutes / 1440;
  const d = jd - 2451543.5; // days since J2000.0

  // Moon's orbital elements (Schlyter).
  const N = norm360(125.1228 - 0.0529538083 * d); // longitude of ascending node
  const incl = 5.1454; // inclination
  const w = norm360(318.0634 + 0.1643573223 * d); // argument of perigee
  const aMoon = 60.2666; // mean distance, Earth radii
  const e = 0.0549; // eccentricity
  const M = norm360(115.3654 + 13.0649929509 * d); // mean anomaly

  // Solve Kepler's equation (Schlyter's one-step approximation — good
  // to ~0.001 deg at this eccentricity).
  const Mr = M * rad;
  const E = M + (180 / Math.PI) * e * Math.sin(Mr) * (1 + e * Math.cos(Mr));
  const Er = E * rad;
  const xv = aMoon * (Math.cos(Er) - e);
  const yv = aMoon * Math.sqrt(1 - e * e) * Math.sin(Er);
  const r = Math.sqrt(xv * xv + yv * yv); // distance, Earth radii
  const v = Math.atan2(yv, xv) * deg; // true anomaly

  // Geocentric ecliptic coordinates.
  const Nr = N * rad;
  const ir = incl * rad;
  const vwr = (v + w) * rad;
  const xh =
    r * (Math.cos(Nr) * Math.cos(vwr) - Math.sin(Nr) * Math.sin(vwr) * Math.cos(ir));
  const yh =
    r * (Math.sin(Nr) * Math.cos(vwr) + Math.cos(Nr) * Math.sin(vwr) * Math.cos(ir));
  const zh = r * (Math.sin(vwr) * Math.sin(ir));
  let lon = Math.atan2(yh, xh) * deg;
  let lat = Math.atan2(zh, Math.sqrt(xh * xh + yh * yh)) * deg;

  // Perturbations (Schlyter): Ms = Sun's mean anomaly, Mm = Moon's
  // mean anomaly, D = mean elongation, F = argument of latitude.
  // NOTE on epochs: the Meeus/Schlyter J2000.0 values are D = 297.8502
  // and F = 93.2721, but d counts days since Jan 0.0, 2000 (1.5 days
  // before J2000.0), so the constants here are shifted back by 1.5
  // days of motion (D: -18.286, F: -19.844) — using the J2000.0
  // constants verbatim puts D/F ~19 deg off and corrupts every
  // perturbation term (verified: with the J2000.0 constants the mean
  // elongation disagreed with the true sun-moon separation by 27 deg).
  const Ms = norm360(356.047 + 0.9856002585 * d);
  const Mm = M;
  const D = norm360(279.5642 + 12.190749141 * d);
  const F = norm360(73.4281 + 13.229350129 * d);
  const s = (x) => Math.sin(x * rad);
  lon +=
    -1.274 * s(Mm - 2 * D) +
    0.658 * s(2 * D) +
    -0.186 * s(Ms) +
    -0.059 * s(2 * Mm - 2 * D) +
    -0.057 * s(Mm - 2 * D + Ms) +
    0.053 * s(Mm + 2 * D) +
    0.046 * s(2 * D - Ms) +
    0.041 * s(Mm - Ms) +
    -0.035 * s(D) +
    -0.031 * s(Mm + Ms) +
    -0.015 * s(2 * F - 2 * D) +
    0.011 * s(2 * F - Mm);
  lat +=
    -0.173 * s(F - 2 * D) +
    -0.055 * s(Mm - F - 2 * D) +
    -0.046 * s(Mm + F - 2 * D) +
    0.033 * s(F + 2 * D) +
    0.017 * s(2 * Mm + F);

  // Ecliptic -> equatorial (RA/Dec), obliquity of the ecliptic.
  const ecl = (23.4393 - 3.563e-7 * d) * rad;
  const lonr = lon * rad;
  const latr = lat * rad;
  const xe = Math.cos(lonr) * Math.cos(latr);
  const ye =
    Math.sin(lonr) * Math.cos(latr) * Math.cos(ecl) -
    Math.sin(latr) * Math.sin(ecl);
  const ze =
    Math.sin(lonr) * Math.cos(latr) * Math.sin(ecl) +
    Math.sin(latr) * Math.cos(ecl);
  const ra = norm360(Math.atan2(ye, xe) * deg);
  const dec = Math.atan2(ze, Math.sqrt(xe * xe + ye * ye)) * deg;

  // Greenwich Mean Sidereal Time (USNO formula, hours -> degrees) and
  // Local Sidereal Time.
  const gmst = norm360((18.697374558 + 24.06570982441908 * (jd - 2451545.0)) * 15);
  const lst = norm360(gmst + longitude);

  // Topocentric correction (vector method): subtract the observer's
  // geocentric position from the Moon's geocentric position. The
  // observer sits rho Earth radii from the center at geocentric
  // latitude gclat; the Moon sits r Earth radii away at (ra, dec).
  const latR = latitude * rad;
  const gclat = (latitude - 0.1924 * Math.sin(2 * latR)) * rad;
  const rho = 0.99833 + 0.00167 * Math.cos(2 * latR);
  const lstr = lst * rad;
  const rar = ra * rad;
  const decr = dec * rad;
  const ox = rho * Math.cos(gclat) * Math.cos(lstr);
  const oy = rho * Math.cos(gclat) * Math.sin(lstr);
  const oz = rho * Math.sin(gclat);
  const mx = r * Math.cos(decr) * Math.cos(rar);
  const my = r * Math.cos(decr) * Math.sin(rar);
  const mz = r * Math.sin(decr);
  const tx = mx - ox;
  const ty = my - oy;
  const tz = mz - oz;
  const raTop = Math.atan2(ty, tx) * deg;
  const decTop = Math.atan2(tz, Math.sqrt(tx * tx + ty * ty)) * deg;

  // Hour angle -> altitude/azimuth (same formulas as solarPosition).
  let ha = norm360(lst - raTop);
  if (ha > 180) ha -= 360;
  const haR = ha * rad;
  const decTopR = decTop * rad;
  const cosZen =
    Math.sin(latR) * Math.sin(decTopR) +
    Math.cos(latR) * Math.cos(decTopR) * Math.cos(haR);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZen))) * deg;
  const elevation = 90 - zenith;
  let azimuth =
    (Math.atan2(
      Math.sin(haR),
      Math.cos(haR) * Math.sin(latR) - Math.tan(decTopR) * Math.cos(latR),
    ) *
      deg +
      180) %
    360;
  if (azimuth < 0) azimuth += 360;

  // Illuminated fraction from the mean elongation (phase angle ~180 - D).
  const illumination = (1 - Math.cos(D * rad)) / 2;
  return { elevation, azimuth, illumination };
}
