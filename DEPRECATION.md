# pure_helper_obsidian deprecated

| | |
|---|---|
| Status | Deprecated — archive, do not delete |
| Branch | `main` |
| What it actually is | An **Obsidian plugin (JavaScript)** — plugin id `pure-tracker` |
| Distribution | GitHub Releases, installed via **BRAT** |
| Release trigger | `.github/workflows/release.yml` on a semver tag |

## Note: this is not a RuneLite plugin

Despite living in `plugin/` next to the RuneLite Java plugins, this is an Obsidian plugin.
`main.js` extends Obsidian's `Plugin` class; `manifest.json` declares `"id": "pure-tracker"`.
It shares no code, build system, or runtime with its neighbours. Workspace docs that group
it with the RuneLite plugins are misleading.

## ⚠️ It was published to users

Distribution is via BRAT, which installs and updates directly from the GitHub repo. Anyone
who installed it still points at that repo for updates.

- **Archiving** the GitHub repo is safe — installed copies keep working, updates simply stop.
- **Deleting** the GitHub repo breaks BRAT for every existing user.

Prefer archive over delete.

## Retirement checklist

- [ ] Confirm no one is still relying on it (it is a personal-tooling plugin, so this may be
      a one-person answer)
- [ ] Add a deprecation note to `README.md` so BRAT users see it
- [ ] Archive the GitHub repo (do not delete)
- [ ] Leave the local directory until the archive is confirmed

Recorded 2026-08-16.
