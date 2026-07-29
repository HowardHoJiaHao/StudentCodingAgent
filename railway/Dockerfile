# Railway builds this and runs it as the LiteLLM service.
#
# Baking config.yaml into the image is the reliable way to configure LiteLLM on
# Railway — there's no volume to mount a config file into, and doing it this way
# means the config is versioned in git alongside everything else.

FROM ghcr.io/berriai/litellm:main-stable

# Python buffers stdout when it isn't a TTY, so a container that dies during
# startup takes its logs with it — Railway shows "Starting Container" and
# nothing else. Unbuffered output means the crash reason actually reaches the
# log before the process goes away.
ENV PYTHONUNBUFFERED=1

COPY config.yaml /app/config.yaml

# The base image sets ENTRYPOINT ["docker/prod_entrypoint.sh"], and that script
# forwards its arguments to litellm. So CMD must carry ARGUMENTS ONLY — naming
# the binary here gets it passed as an argument to itself, and shell form makes
# litellm receive "/bin/sh" as its command and exit.
#
# The entrypoint also runs the Prisma migrations, so it must not be overridden.
#
# Railway assigns $PORT at runtime and proxies to it, so the app has to bind
# whatever it is rather than a fixed number. Exec-form CMD can't expand a
# variable, so wrap the image's own entrypoint in a shell that can — `exec`
# keeps it as PID 1 so Railway's stop signals still reach it.
#
# CMD is cleared because the base image sets CMD ["--port","4000"]; leaving it
# would append stray positional args to the shell above.
ENTRYPOINT ["/bin/sh", "-c", "exec /app/docker/prod_entrypoint.sh --config /app/config.yaml --port ${PORT:-4000}"]
CMD []
