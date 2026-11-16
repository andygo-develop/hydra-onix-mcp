#!/bin/sh
exec node "$(dirname "$0")/fake-chrome-login.mjs" "$@"
