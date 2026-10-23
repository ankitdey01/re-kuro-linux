project('kuro-linux', 'c',
  version: '1.1.13-linux.1',
  meson_version: '>= 0.63.0',
  default_options: ['c_std=c11', 'warning_level=3'],
)

gnome = import('gnome')

gtk = dependency('gtk+-3.0')
gio = dependency('gio-2.0')
json_glib = dependency('json-glib-1.0')
webkit = dependency('webkit2gtk-4.1')

subdir('src')

install_subdir('ui', install_dir: get_option('datadir') / 'kuro')
install_data('data/app.trykuro.Kuro.desktop',
  install_dir: get_option('datadir') / 'applications')
install_data('data/app.trykuro.Kuro.metainfo.xml',
  install_dir: get_option('datadir') / 'metainfo')
install_data('ui/assets/kuro-app-icon.svg',
  install_dir: get_option('datadir') / 'icons/hicolor/scalable/apps',
  rename: 'app.trykuro.Kuro.svg')
