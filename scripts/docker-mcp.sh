#!/usr/bin/env bash
# Wrapper script for running the Google Drive MCP server in Docker.
# Reuses an existing container instead of creating a new one each time.
#
# Usage:
#   ./scripts/docker-mcp.sh [container-name]
#
# The container name defaults to "google-drive-mcp".

set -euo pipefail

CONTAINER_NAME="${1:-google-drive-mcp}"
IMAGE_NAME="google-drive-mcp"

STATE="$(docker inspect --format '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null)" || STATE="missing"

case "$STATE" in
  running)
    # Container already running — exec a new MCP session
    ;;
  exited|created)
    # Container exists but stopped — start it
    docker start "$CONTAINER_NAME" >/dev/null 2>&1
    ;;
  missing)
    # No container yet — create one in the background with sleep so it stays alive
    docker run -d \
      --name "$CONTAINER_NAME" \
      --entrypoint sleep \
      -v "${GOOGLE_DRIVE_OAUTH_CREDENTIALS:-$HOME/.config/google-drive-mcp/gcp-oauth.keys.json}:/config/gcp-oauth.keys.json:ro" \
      -v "${GOOGLE_DRIVE_MCP_TOKEN_PATH:-$HOME/.config/google-drive-mcp/tokens.json}:/config/tokens.json" \
      "$IMAGE_NAME" \
      infinity >/dev/null 2>&1
    ;;
  *)
    echo "Unexpected container state: $STATE" >&2
    exit 1
    ;;
esac

# Wait for the container to be running (covers start and run -d cases)
for _i in 1 2 3 4 5 6 7 8 9 10; do
  S="$(docker inspect --format '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null)" || S=""
  [ "$S" = "running" ] && break
  sleep 0.5
done
if [ "$S" != "running" ]; then
  echo "Container $CONTAINER_NAME failed to reach running state (current: $S)" >&2
  exit 1
fi

# Run the MCP server via exec — stdin/stdout are connected to the client
exec docker exec -i "$CONTAINER_NAME" node dist/index.js
