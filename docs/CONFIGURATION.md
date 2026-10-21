# Configuration and Bot Profiles

The panel persists state locally in `config.json`. `profiles.cjs` owns migration, selection, validation, and writes. The browser **auto-saves settings on `change` events**, not each keystroke; leaving a field usually triggers the save.

The save indicator at the top of the sidebar shows saving, saved, and failed states. Expand **Build commands & local files** to edit build/sync commands, the managed entry file, `localEnv`, and `localBot`. If initial settings loading fails, **Retry loading settings** attempts to load them again after the local panel is available.

> `config.json` is a credential-bearing **runtime file**. The example below is illustrative; do not replace your working config unless you mean to reconfigure the panel.

For a new installation, copy the root `config.example.json` to `config.json`, then enter connection and bot settings in the sidebar. The example contains no host, token, SSH-key path, or local upload paths. The included `.env.example` illustrates common bot variables only; the panel does not read it. Both actual configuration and bot environment files are ignored by Git.

## Version 2 configuration layout

```json
{
  "version": 2,
  "server": {
    "host": "vm.example.com",
    "port": "22",
    "user": "opc",
    "key": "C:\\Users\\Example\\.ssh\\oracle.key",
    "token": ""
  },
  "activeBotId": "legacy",
  "bots": [
    {
      "id": "legacy",
      "managed": false,
      "name": "Original bot",
      "repo": "https://github.com/example/original-bot.git",
      "branch": "main",
      "dir": "/home/opc/original-bot",
      "app": "original-bot",
      "buildCmd": "npm run build",
      "cmdSyncCmd": "node dist/deploy-commands.js",
      "localEnv": "",
      "localBot": "",
      "entryFile": ""
    }
  ]
}
```

The `activeBotId` points to an existing `bots[].id` and identifies which profile the sidebar edits and remote actions apply to. After removing the last bot, `bots` is `[]` and `activeBotId` is `""`; shared connection settings remain available. Add a bot before running bot actions.

## Shared connection fields (`server`)

| Field | Meaning | Notes |
| --- | --- | --- |
| `host` | VM hostname or public IP | Blank host prevents remote actions. |
| `port` | SSH port as string | Default `22`. |
| `user` | Linux SSH account | Default `opc`; also determines generated new-bot home folder. |
| `key` | **Windows-local** private key filepath | Passed to `ssh`/`scp` with `-i` when nonempty. Do not enter a `.pub` public key or remote path. |
| `token` | GitHub HTTPS repository access token | Optional for public repos; injected into HTTPS repo URL when configured. Shared by all bot profiles. |

**Only these five fields are shared.** Editing them impacts all bot profiles because all bots are reached through the same connection settings.

## Per-bot fields (`bots[]`)

| Field | Meaning | Behavior |
| --- | --- | --- |
| `id` | Stable profile identifier | Legacy profile uses `legacy`; new profiles get UUIDs. Not editable via normal config updates. |
| `managed` | Which PM2 launch strategy to use | Existing migrated profile is `false`; newly added or duplicated profiles are `true`. |
| `name` | Dashboard display name | Required, arbitrary nonempty display text. |
| `repo` | Git repository URL | Empty is supported for bots deployed without Git. |
| `branch` | Git branch to clone/pull | New bots default to `main`. |
| `dir` | Absolute Linux install path | Must not be `/`, relative, parent of another bot's directory, or child of another bot's directory. |
| `app` | PM2 application name | Must be unique and contain only letters, digits, `_` or `-`, start with an alphanumeric character, and not be only digits or `all`. |
| `buildCmd` | Shell command run during deploy | New bots default to `npm run build --if-present`; empty skips build. |
| `cmdSyncCmd` | Shell command for registering slash commands | Empty skips command sync; **Update slash commands globally** executes only this command for the selected bot. |
| `localEnv` | Path to local Windows `.env` | Used by the **Upload .env** action. The browser file picker is an alternative and does not require this field. |
| `localBot` | Path to local Windows source directory | Used by **Upload code & deploy**. |
| `entryFile` | Script to launch for a **managed** bot | Optional; takes precedence over repo ecosystem config and fallback `npm start`. |

Unknown `botId` values are rejected. Attempts to set arbitrary fields (such as `managed` and `id`) through `POST /api/config` are filtered by the whitelists in `profiles.cjs`.

## Creating a new profile

`profiles.add()`:

1. Takes a nonempty display name and converts it into a lowercase filesystem/PM2-safe slug (for example, `Music Bot` → `music-bot`).
2. Resolves name/folder collisions by appending `-2`, `-3`, etc.
3. Creates a new UUID for `id` and marks the bot `managed: true`.
4. Uses `/home/<ssh-user>/bots/<slug>` or `/root/bots/<slug>` for the install folder.
5. Makes the new bot the active selection; the API persists the resulting store.
6. In the **frontend**, if a host has been configured, a follow-up **prepare** action starts. Preparation errors do not remove the locally saved profile.

