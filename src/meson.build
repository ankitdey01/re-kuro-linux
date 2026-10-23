executable('kuro', 'main.c',
  dependencies: [gtk, gio, json_glib, webkit],
  c_args: [
    '-DPACKAGE_DATADIR="' + get_option('prefix') / get_option('datadir') + '"',
    '-DPROJECT_UI_DIR="' + meson.project_source_root() / 'ui' + '"',
  ],
  install: true,
)
