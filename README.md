# Kuro Linux

This is a Fedora/GNOME Builder-compatible Linux host for the Kuro UI recovered
from the installed Windows artifact. It keeps the shipped HTML/CSS dashboard and
replaces the WPF/WebView2 shell with a GTK3 + WebKitGTK 4.1 host, which is the
most portable WebKitGTK pairing for the Fedora SDK used by this project.

## Current scope

- GTK3 window and WebKitGTK host.
- Persistent WebKit local storage for theme and UI preferences.
- JSON request/response bridge compatible with `ui/app.js`.
- Fedora-native Meson project suitable for GNOME Builder.
- Flatpak manifest for a reproducible GNOME Builder build.
- Safe default: production authentication, recording, payout, update, and
  upload services are not guessed from the Windows binary.

The local demo backend can be enabled for UI smoke testing with:

```bash
KURO_LINUX_DEMO=1 ./builddir/src/kuro
```

In demo mode, sign-in and onboarding are local-only and recording controls are
stateful UI fixtures; no screen, keyboard, or mouse data is captured or uploaded.

## Build with GNOME Builder on Fedora

Install the SDK packages first (or use the matching GNOME Builder SDK):

```bash
sudo dnf install gcc meson ninja-build pkgconf-pkg-config \
  gtk3-devel webkit2gtk4.1-devel json-glib-devel
```

Then open this folder in GNOME Builder, configure the Meson project, and build
the `kuro` target. A command-line equivalent is:

```bash
meson setup builddir
meson compile -C builddir
meson install -C builddir --destdir "$PWD/stage"
```

## Flatpak / GNOME Builder manifest

`packaging/app.trykuro.Kuro.yml` is a GNOME runtime manifest. GNOME Builder can
open it as a Flatpak project; from Fedora, the equivalent command is:

```bash
flatpak-builder --user --install --force-clean "$HOME/.cache/kuro-flatpak-build" \
  packaging/app.trykuro.Kuro.yml
```

## Reverse-engineering boundary

The investigation notes and REA evidence IDs are in
`docs/rea-investigation.md`. The Linux host is a clean-room compatibility
implementation around the observed UI/bridge contract, not a claim that the
Windows WPF/DXGI/Media Foundation implementation can run on Linux unchanged.