Editing one bot's repo, build command, local upload paths, PM2 name, and install directory leaves the other bots' values untouched.

## Duplicating a setup

Select a saved bot and choose **Duplicate setup**. The browser saves current edits before opening the dialog. Choose a name and optionally change the repository URL or entry file, then submit.

`profiles.duplicate(store, { id, name, repo?, entryFile? })` requires an explicit existing source ID and a nonempty string name. Optional overrides must be strings; empty strings clear those two fields. It reads the saved source and copies only `repo`, `branch`, `buildCmd`, `cmdSyncCmd`, and `entryFile` into a new profile. UUID, PM2 app name, install folder, and `managed: true` are generated through the normal new-profile path, including collision suffixes. `localEnv` and `localBot` are empty. Shared connection settings stay shared, and no SSH credentials become per-bot fields. The source profile is preserved.

The API saves the new profile and selects it. Duplication does not connect to the VM, prepare a folder, copy bot files, copy `.env` credentials, or start a bot. Use **Prepare bot files**, upload this bot's own credentials, and deploy separately. This differs from **Add bot → Create & prepare**, which attempts preparation when a host is configured.

## Removing a profile

**Remove bot** supports profile-only removal (no SSH), PM2 uninstall with files preserved, and confirmed full folder deletion. Each mode requires the displayed PM2 app name and an unchanged settings revision. On server-cleanup failure the profile remains available for retry. Removing the active bot selects the first remaining profile; removing any other profile preserves the current selection. The final removal leaves an empty fleet instead of recreating the legacy profile. See [Operations](OPERATIONS.md) for file-deletion restrictions and backup implications.

## Migrating an old configuration

`profiles.normalize()` supports legacy (flat) settings:

- If the file already has `version: 2` and a `bots` array (including an empty one), it is treated as v2.
- Otherwise the old keys are combined with defaults and moved into `server` and the first `bots` entry.
- The original bot becomes `id: "legacy"`, `managed: false`, `entryFile: ""`; its install folder and PM2 name are preserved.
- The first configuration **write** copies the prior `config.json` to `config.json.pre-profiles.bak` if the source exists and that backup path does not. This also occurs on the first write of an existing v2 config if no backup exists; it is not a recurring versioned backup system.
- Writes go through `config.json.tmp` before renaming to `config.json`; the temporary file is created with mode `0600` where the OS supports it.

**Do not delete the backup until you have securely verified migration.** The backup can contain the same GitHub token and paths as the live file.

## PM2 launch configuration: legacy vs. managed

### Legacy/unmanaged (`managed: false`)

The panel runs from the bot's checkout and expects **`DIR/ecosystem.config.cjs`** to exist. It uses:

```sh
pm2 startOrReload ecosystem.config.cjs --only "$APP" --update-env
```

Use the PM2 **app** name defined by the bot's repository config. If the repository has no matching ecosystem app, starting it can fail.

### Managed (`managed: true`)

`server.cjs` generates a profile-specific launch file at:

```text
$HOME/.bot-panel/<profile-id>/ecosystem.config.cjs
```

This file is regenerated on preparation and on PM2 start/reload. It is kept **outside the repository** so one bot's PM2 settings are not modified in Git by the panel.

The generated file chooses an application in this order:

1. If `entryFile` is set, launch that script.
2. Otherwise, if `DIR/ecosystem.config.cjs` exists, use its app whose `name` matches `app`; if none matches but there is exactly one app, use that sole app. An ambiguous multiple-app config throws an error.
3. Otherwise use `{ script: 'npm', args: 'start', interpreter: 'none' }` (effectively `npm start`).

In every managed case it forces the chosen app's PM2 `name` and `cwd` to the current profile's values. It preserves the other selected source app settings such as `env`, `max_memory_restart`, and node arguments when using a repo PM2 config.

**Note:** an explicit entry file takes precedence and does not inherit settings from a repository PM2 app; configure relevant environment settings in the bot as needed.

## Recommended rules when editing configuration

- Keep different bots in different, non-nested folders; do not repoint two profiles at the same checkout.
- Match `app` to the relevant PM2 process name for legacy bots.
- Choose an actual entry file for managed bots when the repository contains multiple PM2 apps and none matches the profile name.
- A private GitHub token is unnecessary for a public repo that allows anonymous HTTPS cloning.
- Use `npm run build --if-present` if build is optional, but set `cmdSyncCmd` only when the bot's repository supplies that command and the required environment variables.
- Keep the local `.env` associated with the correct bot profile. The panel does not manage the contents of secrets for you.
