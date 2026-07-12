// ELF Arsenal is a self-contained PS5 payload that serves its complete WebUI on
// port 6969. Porkfolio intentionally embeds that UI instead of duplicating its
// routes and behavior, so the page tracks the version running on the console.

function buildElfArsenalEmbed() {
  const root = document.getElementById('page-elf-arsenal');
  if (!root) return;
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1>ELF Arsenal</h1>
        <p class="page-subtitle">Embedded WebUI served by the ELF Arsenal payload on your PS5.</p>
      </div>
      <div class="header-tools">
        <span id="ea-embed-status" class="hint">Checking connection...</span>
        <button id="ea-embed-reload" class="btn">Reload WebUI</button>
      </div>
    </div>
    <div class="card" style="padding:0;overflow:hidden;min-height:680px">
      <iframe id="ea-embed-frame" title="ELF Arsenal WebUI" sandbox="allow-scripts allow-forms allow-same-origin allow-popups" style="display:block;width:100%;height:calc(100vh - 210px);min-height:640px;border:0;background:#09090b"></iframe>
    </div>
    <p class="hint" style="margin:10px 0 0">ELF Arsenal must already be running on the configured PS5. Its WebUI is served at port 6969 and is not reimplemented by Porkfolio.</p>`;

  const reload = () => {
    // The main-process probe supplies the exact host/port base URL without
    // exposing settings values to the renderer.
    window.pork.eaEmbedUrl().then((result) => {
      const status = document.getElementById('ea-embed-status');
      const frame = document.getElementById('ea-embed-frame');
      if (!frame || !status) return;
      if (!result.connected) {
        frame.removeAttribute('src');
        status.textContent = result.error || 'ELF Arsenal is unavailable on port 6969.';
        status.style.color = 'var(--red)';
        return;
      }
      frame.src = result.url;
      status.textContent = result.version ? `Connected: ${result.version}` : 'Connected';
      status.style.color = 'var(--green)';
    }).catch((error) => {
      const status = document.getElementById('ea-embed-status');
      if (status) { status.textContent = `Connection error: ${error.message}`; status.style.color = 'var(--red)'; }
    });
  };
  document.getElementById('ea-embed-reload').addEventListener('click', reload);
  reload();
}

async function loadElfArsenal() {
  if (!document.getElementById('ea-embed-frame')) buildElfArsenalEmbed();
}
