# Kuro Linux handoff

Updated: 2026-10-23

## Goal

Continue the Fedora Linux port of the Windows Kuro app. The target is a
GNOME Builder/Fedora-buildable GTK3 + WebKitGTK 4.1 application that hosts the
recovered Kuro UI and exposes its JSON bridge. A production-quality recorder,
authentication, upload, payout, and updater implementation remains out of
scope until the required protocols/backends are known.

Acceptance still in scope:

- Configure and build with Meson on Fedora/GNOME Builder.
- Launch the Kuro UI in a native Linux window.
- Preserve onboarding/dashboard UI behavior through the native bridge.
- Keep demo mode local-only: no screen, keyboard, mouse, microphone, camera,
  or upload activity.
- Produce a reproducible Flatpak/GNOME Builder build if the Fedora SDK supports
  the declared dependencies.

## State

Completed locally:

- REA investigation of the Windows launcher, installed .NET assembly, nupkg,
  and installed UI bundle.
- Clean-room Linux host scaffold using GTK3, WebKitGTK 4.1, JSON-GLib, and
  Meson.
- WebView2 compatibility bridge for `window.chrome.webview`.
- Snapshot, onboarding, dashboard fixture, theme, window, external-link,
  startup-preference, and safe unsupported-service command handling.
- Trusted packaged UI URI check and HTTPS Kuro-domain allowlist for external
  links.
- Fedora/Flatpak metadata and REA notes.

Incomplete or blocked:

- No native Linux build has run in this environment.
- Fedora/GNOME Builder was not available here.
- The current shell has `gcc` and `pkg-config`, but no `meson`, `ninja`, or
  `flatpak-builder`; required GTK/WebKit/JSON-GLib pkg-config modules are also
  missing.
- Production OAuth/authentication, PipeWire/desktop-portal capture, input
  monitoring, encoding, privacy monitors, upload, payout, and update services
  are not implemented.
- `begin_window_drag` is currently a no-op; native drag gesture support can be
  added after the first Fedora build works.

## Repository and working tree

- Repository: `C:\Users\ankit\Desktop\rea-kuro-linux`
- Fedora path after copying: `~/rea-kuro-linux`
- Branch: `main`
- HEAD at handoff: `3c3a30b` (`first commit`)
- No running process needs to be resumed.
- Working tree is not clean. Git reports these modified tracked UI files:
  `ui/app.js`, `ui/index.html`, `ui/colors_and_type.css`, `ui/styles.css`,
  `ui/assets/kuro-app-icon.svg`, and `ui/assets/kuro-mark.svg`.
- `git diff --ignore-space-at-eol` produced no output for those files; the
  current diff is therefore line-ending/normalization noise relative to HEAD.
  Do not commit it blindly. Preserve intentional Linux UI changes while
  normalizing line endings deliberately.

## Important files

- `meson.build` — project dependencies and installation rules.
- `src/main.c` — GTK/WebKit host, persistent settings, JSON bridge, demo state,
  navigation boundary, and Flatpak-safe startup behavior.
- `src/meson.build` — `kuro` executable target and compile-time UI paths.
- `ui/index.html` — recovered Kuro markup; includes `linux-bridge.js` before
  `communications.js` and `app.js`.
- `ui/linux-bridge.js` — WebKitGTK compatibility shim for the WebView2 bridge.
- `ui/app.js` — recovered UI/controller code with Linux labels and the known
  `linux_payout_unavailable` error copy.
- `packaging/app.trykuro.Kuro.yml` — GNOME runtime 48 Flatpak manifest; network
  access is intentionally not granted in the current local/demo build.
- `README.md` — Fedora/GNOME Builder setup and commands.
- `docs/rea-investigation.md` — artifact identities, REA evidence IDs,
  observations, inferences, and unknowns.

## Decisions

- Use GTK3 + WebKitGTK 4.1 rather than WPF/WebView2 compatibility layers. The
  Windows host depends on WPF, WebView2, DXGI, and Media Foundation; those are
  not portable Linux implementation choices.
- Keep the recovered HTML/CSS/JS instead of rewriting the UI. The bundle already
  defines the request/response contract used by the Windows shell.
- Keep production services disabled by default. Do not infer server protocols
  or implement capture/upload from static binary strings alone.
- Use a trusted exact `file:` URI for the packaged `index.html`; arbitrary local
  files must not get bridge access.
- Restrict external browser launches to HTTPS Kuro domains.

## Checks

### Test / syntax

Passed on 2026-10-23 from the repository root:

```bash
node --check ui/app.js
node --check ui/communications.js
node --check ui/linux-bridge.js
```

### Lint

Not run. No lint configuration or lint command is present in the project.

### Typecheck

Not applicable to the C/vanilla-JS project; no typecheck command is present.

### Build

Not run / blocked. The current environment does not contain `meson`, `ninja`,
or `flatpak-builder`. `pkg-config` reports these required modules missing:

```text
gtk+-3.0
webkit2gtk-4.1
json-glib-1.0
gio-2.0
```

### Manual smoke

Not run because no native build exists here. Intended local demo command:

```bash
KURO_LINUX_DEMO=1 ./builddir/src/kuro
```

Expected behavior: local sign-in/onboarding/dashboard fixture flow only; no
capture or upload occurs.

## Next step

On Fedora, start in `~/rea-kuro-linux` and install/configure the build
dependencies, then run:

```bash
sudo dnf install gcc meson ninja-build pkgconf-pkg-config \
  gtk3-devel webkit2gtk4.1-devel json-glib-devel
meson setup builddir
meson compile -C builddir
KURO_LINUX_DEMO=1 ./builddir/src/kuro
```

If configuration or compilation fails, fix the first Fedora/GTK/WebKit error in
`src/main.c` or `meson.build`, rerun `meson compile -C builddir`, and only then
attempt Flatpak/GNOME Builder packaging.
