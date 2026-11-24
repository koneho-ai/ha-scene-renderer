// Compact solar position (NOAA algorithm): sun elevation/azimuth for a
// date + local time + latitude/longitude. Accuracy ~0.01 deg — far more
// than the panel's sun slider needs. No dependencies, so the panel and
// the Node tests share this one implementation.
//
//   solarPosition({ year, month, day, minutes, latitude, longitude,
//                   tzOffsetMinutes })
//     year/month/day: the calendar date (month 1..12)
//     minutes: local time, minutes from midnight (0..1439)
//     latitude/longitude: decimal degrees (north/east positive)
//     tzOffsetMinutes: Date.getTimezoneOffset() for that date — minutes
//       WEST of UTC, DST-aware (e.g. -60 for CET, -120 for CEST)
//   -> { elevation, azimuth } in degrees; azimuth clockwise from north
//      (0 = north, 90 = east, 180 = south), elevation above the horizon
//      (negative at night).
export function solarPosition({
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

  // Julian day at the given UTC time (Meeus).
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

  const T = (jd - 2451545.0) / 36525.0; // Julian century
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * rad;
  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const epsilon0 =
    23 +
    (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const epsilon = epsilon0 + 0.00256 * Math.cos(omega * rad);
  const er = epsilon * rad;
  const decl = Math.asin(Math.sin(er) * Math.sin(lambda * rad)) * deg;

  // Equation of time, in minutes.
  const y2 = Math.tan(er / 2) ** 2;
  const L0r = L0 * rad;
  const eqTime =
    4 *
    deg *
    (y2 * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y2 * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y2 * y2 * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr));

  // True solar time (minutes) -> hour angle (degrees).
  let tst = (utcMinutes + eqTime + 4 * longitude) % 1440;
  if (tst < 0) tst += 1440;
  let ha = tst / 4 - 180;
  if (ha < -180) ha += 360;

  const latR = latitude * rad;
  const decR = decl * rad;
  const haR = ha * rad;
  const cosZen =
    Math.sin(latR) * Math.sin(decR) +
    Math.cos(latR) * Math.cos(decR) * Math.cos(haR);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZen))) * deg;
  const elevation = 90 - zenith;
  let azimuth =
    (Math.atan2(
      Math.sin(haR),
      Math.cos(haR) * Math.sin(latR) - Math.tan(decR) * Math.cos(latR),
    ) *
      deg +
      180) %
    360;
  if (azimuth < 0) azimuth += 360;
  return { elevation, azimuth };
}
