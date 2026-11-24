FROM golang:1.24-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/galene . && \
    CGO_ENABLED=0 go build -trimpath -o /out/galenectl ./galenectl

FROM alpine:3.22

RUN apk add --no-cache ca-certificates && \
    addgroup -S -g 10001 galene && \
    adduser -S -D -H -u 10001 -G galene galene && \
    mkdir -p /var/lib/galene/data /var/lib/galene/groups /var/lib/galene/recordings && \
    chown -R galene:galene /var/lib/galene

COPY --from=build /out/galene /out/galenectl /usr/local/bin/
COPY --chown=galene:galene static/ /opt/galene/static/
WORKDIR /var/lib/galene
ENV HOME=/var/lib/galene/data
ENV XDG_CONFIG_HOME=/var/lib/galene/data/.config
USER 10001:10001
EXPOSE 8443/tcp 1194/tcp 1194/udp 10000/udp
ENTRYPOINT ["/usr/local/bin/galene"]
CMD ["-static", "/opt/galene/static", "-udp-range", "10000"]
