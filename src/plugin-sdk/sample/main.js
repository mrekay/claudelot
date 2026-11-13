// Hızlı Notlar: the plugin's background script. It runs once when the plugin is turned on and
// registers the plugin's buttons, panels and commands. Panels are separate pages (notes.html, board.html).

(async () => {
  await vox.ready;

  // a panel that slides in from the right
  await vox.ui.addPanel({ id: 'notes', title: 'Notlar', icon: 'fa-solid fa-note-sticky', page: 'notes.html', place: 'drawer' });
  // a full-screen panel with its own tab next to AI / IDE / DB
  await vox.ui.addPanel({ id: 'board', title: 'Pano', icon: 'fa-solid fa-table-cells-large', page: 'board.html', place: 'mode' });

  // a title bar button that opens / closes the notes panel
  await vox.ui.addButton({ id: 'notes', place: 'titlebar', icon: 'fa-solid fa-note-sticky', title: 'Hızlı notlar (Ctrl+Alt+K)', panel: 'notes' });

  // a status bar button with the note count
  const notes = (await vox.storage.get('notes')) || [];
  await vox.ui.addButton({ id: 'count', place: 'statusbar', icon: 'fa-solid fa-note-sticky', label: `${notes.length} not`, title: 'Notları aç', panel: 'notes' });

  // a keyboard shortcut; it also shows up in Settings → Kısayollar
  await vox.commands.register({ id: 'open', title: 'Hızlı notları aç / kapat', keys: 'Ctrl+Alt+K', run: () => vox.ui.openPanel('notes') });
})();
