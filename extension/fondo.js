// Borra las notas guardadas cuando cumplen 12 horas, aunque no se vuelva a abrir la extensión.
const CADUCAN_MS = 12 * 60 * 60 * 1000;

async function programarBorrado() {
  const { notas } = await chrome.storage.local.get('notas');
  await chrome.alarms.clear('borrar-notas');
  if (!notas) return;
  const cuando = notas.creado + CADUCAN_MS;
  if (cuando <= Date.now()) return chrome.storage.local.remove('notas');
  chrome.alarms.create('borrar-notas', { when: cuando });
}

chrome.storage.onChanged.addListener((cambios, zona) => { if (zona === 'local' && 'notas' in cambios) programarBorrado(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'borrar-notas') chrome.storage.local.remove('notas'); });
chrome.runtime.onStartup.addListener(programarBorrado);
chrome.runtime.onInstalled.addListener(programarBorrado);
