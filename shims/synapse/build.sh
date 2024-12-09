#!/bin/bash -eu

COMMIT=$(git rev-parse --short HEAD)
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker build --build-arg "COMMIT=$COMMIT" -t "tardis-synapse:$COMMIT" .