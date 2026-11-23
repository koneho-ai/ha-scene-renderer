# Troubleshooting

## App won't start, log says "Model not found"

The `model` option names a file that is neither bundled nor in `/share/scene-renderer/models/`. Fix the name or add the file.

## App won't start, log says "failed to start render backend"

The render backend could not initialise (e.g. the model file is not a valid GLB, or the WebGL backend failed on this hardware). Check the log lines above the error; try the sample model first.

## Integration setup says it cannot reach the render service

Make sure the app is installed, started, and its log says `ready`. Install order is app first, then the integration — see [[Installation]].

## App image won't pull

The GHCR package (`ghcr.io/koneho-ai/ha-scene-renderer`) is public, so the Supervisor pulls it without credentials. If a pull fails, check that the release exists and CI published the image for that tag (the Supervisor pulls the tag matching the app `version`).

## Renders are slow

Rendering is software (CPU) on hosts without a GPU. Lower `width` / `height` in the app options, or per camera in `cameras.yaml`. Clips multiply the cost — a 3 s clip at 10 fps is 30 frame renders (~6 s at 720p on a Pi-class host). See [[Motion Clips]].

## A clip camera renders a still

The `clip:` entry is invalid (duration 0.5–30, fps 1–30 as an integer, 2–300 frames total) — an invalid entry is logged and the **whole camera entry** falls back to defaults. Check the log for `cameras.yaml` errors.

## A cameras.yaml change did nothing

The file is hot-reloaded, but a malformed file keeps the last good config — check the log for a reload message. An unknown camera name is logged and ignored; invalid values for one camera fall back to defaults for that camera only.

## My scene.js does nothing

Check `GET /script` (or the integration's Render status sensor): `status: "error"` means the script failed to compile (the message says why) and the last good script — or no script — is running. `last_error` / `error_count` show runtime throws. Also check the script's `subscribe` list: an entity the script reads but does not subscribe to is never sent. Script errors also show in `/health` and in the app log (`[scene.js]` prefix). See [[Scene Scripting]].

## Node-webgl vs Puppeteer

The service renders with three.js. Two backends, selected at image build time (`RENDER_BACKEND` build arg; the running service also honors the `RENDER_BACKEND` env var, but only a backend installed in the image can run):

- `node-webgl` (default) — three.js on `@onirenaud/node-webgl`, a real WebGL2 context in Node backed by ANGLE. No browser, smallest image. On Linux it uses Mesa (llvmpipe) when there is no GPU.
- `puppeteer` — three.js in headless Chromium (SwiftShader software GL). Heavier image, battle-tested fallback. Both backends run the same `scene.mjs`, so they render identically.

CI publishes the default **node-webgl** variant only. The puppeteer variant is not published; build it locally when needed:

```sh
docker build --build-arg RENDER_BACKEND=puppeteer scene-renderer/
```

## Force a re-render

Use the `button.<name>_re_render` diagnostic entity, or check the `sensor.<name>_render_status` diagnostic sensor for the last render time, render count, last render duration, and last error.
