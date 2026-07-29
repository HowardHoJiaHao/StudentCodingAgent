# Railway builds this and runs it as the LiteLLM service.
#
# Baking config.yaml into the image is the reliable way to configure LiteLLM on
# Railway — there's no volume to mount a config file into, and doing it this way
# means the config is versioned in git alongside everything else.

FROM ghcr.io/berriai/litellm:main-stable

COPY config.yaml /app/config.yaml

# The base image sets ENTRYPOINT ["docker/prod_entrypoint.sh"], and that script
# forwards its arguments to litellm. So CMD must carry ARGUMENTS ONLY — naming
# the binary here gets it passed as an argument to itself, and shell form makes
# litellm receive "/bin/sh" as its command and exit.
#
# The entrypoint also runs the Prisma migrations, so it must not be overridden.
#
# Port is fixed at 4000 to match the image's EXPOSE. Exec form can't expand
# ${PORT}, so set PORT=4000 in Railway's Variables tab to match.
CMD ["--config", "/app/config.yaml", "--port", "4000"]
