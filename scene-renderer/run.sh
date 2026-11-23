#!/command/with-contenv bashio
# HA Scene Renderer — S6 service script.
# Reads the add-on options, resolves the model file, and starts the Node
# render service. Installed as /etc/s6-overlay/s6-rc.d/scene-renderer/run.
# shellcheck shell=bash
set -e

bashio::log.info "Starting HA Scene Renderer..."

MODEL="$(bashio::config 'model')"
WIDTH="$(bashio::config 'width')"
HEIGHT="$(bashio::config 'height')"
LOG_LEVEL="$(bashio::config 'log_level')"

# Resolve the model: a custom GLB in /share/scene-renderer/models/ wins,
# then the models bundled in the image, then a literal path.
if [ -f "/share/scene-renderer/models/${MODEL}" ]; then
    MODEL_PATH="/share/scene-renderer/models/${MODEL}"
elif [ -f "/app/models/${MODEL}" ]; then
    MODEL_PATH="/app/models/${MODEL}"
elif [ -f "${MODEL}" ]; then
    MODEL_PATH="${MODEL}"
else
    bashio::log.fatal "Model not found: ${MODEL}"
    bashio::log.fatal "Put your .glb in /share/scene-renderer/models/ or use a bundled model (sample-apartment.glb)."
    exit 1
fi

bashio::log.info "Model: ${MODEL_PATH}"
bashio::log.info "Render size: ${WIDTH}x${HEIGHT}"

export PORT=3000
export MODEL_PATH
export WIDTH
export HEIGHT
export LOG_LEVEL

exec node /app/server.mjs
