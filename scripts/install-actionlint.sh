#!/usr/bin/env bash
set -euo pipefail

# This workflow runs on ubuntu-latest (linux/amd64). The digest is from the
# v1.7.10 release's actionlint_1.7.10_checksums.txt, pinned with the version.
version=1.7.10
checksum=f4c76b71db5755a713e6055cbb0857ed07e103e028bda117817660ebadb4386f
archive="actionlint_${version}_linux_amd64.tar.gz"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

for attempt in 1 2 3; do
  echo "Installing actionlint v$version: download attempt $attempt/3"
  if curl --fail --location --connect-timeout 15 --max-time 120 \
    --output "$stage/$archive" "https://github.com/rhysd/actionlint/releases/download/v$version/$archive"; then
    size=$(wc -c < "$stage/$archive")
    if [ "$size" -lt 1000000 ]; then
      echo "::warning::actionlint download was $size bytes, expected at least 1000000 bytes"
    elif ! printf '%s  %s\n' "$checksum" "$stage/$archive" | sha256sum --check --status; then
      echo "::warning::actionlint download checksum mismatch for v$version ($size bytes)"
    else
      tar -xzf "$stage/$archive" -C "$stage" actionlint
      install -m 755 "$stage/actionlint" ./actionlint
      ./actionlint -version
      exit 0
    fi
  else
    echo "::warning::actionlint download failed on attempt $attempt/3"
  fi
done

echo "::error::actionlint was not installed after 3 attempts; lint did not run"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "actionlint installation failed; lint did not run." >> "$GITHUB_STEP_SUMMARY"
fi
exit 1
