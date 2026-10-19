# OpsDeck Hub runbook

The Hub is one Node process (Fastify and SQLite) that holds the team's shared deploy secrets, environment
locks, release history and live status, and runs Ansible for releases. People sign in with Microsoft Entra
ID. Personal SSH keys, tunnels and the vault never reach the Hub.

This is a runbook: follow it top to bottom on a fresh VM.

## 1. Entra app registration

In the Entra admin center, for the tenant your team signs in with:

1. **App registrations > New registration.** Name it "OpsDeck Hub". Supported account types: single tenant.
2. Under **Authentication > Add a platform > Mobile and desktop applications**, add the redirect URI
   `http://127.0.0.1/callback` (OpsDeck signs in through a loopback port, so any port is accepted). Leave
   "Allow public client flows" on. No client secret is created or needed.
3. Under **Expose an API**, set the Application ID URI to `api://<client id>` and add a scope named
   `access_as_user` (admins and users can consent).
4. Under **Manifest**, set `requestedAccessTokenVersion` to `2`.
5. Note the **Directory (tenant) ID** and **Application (client) ID**. They go in the config.

These steps have not yet been verified against a live tenant.

No API permissions beyond `openid`, `profile`, `offline_access` and your own `access_as_user` are needed.

## 2. VM prerequisites

- Linux with systemd, Node.js 24 or newer, and a public DNS name for the Hub.
- `sqlite3` (for backups), `ansible-playbook` (ansible-core), plus `ssh-agent` and `ssh-add` from OpenSSH.
- Outbound HTTPS to `login.microsoftonline.com`.
- Create the service user and directories:

```sh
sudo useradd --system --home /var/lib/opsdeck-hub --shell /usr/sbin/nologin opsdeck-hub
sudo install -d -o opsdeck-hub -g opsdeck-hub -m 700 /var/lib/opsdeck-hub
sudo install -d -m 755 /etc/opsdeck-hub /opt/opsdeck-hub
sudo install -d -o opsdeck-hub -g opsdeck-hub -m 700 /var/backups/opsdeck-hub
```

## 3. Build and install

On a build machine with the repository checked out:

```sh
pnpm --dir hub build        # writes hub/dist/opsdeck-hub.mjs
```

Copy `hub/dist/opsdeck-hub.mjs` to `/opt/opsdeck-hub/dist/`, copy `hub/package.json` to `/opt/opsdeck-hub/`,
and install its two dependencies there (`fastify`, `jose`) with your package manager. Copy
`hub/deploy/opsdeck-hub.service` to `/etc/systemd/system/`.

## 4. The master key

The master key seals every secret in `hub.db`. Create it once:

```sh
sudo node /opt/opsdeck-hub/dist/opsdeck-hub.mjs gen-master-key --out /etc/opsdeck-hub/master.key
```

It writes 32 random bytes as base64 with mode 0600 and refuses to overwrite an existing file. It never
prints the key.

**Back the key up separately from `hub.db`** (a password manager or an offline vault, never next to the
database backups). Lose it and every Hub secret is gone; there is no recovery. A leaked key together with
a leaked `hub.db` exposes every secret, which is why the two are kept apart.

## 5. Configure

Write `/etc/opsdeck-hub/hub.config.json` (see `hub/hub.config.example.json`):

```json
{
  "name": "Acme Hub",
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "publicUrl": "https://hub.example.com",
  "dataDir": "/var/lib/opsdeck-hub",
  "entra": {
    "tenantId": "<directory id>",
    "clientId": "<application id>",
    "redirectUri": "http://127.0.0.1/callback"
  },
  "firstAdmin": { "upn": "you@example.com" },
  "masterKeyFile": "${CREDENTIALS_DIRECTORY}/master-key"
}
```

The Hub listens on loopback and Caddy terminates TLS. `${CREDENTIALS_DIRECTORY}` is filled in from
systemd's `LoadCredential=` (the unit hands over `/etc/opsdeck-hub/master.key`). systemd leaves that copy
owned by root with the Hub user's access granted by ACL, so for a file inside `$CREDENTIALS_DIRECTORY` the Hub
accepts owner root or the Hub user, no write bits and no "other" bits, instead of the strict 0600 check. This
path is **unverified on a live systemd**: run `systemctl start opsdeck-hub` on Linux and confirm it boots
before relying on it.

Check it. Run this as root with a copy of the config whose `masterKeyFile` is the literal
`/etc/opsdeck-hub/master.key`, because `${CREDENTIALS_DIRECTORY}` only exists under systemd:

```sh
sudo node /opt/opsdeck-hub/dist/opsdeck-hub.mjs check-config --config /tmp/hub.check.json
```

It prints a checklist: config, master key, `dataDir` permissions, `ansible-playbook`, `ssh-agent`,
`ssh-add`, and whether the Entra discovery URL answers. It never prints a key. Fix every `FAIL` line, then
delete the copy.

## 6. TLS reverse proxy (Caddy)

```caddyfile
hub.example.com {
    reverse_proxy 127.0.0.1:8787 {
        # The live status stream (GET /api/v1/live) is server-sent events: never buffer it.
        flush_interval -1
    }
}
```

Caddy gets and renews the certificate on its own. The Hub sends heartbeats
every 15 seconds, so idle proxies keep the stream open.

## 7. Start and the first admin

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now opsdeck-hub
sudo systemctl status opsdeck-hub
```

The first person to sign in whose UPN (or object id) matches `firstAdmin` becomes an admin. In OpsDeck,
add the Hub under Settings, sign in, and the Hub Admin page opens. Create groups, add people, and grant
groups access to environments. Remove or change `firstAdmin` afterwards only if you need to recover
admin access; a person in it always signs in as admin.

## 8. Publish an environment and install deploy keys

1. In OpsDeck, open the environment and choose **Publish to Hub**. This sends the environment, its hosts
   and deployments (no secrets) and lists the secrets it needs.
2. Under the Hub's environment page, set each required secret once. Everyone with access to the
   environment then deploys with the same values.
3. Generate the environment's **deploy key** on the Hub page. The Hub shows only the public key and its
   fingerprint. Add that public key to `authorized_keys` of the deploy user on each host. The Hub never
   uses anyone's personal SSH key, and this step stays manual on purpose.

## 9. Backup and restore

Back up the database with SQLite's online backup, never by copying the file while the Hub runs:

```sh
sudo -u opsdeck-hub sqlite3 /var/lib/opsdeck-hub/hub.db ".backup '/var/backups/opsdeck-hub/hub-$(date +%F).db'"
```

Restore: stop the service, put the backup at `/var/lib/opsdeck-hub/hub.db` (owner `opsdeck-hub`, mode
0600), delete any `hub.db-wal` and `hub.db-shm`, and start the service. The Hub refuses to start if the
master key is not the one that sealed the database, so restore the key from its own backup first when
rebuilding a VM.

## 10. Upgrades

1. Build the new version and take a database backup (section 9).
2. Replace `/opt/opsdeck-hub/dist/opsdeck-hub.mjs` (and reinstall dependencies if `package.json` changed).
3. Run `check-config`, then `sudo systemctl restart opsdeck-hub`.

Database migrations run at start and only ever add; running releases end at a restart, and their locks
are released. Manual freezes survive restarts. To roll back, restore the pre-upgrade backup together with
the previous bundle.
