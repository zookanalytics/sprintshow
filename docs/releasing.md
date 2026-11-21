---
name: Releasing sprintshow
description: How a sprintshow release is cut, what its merge publishes, and what to do when the publish run fails. Read it before cutting a release or re-running a failed publish.
---

# Releasing sprintshow

A release publishes main's version of `@zookanalytics/sprintshow` to npm, tags the commit it
was published from `v<version>`, and creates that tag's GitHub release. CI does all three when a
merge brings main a version npm lacks, so the only change a release makes in the repository is
its version.

## Cutting a release

A release is a bead, such as "Release sprintshow", worked like any other bead. Its PR reads the
titles of the PRs merged since the last release's tag. This repository merges by squash, so
each commit subject on main is a merged PR's title:

```bash
git fetch origin --tags
git log --format=%s "$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main)..origin/main"
```

It sets the next version from those titles. Before 1.0:

- A breaking change (a `!` before the title's colon) or a `feat` bumps the minor version.
- When the only releasable titles are `fix`, `perf` or `security`, it bumps the patch version.
- With none of those, there is nothing to release.

The PR changes the version with `npm version <x.y.z> --no-git-tag-version`, so `package.json`
and `package-lock.json` agree, and takes the title `chore: release <x.y.z>`. Its summary lists
the user-facing changes since the last release.

The operator's approval of that PR is the release.

1.0 waits for the operator to declare the CLI and the demo-script format stable.

## What the merge does

On every push to main, [publish.yml](../.github/workflows/publish.yml) asks npm whether it has
`package.json`'s version. When npm lacks it, the workflow runs the installed-package check that
CI runs on every PR, then publishes the version through npm's trusted publishing, which attests
its provenance. It then tags that commit `v<version>` and creates its GitHub release, with notes
generated from the PRs merged since the previous release. A check that fails publishes nothing,
and a merge whose version npm already has publishes and tags nothing.

npm takes a publish only from the workflow the package's trusted publisher names. The
connection is made in the package's settings on npmjs.com, or with npm 11.15 or later:

```bash
npm trust github @zookanalytics/sprintshow --file publish.yml --repo zookanalytics/sprintshow --allow-publish
```

`--allow-publish` lets the workflow publish directly, where a connection without it can only
stage a publish. A new connection expires unless a publish uses it within 2 days.

## When a publish run fails

Re-run a failed run once its cause is fixed. The re-run finishes only what is missing: it skips
the publish when npm has the version, and the release when it exists.

```bash
gh run list --workflow publish.yml --limit 5
gh run rerun <run-id>
```

A re-run runs the workflow and the package as they were at its commit, so a cause in either is
fixed by a merge, and that merge's run takes over. When npm still lacks the version, the merge
publishes it, and its commit gets the tag. When npm has it, no run creates the release: a run
tags only the commit npm records the version was published from, and its token cannot tag a
commit whose workflow files differ from main's. Tag that commit with git, then create the
release on the tag, with notes from the last release tag in that commit's history. GitHub marks
a new release Latest unless told not to, so pass `--latest=false` when the `git tag` line below
lists a tag, a newer release on a later commit, and `--latest=true` when it lists none:

```bash
git fetch origin --tags
published=$(npm view @zookanalytics/sprintshow@<x.y.z> gitHead)
git push origin "$published:refs/tags/v<x.y.z>"
git tag --list 'v[0-9]*' --contains "$published" --no-merged "$published"
gh release create v<x.y.z> --verify-tag --generate-notes --latest=<true or false> \
  --notes-start-tag "$(git describe --tags --abbrev=0 --match 'v[0-9]*' "$published^")"
```

GitHub's release API makes a tag on such a commit only for a token allowed to change
workflows, so the tag goes up with git first.
