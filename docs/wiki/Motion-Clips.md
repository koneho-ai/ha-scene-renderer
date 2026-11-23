# Motion Clips

Any camera can render a looping animated WebP clip instead of a still. Per camera, in `cameras.yaml`:

```yaml
living_room:
  width: 800
  height: 600
  clip:
    duration: 3   # seconds per loop (0.5..30)
    fps: 10       # frames per second (1..30)
```

Frames per loop = `duration` × `fps` (2..300 frames). Defaults: **3 s @ 10 fps = 30 frames**. The clip uses the camera's configured resolution, and the image entity serves it as `image/webp`. Cameras without a `clip` entry stay stills.

## What moves

Two sources of motion:

- **glTF animations in the model** — the sample apartment's ceiling fan does one full turn per 3 s, so a 3 s clip loops seamlessly.
- **Anything `scene.js` animates** — see [[Scene Scripting]]. A clip loops seamlessly when every animated value is periodic over the loop (same value at `loop` 0 and 1).

## One frozen state per clip

The state snapshot is frozen for the whole clip: every frame sees the same light and entity state, only the time changes. If the state changes mid-clip, the frame loop aborts early and the new state renders instead — and the old clip keeps looping in Home Assistant while the new one renders.

## Cost

A clip renders `duration` × `fps` frames, so a 3 s clip at 10 fps costs ~30 still renders — **~6 s at 720p on a Pi-class host**. Keep clips short and small, and only on the cameras where motion matters.

## One thing to verify on live HA

The clips were verified end to end against a live render service (frame counts and delays checked), but an image entity serving an animated WebP **has not yet been seen animating in the Home Assistant frontend**. If you install a clip camera, check that the image entity actually animates — that is the one open verification for this feature.
