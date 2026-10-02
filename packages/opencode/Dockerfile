FROM alpine AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
RUN apk add libgcc libstdc++ ripgrep

FROM base AS build-amd64
COPY dist/yukioshi-linux-x64-baseline-musl/bin/yukioshi /usr/local/bin/yukioshi

FROM base AS build-arm64
COPY dist/yukioshi-linux-arm64-musl/bin/yukioshi /usr/local/bin/yukioshi

ARG TARGETARCH
FROM build-${TARGETARCH}
RUN yukioshi --version
ENTRYPOINT ["yukioshi"]
