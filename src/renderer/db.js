/* VoxStorm DB mode (placeholder): the database client is built here. */
/* global api */
(() => {
  const view = document.getElementById('dbView');
  window.dbMode = {
    show() {
      if (!view.firstChild) view.innerHTML = '<div class="db-empty"><i class="fa-solid fa-database"></i><b>Veritabanı modu</b><span>MSSQL, PostgreSQL, MySQL ve MariaDB bağlantıları burada olacak.</span></div>';
    },
    hide() {},
  };
})();
