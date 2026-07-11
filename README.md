# Pulse Shelf 2.0

Pulse Shelf 2.0 is a local-first Windows desktop music player built with Electron, React, Vite, TypeScript, and Zustand. It scans music chosen by the user, keeps playback and library data on the device, and does not upload audio or metadata.

## Features

- Recursive multi-folder library scanning with progress, cancellation, incremental metadata reuse, duplicate detection, and damaged-file isolation
- Track, album, and artist views with search, sorting, detail views, bulk selection, and paged list rendering
- Sandboxed YouTube browsing through an isolated Electron `WebContentsView`
- MP3, FLAC, WAV, M4A, and OGG metadata and cover extraction
- Persistent queue, deterministic shuffle history, repeat modes, seeking, mute, volume, and playback-position restoration
- Recent plays, likes, playlists, queue editing, play-next, and file-location actions
- Local synchronized `.lrc` lyrics and plain `.txt` lyrics beside the audio file
- Persistent focus/break timer and reorderable to-do list
- Synchronized mini player with remembered on-screen bounds
- Optional Discord Rich Presence, system tray controls, auto-launch, and configurable close behavior
- Validated JSON backup import/export and first-run onboarding
- NSIS installer, portable executable, and unpacked Windows build

## Screenshots

Project screenshots belong in [`docs/screenshots/`](docs/screenshots/). No generated or mock screenshots are shipped in the application bundle.

## Requirements

- Windows 10 or later
- Node.js 24 or later
- npm 11 or later

## Install And Run

```bash
npm install
npm run electron:dev
```

`npm run dev` and `npm run electron:dev` both start Vite and Electron. The minimum application window is 1280×720; the default is 1600×900.

## Commands

```bash
npm run generate:icons  # generate PNG and ICO assets from assets/icon.svg
npm run typecheck       # TypeScript project checks
npm run lint            # ESLint
npm run format:check    # Prettier verification
npm run build           # renderer, main process, and preload production build
npm run test:media      # Electron WAV scan, metadata, lyrics, and rescan persistence smoke test
npm run test:ui         # 1280×720/1600×900 shell, tray, and mini-window smoke test
npm run dist            # NSIS and portable Windows packages
```

Windows artifacts are written to `release-2.0/`, including the NSIS installer, portable executable, and `win-unpacked/` directory.

## Discord Rich Presence

The Discord application Client ID is never committed or hardcoded. Set it in the process environment before launching Pulse Shelf:

```powershell
$env:DISCORD_CLIENT_ID="your-discord-application-client-id"
npm run electron:dev
```

For an installed build, define `DISCORD_CLIENT_ID` as a Windows user environment variable and start a new login session before launching the app. Enable Discord Rich Presence in onboarding or Settings. Missing Discord, a missing Client ID, or connection failures do not block playback; failed connections retry after 30 seconds.

See [`.env.example`](.env.example) for the variable name. The app does not automatically load `.env` files in packaged builds.

## Music And Lyrics Support

| Container  | Metadata scan | Typical Chromium playback |
| ---------- | ------------- | ------------------------- |
| MP3        | Yes           | Yes                       |
| FLAC       | Yes           | Yes                       |
| WAV        | Yes           | Yes                       |
| OGG/Vorbis | Yes           | Yes                       |
| M4A        | Yes           | Codec-dependent           |

Metadata support and audio decoding are separate. M4A is scanned, but playback depends on the codec inside the container and the Electron/Chromium build.

For local lyrics, place a sidecar beside the song with the same base name:

```text
song.flac
song.lrc
```

`.lrc` timestamps such as `[01:23.45]` are synchronized and highlighted. `.txt` is displayed as unsynchronized plain text. Lyrics paths and contents are read by the main process through validated track IDs; paths are never sent to the renderer.

## Data And Logs

Application data uses `electron-store` in Electron's per-user `userData` directory. It contains folders, metadata, playlists, likes, recent plays, settings, queue state, focus data, and to-dos. Music files remain in their original locations. Embedded covers are cached below the same user-data directory.

The renderer receives opaque track IDs, file names, and custom `pulse-media://` / `pulse-cover://` URLs, not audio file paths. Invalid semantic store data is backed up with an `.invalid-<timestamp>.bak` suffix before defaults are restored. Main-process and renderer errors are written by `electron-log` to the platform log directory under Electron user data.

JSON backup export intentionally excludes audio files and direct track paths. Import is validated with Zod before any existing data is changed.

## Keyboard Shortcuts

| Shortcut     | Action              |
| ------------ | ------------------- |
| `Space`      | Play/pause          |
| `Ctrl+Right` | Next track          |
| `Ctrl+Left`  | Previous track      |
| `Ctrl+Up`    | Volume up           |
| `Ctrl+Down`  | Volume down         |
| `Ctrl+F`     | Open library search |
| `Ctrl+L`     | Open library        |
| `Ctrl+M`     | Open mini player    |

Playback shortcuts are ignored while an input, text area, select, or editable element has focus.

## Security

- `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`
- Typed preload bridge with constant IPC channel names
- Zod validation for persisted data, imported backups, player snapshots, commands, and track IDs
- Main-window-only authorization for folder, data, reset, scan, and reveal operations
- Permission requests denied by default and external navigation blocked
- Media and covers resolved only from registered library IDs; URL paths cannot select arbitrary files
- Explicit media MIME types and range-preserving streamed responses
- Strict packaged Content Security Policy

## Known Limitations

- M4A playback varies with the embedded codec.
- Lyrics are local sidecars only; no online lyrics service is used.
- Imported backups cannot grant filesystem access or restore music from another computer until folders are selected and scanned there.
- Discord Rich Presence requires a separately created Discord application and environment variable.

## License

[MIT](LICENSE)
