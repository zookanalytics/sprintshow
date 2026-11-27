#!/usr/bin/env bash
# Decides what a run of publish.yml does, from package.json in the checkout of
# $GITHUB_SHA. It writes to $GITHUB_OUTPUT the version, publish (true when npm lacks the
# version, so this run publishes it), release (true when this run creates the version's
# GitHub release), previous (the tag that release's notes start from) and latest (true
# when that release becomes the repository's Latest release).
#
# npm records the commit it published a version from as its gitHead, and the release goes
# on that commit. So a re-run of the run that published finishes a missing release, and a
# later push tags nothing. The notes start from the last release tag in that commit's
# history, and the release is Latest only when no later commit has a release tag. So a
# re-run made after a newer release still takes the changes since the release before its
# own, and leaves the newer release marked Latest.
set -euo pipefail

version=$(jq -r .version package.json)
spec=$(jq -r .name package.json)@$version
# E404 means npm lacks the version, and any other error fails the run.
if view=$(npm view "$spec" version gitHead --json 2>"$RUNNER_TEMP/npm-view.log"); then
  publish=false
  published_from=$(jq -r '(if type == "array" then .[0] else . end) | objects | .gitHead // empty' <<<"$view")
  echo "npm has $spec, published from ${published_from:-a commit it did not record}."
elif [ "$(jq -r '.error.code? // empty' <<<"$view")" = E404 ]; then
  publish=true
  published_from=$GITHUB_SHA
  echo "npm lacks $spec, so this run publishes it."
else
  printf '%s\n' "$view"
  cat "$RUNNER_TEMP/npm-view.log"
  exit 1
fi
release=false
previous=
latest=
if gh release view "v$version" >/dev/null 2>&1; then
  echo "v$version has its release."
elif [ "$published_from" = "$GITHUB_SHA" ]; then
  release=true
  previous=$(git describe --tags --abbrev=0 --match 'v[0-9]*' "$GITHUB_SHA^")
  echo "v$version gets its release on this commit, with notes from $previous."
  # GitHub marks a new release Latest unless the request says not to.
  later=$(git tag --list 'v[0-9]*' --contains "$GITHUB_SHA" --no-merged "$GITHUB_SHA")
  if [ -z "$later" ]; then
    latest=true
    echo "The release is marked Latest, since no later commit has a release tag."
  else
    latest=false
    echo "The release is not marked Latest, since a later commit has a release tag: ${later//$'\n'/ }."
  fi
else
  echo "$spec was not published from this commit, so this run tags nothing."
fi
{
  echo "version=$version"
  echo "publish=$publish"
  echo "release=$release"
  echo "previous=$previous"
  echo "latest=$latest"
} >>"$GITHUB_OUTPUT"
