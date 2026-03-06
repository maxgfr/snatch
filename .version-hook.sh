#!/usr/bin/env bash
# Called by semantic-release to update VERSION in download.sh
set -euo pipefail
VERSION="$1"
sed -i.bak "s/^VERSION=\".*\"/VERSION=\"$VERSION\"/" download.sh
rm -f download.sh.bak
