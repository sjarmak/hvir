# Running hvir with the Gas City and Pull requests extensions

This branch is upstream `main` plus the two extension packages and these scripts. One
checkout hosts both the app and the extensions, and the whole profile setup (installed
packages, agent access, tool approvals) comes from `install.json`, so Settings never has to
be clicked through.

## First time on a machine

1. Install the tools the extensions run: `git`, `gh`, `gc` and `bd` on the login shell PATH.
   Node 22 and the Xcode command line tools for the native build. Run `gh auth login`, choose
   HTTPS as the git protocol and let it authenticate git, so pushes work without an SSH key.
2. Clone and build (the fork is public, so the clone itself needs no credentials):

   ```sh
   git clone -b feat/extensions-on-main https://github.com/sjarmak/hvir.git ~/hvir-worktrees/extensions
   ~/hvir-worktrees/extensions/extensions/dev/bootstrap.sh
   ```

   `bootstrap.sh` runs `npm ci`, retries the native modules against the macOS 26 SDK when
   the default SDK's linker stubs are rejected, and runs `npm run build`.

3. Start the app:

   ```sh
   ~/hvir-worktrees/extensions/extensions/dev/host.sh
   ```

   It provisions the profile at `~/Library/Application Support/hvir` from `install.json`
   and starts Electron from this checkout's build. Projects are added in the app as usual;
   copying `projects.json` from another machine's profile works too.

## Every later start

Run `host.sh`. It re-reads `install.json`, re-validates the packages, keeps existing
installation ids, re-stamps the approvals against the current connector declarations, and
refuses to run while hvir is already up on that profile (the state is only read at launch).

After `git pull`: run `npm run build` if anything outside `extensions/` changed, then restart
through `host.sh`. A change inside a package only needs Reload in Settings → Extensions,
unless it touched a connector declaration, in which case restart through `host.sh`.

## Overrides

- `HVIR_DEV_PROFILE` picks another profile directory.
- `HVIR_DEV_HOST` runs a different built checkout (for example a plain `upstream/main`
  worktree) against the same packages.
- `node extensions/dev/approve-connectors.mjs --check` prints approval drift without writing.
