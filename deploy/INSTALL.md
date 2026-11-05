# Installing pomtreed as a service

**Not yet exercised on a real host**: the launchd plist's restart behaviour, recovery across a reboot, the online backup, the upgrade and rollback steps and the log rotation snippets. Try them on a disposable host first. `scripts/pomtree-up` is a dev launcher, not a service.

## Before you start

This page installs pomtreed as a long-running service and assumes a first run already works; the first-run path is [Try it locally](../docs/operating.md#try-it-locally). Install the prerequisites (Node.js, git, pnpm through corepack, Docker with buildx) as described in [GETTING_STARTED.md](../GETTING_STARTED.md); `pomtreed preflight` checks them. Install Docker before the `usermod` step below, since installing Docker Engine creates the `docker` group. For the systemd unit, Node.js must be system-wide at `/usr/bin/node`, which a NodeSource package gives; nvm or a user-local install does not work for the unit (see [systemd notes](#systemd-notes)). For a local trial rather than a service, follow GETTING_STARTED.md and Try it locally instead.

`pomtree` and `pomtreed` are `bin` entries in `packages/pomtree/package.json` and `packages/pomtreed/package.json`, but nothing installs them on `PATH`, and this guide does not either: pomtreed always runs by path (`node <checkout>/packages/pomtreed/src/main.ts`, as the units below do), and `pomtree` runs the same way through a shell function (step 6 of the Linux install).

Treat the state directory and its backups as sensitive: journals and traces can contain secrets ([details](../docs/faq.md#do-traces-and-journals-contain-secrets)).

## Required configuration

pomtreed refuses to start without:

- `POMTREED_MODEL_BASE_URL` and `POMTREED_MODEL_UPSTREAM_KEY_FILE` (the model proxy upstream, and the path of a file holding its only credential; write the key to that file with mode 0600, owned by the service user; see [Configuration](../docs/configuration.md)).
- `POMTREED_PI_PROVIDER` (the Pi provider the model proxy serves, e.g. `openrouter`). pomtreed never reads a Pi login file.
- `POMTREED_AGENT_EGRESS_PROXY_IMAGE`, `POMTREED_AGENT_UNTEMPLATED_EGRESS` and `POMTREED_EXTENSIONS_APPROVAL`: forced safety decisions, with starter values in `deploy/pomtreed.env.example`. What each decides, and why pomtreed refuses to start without it, is in [`docs/safety-decisions.md`](../docs/safety-decisions.md#class-2-decisions-the-framework-forces); the settings themselves are in [Configuration](../docs/configuration.md). pomtreed prints every missing one at once and exits 1. Use `registry` for `POMTREED_AGENT_UNTEMPLATED_EGRESS` on a first run. The egress proxy image can be the agent image's id, `sha256:<id>` from `docker image inspect --format '{{.Id}}' pomtree/agent:dev`.
- `POMTREED_STATE_DIR`, `POMTREED_REPO_DIR` (set in the units).
- Strongly recommended: `POMTREED_AGENT_IMAGE` pinned to an immutable reference. The default `pomtree/agent:dev` is a mutable tag, and only `scripts/pomtree-up` checks its revision label against the checkout (known gap: the service does not check it). For an image built on this host, use its image id, `sha256:<id>` from `docker image inspect --format '{{.Id}}' pomtree/agent:dev`. A `pomtree/agent@sha256:<id>` reference built from that id does not resolve: the id is the image config digest, not a repository digest, and a repository digest exists only after a push or pull (then use `<registry>/<repo>@sha256:<digest>`).

The naming rule, precedence and registry are in `docs/configuration.md`; `pomtreed config show --origin` prints what the daemon resolved. `deploy/pomtreed.env.example` has placeholders only.

## Linux (systemd)

Needs the prerequisites in [Before you start](#before-you-start), with Node.js at `/usr/bin/node`. The unit runs the checkout at `/srv/pomtree`. The repository agents work on (`POMTREED_REPO_DIR`) must be a separate repository with a first commit, not the pomtree checkout (preflight refuses that); this guide uses `/srv/pomtreed-repo`.

Work through the steps in order: nothing is started until the configuration is written (step 3), and the service starts in step 5. Run the steps in one shell, because the variables set in step 1 are used throughout. Agent containers run as uid 1000 and the service user must have the same uid today: otherwise a spawned agent ends `failed` with `EACCES: permission denied, mkdir '/workspace/.pi-session'` (known gap: the service user's uid is not configurable).

**1. Choose the service user.** Check who holds uid 1000:

```sh
getent passwd 1000
```

If it prints nothing, create the dedicated user with that uid:

```sh
SVC_USER=pomtreed; SVC_GROUP=pomtreed
sudo useradd --system -u 1000 --create-home --home-dir /var/lib/pomtreed-home --shell /usr/sbin/nologin $SVC_USER
```

If it prints an account (stock Ubuntu images: the first user, for example `ubuntu`), run the service as that account instead, and do not run the `useradd` above:

```sh
SVC_USER=<that account name>; SVC_GROUP=$(id -gn $SVC_USER)
```

**2. Install the checkout, the image and the unit files.** The Docker socket access given to the service user is root-equivalent on the host.

```sh
cd /srv                                     # the service user cannot read your home directory, which may be the current directory
sudo corepack enable                        # puts the pnpm shim next to /usr/bin/node; pnpm resolves to the packageManager version
sudo usermod -aG docker $SVC_USER           # needs Docker Engine installed first (it creates the group)
sudo install -d -o $SVC_USER -g $SVC_GROUP /srv/pomtree /srv/pomtreed-repo
sudo -u $SVC_USER -H git clone https://github.com/pomtrees/pomtree.git /srv/pomtree
sudo -u $SVC_USER -H git -C /srv/pomtreed-repo init -q
sudo -u $SVC_USER -H git -C /srv/pomtreed-repo -c user.name=pomtreed -c user.email=pomtreed@localhost commit -q --allow-empty -m init
cd /srv/pomtree
sudo -u $SVC_USER -H pnpm install --frozen-lockfile   # the first pnpm use downloads pnpm itself, so it needs network
sudo -u $SVC_USER -H pnpm --filter @pomtree/agent-image build:image        # builds pomtree/agent:dev from this checkout
sudo -u $SVC_USER -H docker image inspect --format '{{.Id}}' pomtree/agent:dev  # the sha256:<id> for POMTREED_AGENT_IMAGE and POMTREED_AGENT_EGRESS_PROXY_IMAGE in step 3
sudo mkdir -p /etc/pomtreed
sudo cp deploy/pomtreed.env.example /etc/pomtreed/env
sudo install -m 0600 -o $SVC_USER -g $SVC_GROUP /dev/null /etc/pomtreed/model.key
sudo chown root:$SVC_GROUP /etc/pomtreed /etc/pomtreed/env
sudo chmod 0750 /etc/pomtreed; sudo chmod 0640 /etc/pomtreed/env   # or 0600 with the service user as owner
```

**3. Write the configuration.** Edit `/etc/pomtreed/env` (`sudoedit /etc/pomtreed/env`) with real values, as in [Required configuration](#required-configuration), and put the model key in `/etc/pomtreed/model.key` with your editor (`sudoedit /etc/pomtreed/model.key`; never on a command line). For a zero-spend trial on a scripted fake model instead of a real provider, run the stub recipe in [Try it locally](../docs/operating.md#try-it-locally) first and point `POMTREED_MODEL_BASE_URL` at the stub (`http://127.0.0.1:9911/v1`), `POMTREED_PI_PROVIDER` at `deepseek` and `POMTREED_PI_CATALOG_DIR` at a catalog the service user can read.

**4. Install the unit.**

```sh
sudo cp /srv/pomtree/deploy/pomtreed.service /etc/systemd/system/
sudo sed -i -e "s|^User=.*|User=$SVC_USER|" -e "s|^Group=.*|Group=$SVC_GROUP|" -e 's|^Environment=POMTREED_REPO_DIR=.*|Environment=POMTREED_REPO_DIR=/srv/pomtreed-repo|' /etc/systemd/system/pomtreed.service
sudo sed -i 's|^ReadWritePaths=.*|ReadWritePaths=/var/lib/pomtreed /srv/pomtreed-repo|' /etc/systemd/system/pomtreed.service
grep -nE '^(User|Group|Environment=POMTREED_REPO_DIR|ReadWritePaths)=' /etc/systemd/system/pomtreed.service   # expect four lines with your values
systemd-analyze verify /etc/systemd/system/pomtreed.service
```

The `sed` lines assume the unit has `User=`, `Group=`, `Environment=POMTREED_REPO_DIR=` and `ReadWritePaths=` lines, which the grep shows.

**5. Start the service.**

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now pomtreed
```

The env file holds no secret values, only the path of the model key file (`POMTREED_MODEL_UPSTREAM_KEY_FILE`); keep that key file unreadable by other users (0600, owned by the service user). The repository `POMTREED_REPO_DIR` must be writable by the service user. State lives in `/var/lib/pomtreed` (created 0700 by `StateDirectory=`). Logs: `sudo journalctl -u pomtreed`.

**6. Define the `pomtree` function.** The operator token belongs to the service user and `pomtree` refuses a token file you do not own, so `pomtree` runs as that user, from the checkout (the service user cannot read your current directory, and relative paths in `pomtree` arguments resolve in `/srv/pomtree`). This is a shell function for your interactive shell: it is not expanded inside `bash -c` or scripts, where you call the `sudo -u ... node` command directly.

```sh
pomtree() { sudo -u "$SVC_USER" -H sh -c 'cd /srv/pomtree && POMTREED_STATE_DIR=/var/lib/pomtreed exec node packages/pomtree/src/main.ts "$@"' sh "$@"; }
```

**7. Verify the service.**

```sh
systemctl status pomtreed --no-pager
sudo journalctl -u pomtreed --no-pager | grep 'agent endpoint container probe'   # expect: container probe ok
pomtree doctor                                                                  # expect: ok
```

If the probe line says `FAILED`, apply the firewall step below, then spawn a first agent as in [Try it locally](../docs/operating.md#try-it-locally) (`pomtree` is the function from step 6).

## Linux firewall

Agent containers reach the daemon's agent endpoint and the model proxy at the Docker bridge gateway. A host firewall that drops that traffic breaks agents. Check first:

```sh
sudo ufw status
```

Ubuntu images ship ufw installed but inactive; if it says `Status: inactive`, no rules are needed, and a host that uses only the Docker bridge without ufw needs nothing. If it is active, allow the container bridges:

```sh
sudo ufw allow in on docker0
sudo ufw allow in on br-+
```

The startup probe runs only when the daemon starts, so restart it after adding the rules (`sudo systemctl restart pomtreed`; with `scripts/pomtree-up`, stop it and start it again). The pass signal is the log line `pomtreed: agent endpoint container probe ok`:

```sh
sudo journalctl -u pomtreed --no-pager | grep 'agent endpoint container probe' | tail -1
```

Do not use `pomtree doctor` as the signal: it can print `reachable from containers` while the probe has failed. A failure logs `pomtreed: agent endpoint container probe FAILED` plus a WARNING naming these two rules. Agents then do not fail cleanly: they show repeated `PROVIDER ERROR` `Connection error.` and keep yielding, because the model proxy at the bridge gateway is blocked as well. A first agent that ends `succeeded` (see [Try it locally](../docs/operating.md#try-it-locally)) is the end-to-end proof. The cause and the same steps as an onboarding step are in [`GETTING_STARTED.md`](../GETTING_STARTED.md#10-open-the-firewall-to-containers-linux-with-ufw).

## macOS (launchd)

From a clone with dependencies installed and the image built (`pnpm install --frozen-lockfile`, then `pnpm --filter @pomtree/agent-image build:image`; see [`GETTING_STARTED.md`](../GETTING_STARTED.md#8-build-the-agent-image), "Build the agent image"), and the image id in `POMTREED_AGENT_IMAGE`:

```sh
mkdir -p ~/Library/Logs/pomtreed ~/.config/pomtreed ~/Library/LaunchAgents
cat > ~/.config/pomtreed/run.sh <<'SH'
#!/bin/sh
set -a; . "$HOME/.config/pomtreed/env"; set +a
exec node /Users/example/pomtree/packages/pomtreed/src/main.ts
SH
chmod 700 ~/.config/pomtreed/run.sh
cp deploy/pomtreed.env.example ~/.config/pomtreed/env && chmod 600 ~/.config/pomtreed/env   # edit; use KEY=value lines
(umask 077; touch ~/.config/pomtreed/model.key)   # put the model key in it with your editor; point POMTREED_MODEL_UPSTREAM_KEY_FILE at it
cp deploy/io.github.pomtrees.pomtreed.plist ~/Library/LaunchAgents/   # edit paths and PATH
plutil -lint ~/Library/LaunchAgents/io.github.pomtrees.pomtreed.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.pomtrees.pomtreed.plist
alias pomtree='node /Users/example/pomtree/packages/pomtree/src/main.ts'   # the plist's POMTREED_STATE_DIR, ~/.pomtreed, is pomtree's default
pomtree doctor
```

Logs are `~/Library/Logs/pomtreed/pomtreed.{out,err}.log`; launchd never rotates them. Add a newsyslog entry (e.g. `/etc/newsyslog.d/pomtreed.conf`: `/Users/example/Library/Logs/pomtreed/*.log  644  5  1000  *  J`), or truncate manually. Stop: `launchctl bootout gui/$(id -u)/io.github.pomtrees.pomtreed`.

A configuration refusal exits 2 (an unknown env name, a value out of range, a broken relation, a missing required value). systemd stops on it (`RestartPreventExitStatus=2` in the unit), but launchd has no per-exit-status stop: `KeepAlive` with `SuccessfulExit` false relaunches pomtreed every `ThrottleInterval` (10 s) and it fails the same way each time. Read the reason in `pomtreed.err.log`, stop the loop with `launchctl bootout gui/$(id -u)/io.github.pomtrees.pomtreed`, fix the env file, check it with `pomtreed config show` (Upgrade step 3), and `launchctl bootstrap` again. A GUI-session agent only runs while the user is logged in and needs Docker Desktop running.

## Backup

The store is SQLite in WAL mode: `pomtreed.sqlite` (plus `-wal`/`-shm`) under the state dir. Copying the file alone while pomtreed runs is unsafe. Either:

1. Stop pomtreed (`systemctl stop pomtreed`), copy the whole state dir (db, `-wal`, `-shm`, `secret`, tokens), start it; or
2. Online: `sqlite3 /var/lib/pomtreed/pomtreed.sqlite ".backup '/backups/pomtreed-$(date +%F).sqlite'"` (consistent snapshot), and copy `secret` separately (without it, tokens and model-credential signatures are invalid).

Restore: stop pomtreed, put the files back with the same owner and mode (0700 dir, 0600 files), start it. The store may also write pre-migration `.bak` copies next to the DB when a schema change runs (check the state dir after an upgrade). They are not a substitute for scheduled backups. A database from a pre-release build (tables but no pomtree schema id) is refused at startup: move it aside and restart to re-initialize. Untested: the online `.backup` command on a live pomtreed. `GET /healthz` and `GET /readyz` exist on the unix socket (not on the TCP listeners) for liveness/readiness checks.

## Upgrade and rollback

1. Back up (above). Note the current commit (`git rev-parse HEAD`) and the current `POMTREED_AGENT_IMAGE`.
2. `git pull`, `pnpm install --frozen-lockfile`, rebuild the image (`pnpm --filter @pomtree/agent-image build:image`), record the new image id (`docker image inspect --format '{{.Id}}' pomtree/agent:dev`, giving `sha256:<id>`) and set `POMTREED_AGENT_IMAGE` to it in the env file. The daemon and the `pomtree` baked into the image must be the same revision.
3. Check the configuration before restarting: run `node packages/pomtreed/src/main.ts config show` with the env file loaded (`set -a; . /etc/pomtreed/env; set +a` in a shell as the service user, or `~/.config/pomtreed/env` on macOS). It resolves exactly like startup; exit 2 lists every problem, including each unknown env name (`unknown env X; remove it, or use a name listed in docs/configuration.md`, with a "did you mean" hint where one fits). Fix the env file until it exits 0.
4. Restart: `systemctl restart pomtreed` / `launchctl kickstart -k gui/$(id -u)/io.github.pomtrees.pomtreed`. Check `pomtree doctor`.
5. Rollback: stop, check out the previous commit, restore the previous `POMTREED_AGENT_IMAGE`, and restore the backup taken in step 1. The store refuses to open a database whose schema is newer than the binary, so an older binary does not start on a database a newer one migrated: always restore the backup.

## Stale lock recovery

`pomtreed.lock` in the state dir holds the daemon pid plus `boot=` and `start=` identity lines. On startup pomtreed treats the lock as stale, and takes it over, when the pid is dead, the boot id differs (reboot), or the process start time differs (pid reuse). Manual removal is rarely needed; if pomtreed still refuses to start, confirm no pomtreed is running (`pgrep -f packages/pomtreed/src/main.ts`), then `rm <state>/pomtreed.lock`. Do not delete it while pomtreed runs.

## systemd notes

- `ExecStart=/usr/bin/node` runs `packages/pomtreed/src/main.ts` directly, so it needs Node >= 24 at that path (check `/usr/bin/node --version`; a NodeSource install gives that path; adjust ExecStart if node lives elsewhere, but a per-user manager such as nvm is not reachable by the unit's `ProtectHome`).
- Every path in `ReadWritePaths=` must exist: a missing one fails the unit with status 226/NAMESPACE. `StateDirectory=` creates `/var/lib/pomtreed`; only the repo path must exist (or edit the line) before `systemctl start`.
