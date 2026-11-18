# Create Economy Launcher (desktop)

A launcher for Windows, macOS and Linux that only plays Create Economy:
custom background (real server screenshots, no Mojang branding), server status, Discord news,
one big **Play** button, and automatic pack updates from the `create-economy-pack` GitHub repository.

What happens when a player presses Play:

1. Reads `pack.json` from the pack repository (newest commit) and downloads anything that changed.
2. Installs Java 21 (Mojang's own runtime) and NeoForge (NeoForge's official installer, headless).
3. Downloads Minecraft's libraries and assets, all SHA-1 checked.
4. Signs in (Microsoft account) and starts the game, straight into the server or to the menu.

The launcher updates itself from this repository's GitHub releases.

## One-time setup

### 1. GitHub repositories (both public)

- `Mrvew/create-economy-pack` - contents of `../ce-pack-repo` (the modpack).
- `Mrvew/create-economy-launcher` - this folder (the launcher). Releases here are the downloads.

### 2. Signing in

**Default (nothing to set up):** players sign in through the official Minecraft Launcher, which
Mojang already approves and which every Java player already has. Pressing Play here installs and
updates the pack, puts a "Create Economy" profile (icon, RAM, game folder) into the Minecraft
Launcher, selects it and opens it; the player presses Play there. If the Minecraft Launcher isn't
installed, the launcher says so and links to minecraft.net.

**Optional: sign in inside this launcher** (skips the Minecraft Launcher entirely):

Every third-party Minecraft launcher needs its own Azure app that Mojang has approved:

1. https://portal.azure.com -> App registrations -> New registration.
   - Name: Create Economy Launcher
   - Supported account types: **Personal Microsoft accounts only**
   - Redirect URI: platform **Public client/native (mobile & desktop)**,
     `https://login.microsoftonline.com/common/oauth2/nativeclient`
2. Copy the **Application (client) ID**.
3. Apply for Minecraft API access: https://aka.ms/mce-reviewappid (client id, tenant id, email).
   Approval can take a while. Until then sign-in fails with "not approved".
4. In the launcher repository on GitHub: Settings -> Secrets -> Actions -> New secret
   `CE_MS_CLIENT_ID` = the client id. The next release build has sign-in turned on.

Don't reuse another launcher's client id (Prism's, the official one's): their terms forbid it and
Microsoft can block it for every player at once.

### 3. Make a release

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions (`.github/workflows/release.yml`) builds:

- Windows: `Create-Economy-Launcher-Setup-<v>-x64.exe` (installs, makes Desktop + Start menu shortcuts) and a portable `.exe`
- macOS: universal `.dmg` and `.zip`
- Linux: `.AppImage` and `.deb`

Installed launchers see the new release and update themselves (Windows/Linux automatically;
macOS shows a download link, because unsigned Mac apps cannot replace themselves).

### Unsigned builds

- Windows SmartScreen shows "Windows protected your PC" the first time -> More info -> Run anyway.
  A code-signing certificate removes this.
- macOS: right-click the app -> Open the first time. An Apple Developer account ($99/yr) for
  signing + notarising removes this and enables self-update on Mac.

## Pinning

- Windows: the installer creates Desktop and Start menu shortcuts. Windows doesn't let apps pin
  themselves, so the launcher shows a two-step "Pin to taskbar" guide on first start.
- macOS: drag to Applications, then right-click the Dock icon -> Options -> Keep in Dock.

## Development

```bash
npm install
npm start
```

Useful environment variables (dev builds only):

- `CE_PACK_BASE_URL=http://127.0.0.1:8765/` - read the pack from a local folder served with
  `python -m http.server 8765 --directory ../ce-pack-repo`
- `CE_DATA_DIR=<folder>` - use a separate data folder
- `CE_MS_CLIENT_ID=<id>` - test sign-in
- `CE_OFFLINE_NAME=Tester` + `CE_AUTOPLAY=menu` - start the game without signing in (dev only)
- `CE_SCREENSHOT=<folder>` - save screenshots of each screen and quit

Data lives in `%APPDATA%\CreateEconomy` (Windows), `~/Library/Application Support/CreateEconomy`
(macOS) or `~/.config/CreateEconomy` (Linux): `instance/` is the game folder (mods, saves,
screenshots), `minecraft/` holds shared versions, libraries and assets, `runtime/` holds Java.
