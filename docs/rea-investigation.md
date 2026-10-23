# Kuro Windows REA investigation

## Inputs

- Installer: `resources/KuroWindows-win-Setup.exe` (85,404,248 bytes).
- Native launcher: `resources/KuroWindows.exe` (177,160 bytes).
- Installed tree: `C:\Users\ankit\AppData\Local\KuroWindows`.
- Installed managed assembly: `current/KuroWindows.dll` (1,474,568 bytes).
- Installed UI bundle: `current/ui/`.

## Evidence-backed observations

### Packaging

- `ev_859df548d0395b8c0fdae47cd99c2dafde309a3fc3c019e24504ae30e017dfb8`
  identifies `KuroWindows-1.1.13-full.nupkg` as a ZIP artifact. The installed
  layout contains Velopack files (`Update.exe`, `packages/`, `velopack.log`).
- The large installer exceeded REA's default 64 MiB static resource budget for
  PE resource inspection. That is a tooling limit, not evidence that the file
  is invalid or that its resources are absent.

### Native/managed boundary

- `ev_2067f5d3c20b84a20e9788a96d47a5d8d0719298796dbee7c74ea0d070efbe52`
  classifies the small `KuroWindows.exe` launcher as x86-64 PE without a CLI
  directory. It is not the application logic assembly.
- `ev_258e4df28936fe94f1d08090f46d32962830cfe99ebdab64988a49fab1be1b44`
  classifies `KuroWindows.dll` as a modern .NET 8 x86-64 managed assembly.

### Host architecture

- REA member evidence for `KuroWindows.App` (`ev_27c8e0b55a197c1c134b6b36090446ea6d1a02edbfdcbf40a2202100b5ab98be`)
  shows a WPF application, tray icon, single-instance command handling,
  `SessionCoordinator`, `UploadManager`, `CoreBridge`, updater, and shell
  window lifecycle.
- REA member evidence for `KuroWindows.UI.ShellWindow`
  (`ev_7872547a387a128ff02b450cff3453c9c698b0844e73283ae3f23fe28233acc0`)
  shows WebView2 `PostWebMessageAsJson`, a 600x400 solo mode, an 800x600
  dashboard mode, and a file-backed UI URI.
- REA member evidence for `KuroWindows.AppCommandServer`
  (`ev_9b5919398a42efe8c1811be9a820a3e1fcfd19f9e6365a20a16fc52131beb0c9`)
  shows a named-pipe single-instance command path on Windows.

### Recorder scope

- `ev_52e34a24bbf13fb916bf1f758c8e76bc95398e413b6bdee4e1d5427d06ee7565`
  shows the coordinator owns capture, input, system, idle, microphone, camera,
  privacy, disk-space, segment, and upload state. REA static user strings also
  show DXGI/Windows Graphics Capture, H.264/Media Foundation, segment rotation,
  privacy pause, low-disk handling, and upload markers.
- This is static evidence only. It does not establish that the executable was
  run during this investigation, nor does it establish server-side APIs.

## Inferences used by the Linux port

1. The web UI can be reused because the installed `ui/` tree is self-contained
   and its JavaScript already expresses a clear JSON bridge contract.
2. GTK3 + WebKitGTK 4.1 is a better Fedora-native host than attempting to run WPF,
   WebView2, DXGI, or Windows Media Foundation through compatibility layers.
3. The first Linux build must isolate unknown production services behind an
   explicit bridge and default to no capture/upload behavior. The demo backend
   is intentionally local-only.

## Unknowns and follow-up work

- The Windows server authentication protocol and OAuth callback lifecycle were
  not reconstructed into a Linux implementation.
- The production desktop-sync, capture, privacy, encoder, upload, payout, and
  updater protocols are not present as source in this workspace.
- A production Fedora recorder should use explicit user consent and the desktop
  portal/PipeWire flow for screen capture, plus a separately reviewed input
  monitoring design. The current host does not implement those capabilities.

## REA limitations

REA evidence is tied to the exact artifact digests above. Static member/CIL
inspection does not load the target assembly, execute it, recover original C#,
or prove runtime behavior. The Linux project therefore documents observed
contracts separately from implementation choices.
