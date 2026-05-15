---
name: release
description: Create a new release by bumping package.json, tagging, and pushing. Triggers the Bun build + Homebrew tap update via GitHub Actions.
argument-hint: "[version]"
---

Release workflow: bump `package.json`, tag a semver version, push it. GitHub Actions runs on `macos-14`, compiles the Bun binary, creates a GitHub release with the arm64 tarball, and writes the updated formula to `byteink/homebrew-tap`.

## Steps

1. Run `git tag --sort=-v:refname | head -1` to find the latest version
2. If `$ARGUMENTS` is provided, use it as the version (strip leading `v`)
3. If no argument, suggest the next patch/minor/major based on the latest tag
4. Confirm the version with the user before proceeding
5. Ensure working tree is clean (`git status --porcelain`) — abort if dirty
6. Ensure current branch is `main` — warn if not
7. Bump `version` in `package.json` to the new value, commit:
   ```bash
   git commit -am "chore: release v<version>"
   ```
8. Tag and push:
   ```bash
   git tag v<version>
   git push origin main v<version>
   ```
9. Show the GitHub Actions run URL: `gh run list --workflow=release.yml --limit=1`
