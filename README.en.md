# Soda Music Plugin for MyGo Music

[简体中文](README.md) | English

Use Soda Music (汽水音乐 / Qishui) in [MyGo Music](https://github.com/egoist/mygo-music) to search and play songs, explore recommendations, browse artists and albums, and manage your music library.

Sign in by scanning a QR code with the Soda Music app. Packages are available for macOS and Windows.

[Download](https://github.com/lane128/mygo-music-qishui/releases/latest) · [Release Notes](https://github.com/lane128/mygo-music-qishui/releases) · [Report an Issue](https://github.com/lane128/mygo-music-qishui/issues)

If you find this plugin useful, consider giving [the project](https://github.com/lane128/mygo-music-qishui) a ⭐ Star to support future updates and help others discover it.

## Features

| Feature | Supported functionality |
| --- | --- |
| Account | QR sign-in, session restoration, sign-out, account details, VIP / SVIP status, and your profile page |
| Search | Search songs, artists, albums, and playlists, with search suggestions |
| Playlists | Browse playlist details and songs, with the playlist creator shown |
| Music discovery | Home discovery, personalized recommendations, familiar / fresh recommendations, listening modes, and continuous radio playback |
| Playback and downloads | Standard / High / Lossless quality selection, seeking, song downloads through MyGo Music, and direct M4A / FLAC playback |
| Lyrics | Line-synced lyrics, official word-synced lyrics, and Chinese translations; falls back to line-synced lyrics when word timing is unavailable |
| Artists and albums | Complete artist song and album lists, follow / unfollow artists, album details, and save / unsave albums |
| Music library | Like / unlike songs, liked songs, saved playlists, saved albums, and recently played songs |
| Playlist management | Create, rename, and delete your own regular playlists; add / remove songs and move songs up / down |
| Comments | Browse comments with pagination, like / unlike comments, and post top-level comments |
| Sharing | Copy official Soda Music share links from the song menu |

Follows, likes, saves, and playlist edits use your signed-in Soda Music account. Playlist management is limited to regular playlists that you own and are allowed to edit.

## Installation

Requires **MyGo Music 0.1.20 or later**.

### Install from the repository

[Install with one click](mygo-music://install-plugin?repo=lane128/mygo-music-qishui), or enter the repository URL in MyGo Music under **Settings → Plugins → +**:

```text
https://github.com/lane128/mygo-music-qishui
```

MyGo Music automatically selects the package for your operating system and CPU architecture. Use **Check for Updates** in the plugin menu to update later.

### Import a ZIP manually

Download the appropriate package from the [latest release](https://github.com/lane128/mygo-music-qishui/releases/latest), then import it in MyGo Music's plugin settings:

| Device | Package | System requirements |
| --- | --- | --- |
| Apple Silicon Mac (M series) | `plugin-darwin-arm64.zip` | macOS 13+ |
| Intel Mac | `plugin-darwin-amd64.zip` | macOS 13+ |
| Intel / AMD Windows PC | `plugin-windows-amd64.zip` | Windows 10 / 11 x64 |
| ARM Windows PC | `plugin-windows-arm64.zip` | Windows 11 ARM64 with x64 emulation |

## Sign-in and usage

After installation, select **Sign In**, scan the QR code with the Soda Music app, and confirm on your phone. The session is saved in MyGo Music's plugin storage. Scan again when it expires.

- Discover music through **Home**, **Recommendations**, and **Listening Modes**, or search directly for songs, artists, albums, and playlists.
- Select an artist's name on a song to browse their songs and albums or follow them.
- Find your playlists, saved albums, and playback history in the sidebar. Open your profile page from the account menu.
- Use song, album, and playlist menus to like, save, download, share, and edit playlists.

Some requests and playback operations require the bundled helper. Allow it to run when prompted by MyGo Music if you want to use those features. If a session expires, a rate limit is reached, or additional verification is required, the plugin displays a message and stops the affected operation.

## Audio quality and playback

The plugin maps MyGo Music's three quality settings to Soda Music sources:

| MyGo Music quality | Source preference | Playback format |
| --- | --- | --- |
| Standard | `higher` | AAC-LC M4A |
| High | `highest` → `higher` | AAC-LC M4A |
| Lossless | `lossless` → `highest` → `higher` | Native FLAC, or M4A when falling back |

After decryption, AAC-LC is passed directly to MyGo Music as M4A, while native FLAC is passed through unchanged. Playback no longer uses FFmpeg conversion. M4A does not imply lossless audio. When a lower-quality source is used, the plugin reports the actual source quality to the host.

All settings exclude the `medium` source. Availability depends on your account's membership, region, and authorization from Soda Music. Playback is reported as unavailable when only a preview is authorized, no suitable source is available, or the format is unsupported. Selecting **Lossless** does not guarantee that every song has a lossless source.

## Usage notes

- **Lyrics and translations:** Only official content is displayed. Line-synced lyrics are used when reliable word timing is unavailable. Translations are not generated when none are provided.
- **Playback history:** Records when a song starts playing, rather than total listening time. The list shows up to 1,000 songs, and cached results may take time to refresh when you return to the page.
- **Comments and library edits:** These actions affect your actual Soda Music account. If posting or editing times out, refresh and check the result before trying again.
- **Playlist ordering:** The current order is checked before changes are submitted. Refresh before editing if another client is modifying the same playlist.
- **Feature limits:** Podcasts, remote device control, comment replies and deletion, and audio gain / peak metadata are not currently supported.

Live-account verification of newly added write operations, full listening checks, and device testing on some platforms remain pending. See the [validation record](VALIDATION.md) for details and the [feature roadmap](TODO.md) for progress. These documents are currently in Chinese.

## Feedback

When reporting a problem in [Issues](https://github.com/lane128/mygo-music-qishui/issues), include:

- Your operating system version, CPU architecture, and MyGo Music and plugin versions.
- Steps to reproduce the problem. For song or page issues, include a Soda Music share link if available.
- Relevant screenshots or error messages with sensitive information removed.

Do not share cookies, QR tokens, or other sign-in credentials. To roll back, download a package for your architecture from an [earlier release](https://github.com/lane128/mygo-music-qishui/releases) and import it again. Rolling back does not undo changes already made to your Soda Music account.

## Development

Requires Node 20+, npm, and Go 1.27+:

```sh
npm ci
npm run build
npm test
npm run test:native
```

Native builds also require the official components and toolchain for the target platform. See the [release process](RELEASE.md) for packaging, validation, and publishing, and the [Windows launcher documentation](native/windows-runner/README) for native isolation details. These documents are currently in Chinese. Runtime packages include the corresponding source code and licenses. Separate validation packages are for development and are not uploaded as installable release assets.

## License

The plugin source is licensed under [AGPL-3.0-only](LICENSE). This is an independent plugin and does not represent Soda Music or MyGo Music.

See [NOTICE.md](NOTICE.md) for third-party component and resource sources and licenses.
