// Example scene.js for the HA Scene Renderer — copy to
// /share/scene-renderer/scene.js (or the path in SCENE_SCRIPT_PATH) and
// edit to taste. The file is hot-reloaded: save it and the next render
// uses the new script.
//
// The script is a small ESM-style module:
//   - export a default function update({ entities, scene, time, loop })
//   - optionally export `const subscribe = [...]` listing the entities
//     the script reads (entity IDs, domains like "light.*", or globs
//     like "sensor.*_temperature"). The integration sends only those
//     entities (plus the mapped lights and sun.sun) and re-renders when
//     one of them changes. No subscribe list -> the script only sees
//     the mapped lights and sun.sun.
//
// Contract (important for clips):
//   - The service re-applies the built-in light/sun mapping before every
//     frame, then runs this script — so set ABSOLUTE values here, never
//     increment (there is deliberately no dt parameter).
//   - `time` is seconds since the start of the clip; `loop` is 0..1
//     across one loop of the clip. Both are OPTIONAL — destructure only
//     what you use; a script that only maps entities never mentions them.
//   - A clip loops seamlessly when every animated value is periodic over
//     the loop (same value at loop 0 and loop 1).
//   - The script runs sandboxed (SES Compartment): no process, no
//     require, no network, no imports, no eval. console.log/warn/error
//     go to the add-on log (prefixed [scene.js]).
//   - A throwing script never breaks the render: the frame renders
//     without the script's changes and the error shows in /health.

// The blinds below read the sun elevation, so subscribe to sun.sun.
// (Mapped lights are always sent, no need to list them.)
export const subscribe = ["sun.sun"];

export default function update({ entities, scene, time, loop }) {
  // 1. Ceiling fan: one whole turn per loop. loop goes 0 -> 1, so the
  //    rotation is 0 -> 2*pi — periodic, the clip loops seamlessly.
  //    NOTE: this overrides the model's own ceiling_fan_spin glTF
  //    animation (the script runs after the glTF animation is sampled).
  //    Delete this block to let the built-in animation spin the fan.
  const fan = scene.getObject("ceiling_fan");
  fan.rotation.y = loop * Math.PI * 2;

  // 2. Flickering lamp: a gentle mains-like flicker, three full sine
  //    periods per loop so it is periodic too. The built-in mapping has
  //    already set the lamp intensity from the entity state; scale it.
  const lamp = scene.getLight("living_room_lamp");
  if (lamp.visible) {
    const flicker = 0.88 + 0.12 * Math.sin(loop * Math.PI * 2 * 3);
    lamp.intensity = lamp.intensity * flicker;
  }

  // 3. Blinds follow the sun elevation: low sun -> blinds down (y 1.2),
  //    high sun -> blinds up (y 2.0). The blinds node sits at y 1.8 in
  //    the model; this sets an absolute position from the entity state.
  const sun = entities["sun.sun"];
  const elevation = sun && sun.attributes ? Number(sun.attributes.elevation) || 0 : 0;
  const raised = Math.min(1, Math.max(0, elevation / 30));
  const blinds = scene.getObject("blinds");
  blinds.position.y = 1.2 + 0.8 * raised;

  // `time` is available too (seconds since the clip started) — e.g. for
  // a value that must not loop, or a phase offset:
  //   const phase = (time * 0.5) % 1;
}
