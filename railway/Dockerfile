# Railway builds this and runs it as the LiteLLM service.
#
# Baking config.yaml into the image is the reliable way to configure LiteLLM on
# Railway — there's no volume to mount a config file into, and doing it this way
# means the config is versioned in git alongside everything else.

FROM ghcr.io/berriai/litellm:main-stable

COPY config.yaml /app/config.yaml

# Shell form on purpose: Railway assigns $PORT at runtime and the app must bind
# to it. Exec form wouldn't expand the variable.
CMD litellm --config /app/config.yaml --port ${PORT:-4000}
