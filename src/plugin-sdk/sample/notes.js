// the notes panel: notes live in the plugin's own storage
const $ = s => document.querySelector(s);
let notes = [];

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function render() {
  $('#list').innerHTML = notes.length
    ? notes.map((n, i) => `<li><div style="flex:1"><p>${esc(n.text)}</p><time>${new Date(n.at).toLocaleString('tr-TR')}</time></div><button data-del="${i}" title="Sil" aria-label="Notu sil">✕</button></li>`).join('')
    : '<div class="empty">Henüz not yok.</div>';
}
async function save() {
  await vox.storage.set('notes', notes);
  await vox.ui.updateButton('count', { label: `${notes.length} not` });
  render();
}
$('#f').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('#t').value.trim();
  if (!text) return;
  notes.unshift({ text, at: Date.now() });
  $('#t').value = '';
  await save();
  if (notes.length % 10 === 0) vox.notify('Tebrikler', `${notes.length}. notunu yazdın.`);
});
$('#t').addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) $('#f').requestSubmit(); });
$('#list').addEventListener('click', async e => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  if (!(await vox.ui.confirm({ title: 'Not silinsin mi?', message: notes[+b.dataset.del].text.slice(0, 200), ok: 'Sil', danger: true }))) return;
  notes.splice(+b.dataset.del, 1);
  await save();
});
// the panel is opened again later: focus the box each time it shows
vox.on('panel', p => { if (p.visible) $('#t').focus(); });

vox.ready.then(async () => { notes = (await vox.storage.get('notes')) || []; render(); $('#t').focus(); });
