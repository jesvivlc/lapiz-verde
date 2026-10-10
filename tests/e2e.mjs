// Prueba de extremo a extremo del frontend en Chromium, con Supabase y /api simulados.
// Necesita Playwright y JSZip (no están en package.json para no inflar el despliegue):
//   npm i --no-save playwright@1.63.0 jszip && npx playwright install chromium && node tests/e2e.mjs
// Deja capturas en tests/capturas/.
import { chromium } from 'playwright';
import fs from 'fs';
const JSZip = (await import('jszip')).default;

const REPO = new URL('../', import.meta.url).pathname;
const OUT = new URL('./capturas/', import.meta.url).pathname; fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  FAIL') + ' ' + m); if (!c) fails++; };

// ── ZIPs de prueba ──
const pdf = Buffer.from('%PDF-1.4 falso');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const teams = new JSZip();
const pdfDe = (quien) => Buffer.from('%PDF-1.4 ' + quien);   // el contenido dice de quién es (la petición ya no lleva el nombre)
teams.file('Comentario tema 3/Ana López García/Versión 1/trabajo.pdf', pdfDe('Ana'));
teams.file('Comentario tema 3/Ana López García/Versión 2/trabajo.pdf', pdfDe('Ana'));
teams.file('Comentario tema 3/Luis Pérez/foto.png', png);
teams.file('Comentario tema 3/Marta Ruiz/trabajo.pdf', pdfDe('Marta'));
teams.file('Otra tarea/Sara Gil/x.pdf', pdf);
fs.writeFileSync(OUT + 'teams.zip', await teams.generateAsync({ type: 'nodebuffer' }));
const moodle = new JSZip();
moodle.file('Ana López_1234_assignsubmission_file_/redaccion.pdf', pdfDe('Ana'));
fs.writeFileSync(OUT + 'moodle.zip', await moodle.generateAsync({ type: 'nodebuffer' }));

// ── Datos simulados ──
const USER = { id: 'u-1', email: 'bruno@x.es', aud: 'authenticated', role: 'authenticated' };
const db = {
  perfiles: [{ id: 'u-1', email: 'bruno@x.es', nombre: 'Bruno', creditos: 18 }],
  grupos: [{ id: 'g-1', nombre: '3.º ESO A', nivel: '3ESO' }],
  tareas: [{ id: 't-1', titulo: 'Comentario tema 3', rubrica: '- Rúbrica guardada (10 pts)', evaluacion: '1', peso_nota: null }],
  alumnos: [
    { id: 'a-1', nombre: 'Ana', apellidos: 'López García', email: 'ana@x.es' },
    { id: 'a-2', nombre: 'Luis', apellidos: 'Pérez', email: '' },
    { id: 'a-3', nombre: 'Marta', apellidos: 'Ruiz', email: 'marta@x.es' },
    { id: 'a-4', nombre: 'Sara', apellidos: 'Gil', email: '' },
  ],
};
db.entregas = [];
const upserts = [], correcciones = [], patches = [], borrados = [], llamadasEntregas = [], subidas = [];
let creditosApi = 18;
// De quién es una corrección, por el contenido del primer archivo (Ana y Marta mandan PDF; Luis, foto)
const quien = (b) => { const t = Buffer.from(b.archivos?.[0]?.base64 ?? '', 'base64').toString('latin1'); return t.includes('Marta') ? 'Marta' : t.includes('Ana') ? 'Ana' : 'Luis'; };

async function prepararRuta(route) {
  const req = route.request(); const url = new URL(req.url());
  const json = (b, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
  if (url.host === 'app.test') {
    if (url.pathname === '/' || url.pathname === '/index.html') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(REPO + 'index.html') });
    if (url.pathname === '/entregar.html') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(REPO + 'entregar.html') });
    if (url.pathname === '/pasar-notas.js' || /^\/extension\/[\w.-]+$/.test(url.pathname)) {
      const f = REPO + url.pathname.slice(1);
      if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: f.endsWith('.js') ? 'text/javascript' : f.endsWith('.json') ? 'application/json' : 'text/plain', body: fs.readFileSync(f) });
    }
    if (url.pathname === '/api/entrega') {
      const b = req.postDataJSON(); llamadasEntregas.push(b);
      if (b.t !== 'T'.repeat(32)) return json({ error: 'Este enlace no es válido.' }, 404);
      if (b.accion === 'info') {
        return json({ tarea: { titulo: 'Libreta semana 12' }, grupo: { nombre: '3.º ESO A' }, profesor: 'Bruno', alumnos: [{ id: 'a-1', etiqueta: 'Ana L.' }, { id: 'a-2', etiqueta: 'Luis P.' }] });
      }
      if (b.accion === 'preparar') return json({ subidas: b.archivos.map((_, i) => ({ id: 'n-' + i, url: `https://fyoyyvzyoohsczceeyde.supabase.co/storage/v1/object/upload/sign/entregas/u-1/t/n-${i}.jpg?token=x` })) });
      return json({ recibidas: b.ids.length, total: b.ids.length });
    }
    if (url.pathname === '/api/corregir-entregas') {
      const b = req.postDataJSON(); correcciones.push({ ...b, via: 'entregas' });
      creditosApi--;
      return json({ nota: 8, nota_texto: 'Notable', comentario: 'Corregido desde la bandeja', propuestas_mejora: ['uno', 'dos', 'tres'], mensaje_motivador: '¡Bien!', legible: true, creditos_restantes: creditosApi });
    }
    if (url.pathname === '/api/corregir') {
      const b = req.postDataJSON(); correcciones.push(b);
      if (creditosApi <= 0) return json({ error: 'No te quedan correcciones.', codigo: 'SIN_CREDITOS' }, 402);
      creditosApi--;
      const legible = quien(b) !== 'Marta';
      return json({ nota: legible ? 7.5 : 3, nota_texto: legible ? 'Notable' : 'Insuficiente', comentario: `Comentario para ${quien(b)}`, propuestas_mejora: ['uno', 'dos', 'tres'], mensaje_motivador: '¡Sigue así!', legible, creditos_restantes: creditosApi });
    }
    if (url.pathname === '/api/rubrica') return json({ rubrica: '- Propuesta IA (10 pts)' });
    return route.fulfill({ status: 404, body: '' });
  }
  if (url.host.includes('cdn.') || url.host === 'cdnjs.cloudflare.com') return route.continue();
  if (url.host.includes('supabase.co')) {
    if (url.pathname === '/auth/v1/otp') return json({});
    if (url.pathname === '/auth/v1/user') return json(USER);
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });
    if (url.pathname.startsWith('/storage/v1/object/upload/sign/')) { subidas.push({ url: url.pathname, metodo: req.method(), tipo: req.headers()['content-type'] }); return json({ Key: 'x' }); }
    if (url.pathname === '/storage/v1/object/sign/entregas') {
      const b = req.postDataJSON();
      return json(b.paths.map(p => ({ path: p, signedURL: `/object/sign/entregas/${p}?token=ver` })));
    }
    if (url.pathname === '/storage/v1/object/entregas' && req.method() === 'DELETE') { borrados.push(...req.postDataJSON().prefixes); return json([]); }
    const tabla = url.pathname.replace('/rest/v1/', '');
    const m = req.method();
    if (m === 'POST' || m === 'PATCH') {
      const b = req.postDataJSON();
      if (tabla === 'notas') upserts.push(b);
      if (m === 'PATCH') {
        patches.push({ tabla, b, filtro: url.search });
        if (tabla === 'tareas' || tabla === 'grupos' || tabla === 'entregas') {
          const ids = decodeURIComponent(url.search).match(/id=(?:eq\.|in\.\()([^&)]+)/)?.[1]?.split(',').map(x => x.replace(/"/g, '')) || [];
          (db[tabla] || []).filter(f => ids.includes(f.id)).forEach(f => Object.assign(f, b));
        }
      }
      if (tabla === 'tareas' && m === 'POST') { const t = { id: 't-' + (db.tareas.length + 1), ...b }; db.tareas.unshift(t); return json(t, 201); }
      return json([], 201);
    }
    const eq = (k) => url.searchParams.get(k)?.replace(/^eq\./, '');
    let filas = db[tabla] || [];
    if (tabla === 'perfiles') filas = filas.filter(p => p.id === eq('id'));
    if (tabla === 'entregas') filas = filas.filter(e => e.tarea_id === eq('tarea_id'));
    if (tabla === 'grupos' && eq('id')) filas = filas.filter(g => g.id === eq('id'));
    const cabecera = req.headers()['accept'] || '';
    if (cabecera.includes('vnd.pgrst.object')) return json(filas[0] ?? null);
    return json(filas);
  }
  return route.abort();
}

async function prepararPagina(browser, { conSesion }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', e => errores.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errores.push(m.text()); });

  await page.route('**/*', prepararRuta);

  if (conSesion) {
    await ctx.addInitScript((user) => {
      localStorage.setItem('sb-fyoyyvzyoohsczceeyde-auth-token', JSON.stringify({
        access_token: 'tok', refresh_token: 'ref', token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, user,
      }));
    }, USER);
  }
  await page.goto('https://app.test/');
  return { page, ctx, errores };
}

const browser = await chromium.launch();
{ // foto de móvil de prueba: grande, para comprobar que se reduce antes de subir
  const p = await browser.newPage({ viewport: { width: 2400, height: 1800 } });
  await p.setContent('<body style="margin:0;background:linear-gradient(45deg,#fde68a,#86efac);font:120px serif">Mi libreta</body>');
  await p.screenshot({ path: OUT + 'foto-grande.png' });
  await p.close();
}

console.log('== Sin sesión: página de entrada ==');
{
  const { page, errores } = await prepararPagina(browser, { conSesion: false });
  await page.waitForSelector('#pantalla-entrada:not(.hidden)');
  ok(await page.isHidden('#app'), 'la app está oculta');
  await page.screenshot({ path: OUT + '1-entrada.png', fullPage: true });
  await page.fill('#loginEmail', 'nuevo@x.es');
  await page.click('#btnLogin');
  await page.waitForSelector('#loginOk:not(.hidden)');
  ok((await page.textContent('#loginOk')).includes('nuevo@x.es'), 'tras pedir el enlace, avisa de que revise el correo');
  ok(errores.length === 0, 'sin errores de JS' + (errores.length ? ': ' + errores.join(' | ') : ''));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: OUT + '1b-entrada-movil.png', fullPage: true });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'en móvil no hay scroll horizontal');
}

console.log('== Con sesión: corregir con grupo del cuaderno (ZIP de Teams) ==');
{
  const { page, errores } = await prepararPagina(browser, { conSesion: true });
  await page.waitForSelector('#app:not(.hidden)');
  await page.waitForFunction(() => document.getElementById('creditosChip').textContent.includes('18'));
  ok(true, 'muestra 18 correcciones en la cabecera');
  await page.selectOption('#selGrupo', 'g-1');
  await page.waitForFunction(() => !document.getElementById('selTarea').disabled);
  ok(await page.isHidden('#excelGroup'), 'con grupo elegido, el Excel se oculta');
  ok((await page.textContent('#alumnosBadge')).includes('4'), 'cuenta 4 alumnos del grupo');
  ok(await page.inputValue('#cursoForm') === '3ESO', 'el curso se toma del grupo');
  await page.selectOption('#selTarea', 't-1');
  ok(await page.inputValue('#rubrica') === '- Rúbrica guardada (10 pts)', 'carga la rúbrica guardada de la tarea');
  ok(await page.inputValue('#nombreTarea') === 'Comentario tema 3', 'rellena el nombre de la tarea');

  await page.setInputFiles('#zipFile', OUT + 'teams.zip');
  await page.click('#btnCorregir');
  await page.waitForSelector('#btnCorregir:not([disabled])', { timeout: 20000 });
  await page.waitForTimeout(300);

  ok(correcciones.length === 3, `3 correcciones enviadas (Sara es de otra tarea): ${correcciones.map(quien).join(', ')}`);
  ok(correcciones.every(c => !('nombre_alumno' in c) && !JSON.stringify(c).includes('López')), 'modo anónimo: ninguna petición lleva el nombre del alumno');
  const ana = correcciones.find(c => quien(c) === 'Ana');
  ok(ana?.archivos?.length === 1 && ana.archivos[0].tipo === 'pdf', 'de Ana solo va su última versión, como pdf');
  const luis = correcciones.find(c => quien(c) === 'Luis');
  ok(luis?.archivos?.[0]?.tipo === 'jpeg', 'imagen de Luis convertida y enviada como jpeg (antes fallaba)');
  ok(await page.textContent('#creditosChip') === '15 correcciones', 'los créditos bajan a 15');
  const primera = await page.$eval('#cardsGrid .student-card', el => el.textContent);
  ok(primera.includes('Marta') && primera.includes('No se ha podido leer'), 'la corrección ilegible sale la primera y marcada');
  ok((await page.textContent('#statsBar')).includes('1 sin entrega'), 'Sara aparece como sin entrega');
  ok(await page.isVisible('#btnAprobarTodas'), 'aparece «Aprobar todas»');
  await page.screenshot({ path: OUT + '2-revision.png', fullPage: true });

  // editar nota y comentario de Ana, y aprobar
  const idxAna = await page.evaluate(() => cards.findIndex(c => c.alumno.nombre.startsWith('Ana')));
  await page.fill(`#nota-${idxAna}`, '9.2');
  await page.dispatchEvent(`#nota-${idxAna}`, 'change');
  ok(await page.textContent(`#notaTexto-${idxAna}`) === 'Sobresaliente', 'al editar la nota cambia la calificación');
  await page.fill(`#comentario-${idxAna}`, 'Comentario retocado por el profe');
  await page.click(`#aprobarBtn-${idxAna}`);
  await page.waitForFunction((i) => document.getElementById('aprobarBtn-' + i).textContent.includes('Guardada'), idxAna);
  const up = upserts.at(-1);
  ok(up.alumno_id === 'a-1' && up.tarea_id === 't-1' && up.nota === 9.2 && up.origen === 'markmate' && up.comentario_ia === 'Comentario retocado por el profe',
    'Aprobar guarda en notas con origen=markmate y lo editado');
  ok(up.mejoras_ia === 'uno\ndos\ntres' && up.mensaje_motivador === '¡Sigue así!' && up.corregido_at, 'guarda mejoras, mensaje y fecha');

  page.once('dialog', d => d.accept());
  await page.click('#btnAprobarTodas');
  await page.waitForTimeout(500);
  const aprobados = upserts.map(u => u.alumno_id);
  ok(aprobados.includes('a-2') && !aprobados.includes('a-3'), '«Aprobar todas» guarda a Luis y NO la ilegible de Marta');
  ok(errores.length === 0, 'sin errores de JS' + (errores.length ? ': ' + errores.join(' | ') : ''));
  await page.screenshot({ path: OUT + '3-aprobadas.png', fullPage: true });
}

console.log('== ZIP de Moodle/Aules + Excel, y quedarse sin créditos ==');
{
  correcciones.length = 0; creditosApi = 0;
  const { page, errores } = await prepararPagina(browser, { conSesion: true });
  await page.waitForSelector('#app:not(.hidden)');
  // Excel generado al vuelo
  await page.evaluate(() => {
    const ws = XLSX.utils.json_to_sheet([{ Nombre: 'Ana', Apellidos: 'López', Email: 'ana@x.es' }]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'A');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const dt = new DataTransfer(); dt.items.add(new File([buf], 'alumnos.xlsx'));
    const input = document.getElementById('excelFile'); input.files = dt.files; onExcelSelected(input);
  });
  await page.waitForFunction(() => document.getElementById('alumnosNum').textContent === '1');
  await page.fill('#nombreTarea', 'Redacción');
  await page.fill('#rubrica', '- x (10 pts)');
  await page.setInputFiles('#zipFile', OUT + 'moodle.zip');
  await page.click('#btnCorregir');
  await page.waitForSelector('#modal:not(.hidden)', { timeout: 20000 });
  ok(correcciones.length === 1 && quien(correcciones[0]) === 'Ana', 'encuentra a Ana en el ZIP de Moodle (sin nombre de tarea en la ruta)');
  ok((await page.textContent('#modalContenido')).includes('9 €'), 'sin créditos → abre la compra de bonos');
  await page.screenshot({ path: OUT + '4-sin-creditos.png', fullPage: true });
  await page.click('text=Cerrar');
  await page.click('#btnRubrica');
  await page.waitForFunction(() => document.getElementById('rubrica').value.includes('Propuesta IA') || document.querySelector('.toast.show'));
  ok(true, 'botón de rúbrica responde');
  ok(errores.filter(e => !e.includes('402')).length === 0, 'sin errores de JS' + (errores.length ? ': ' + errores.join(' | ') : ''));
}

console.log('== Cuaderno ==');
{
  const { page, errores } = await prepararPagina(browser, { conSesion: true });
  await page.waitForSelector('#app:not(.hidden)');
  db.v_resumen_grupo = [{ grupo_id: 'g-1', grupo_nombre: '3.º ESO A', nivel: '3ESO', anio_academico: '2026-2027', total_alumnos: 4, total_tareas: 1, media_general: 7.9 }];
  db.notas = [{ alumno_id: 'a-1', tarea_id: 't-1', nota: 9.2, faltas: null, origen: 'markmate' }];
  await page.click('.tab-btn[data-tab="cuaderno"]');
  await page.waitForSelector('.grupo-card');
  ok((await page.textContent('.grupo-card')).includes('3.º ESO'), 'lista el grupo con su curso');
  await page.click('.grupo-card');
  await page.waitForSelector('.notas-table');
  ok(await page.$eval('.input-nota.origen-ia', el => el.value) === '9.2', 'la nota corregida aparece en el cuaderno, marcada');
  await page.click('text=+ Nueva tarea');
  ok(await page.isVisible('#ntTitulo'), 'abre el formulario de nueva tarea');
  await page.screenshot({ path: OUT + '5-cuaderno.png', fullPage: true });
  ok(errores.length === 0, 'sin errores de JS' + (errores.length ? ': ' + errores.join(' | ') : ''));
}

console.log('== Entregas recibidas: bandeja, enlace, corregir, asignar ==');
{
  correcciones.length = 0; patches.length = 0; borrados.length = 0; creditosApi = 10;
  const R = { nota: 6.5, nota_texto: 'Bien', comentario: 'Corregido esta noche', propuestas_mejora: ['a', 'b', 'c'], mensaje_motivador: 'Vamos', legible: true };
  db.entregas = [
    { id: 'e1', tarea_id: 't-1', alumno_id: 'a-1', estado: 'pendiente', canal: 'enlace', nombre_fichero: 'p1.jpg', ruta: 'u-1/t-1/e1.jpg', created_at: '1' },
    { id: 'e2', tarea_id: 't-1', alumno_id: 'a-1', estado: 'pendiente', canal: 'enlace', nombre_fichero: 'p2.jpg', ruta: 'u-1/t-1/e2.jpg', created_at: '2' },
    { id: 'e3', tarea_id: 't-1', alumno_id: 'a-2', estado: 'corregida', resultado: R, canal: 'correo', nombre_fichero: 'x.pdf', ruta: 'u-1/t-1/e3.pdf', created_at: '3' },
    { id: 'e4', tarea_id: 't-1', alumno_id: null, estado: 'pendiente', canal: 'correo', remitente: 'desconocido@gmail.com', nombre_fichero: 'tarea.pdf', ruta: 'u-1/t-1/e4.pdf', created_at: '4' },
  ];
  const { page, errores } = await prepararPagina(browser, { conSesion: true });
  await page.waitForSelector('#app:not(.hidden)');
  await page.selectOption('#selGrupo', 'g-1');
  await page.waitForFunction(() => !document.getElementById('selTarea').disabled);
  ok(await page.isHidden('#bandeja'), 'sin tarea elegida no se ve la bandeja');
  await page.selectOption('#selTarea', 't-1');
  await page.waitForFunction(() => document.getElementById('bandejaResumen').textContent.includes('han entregado'));
  const resumen = await page.textContent('#bandejaResumen');
  ok(resumen.includes('2 de 4 alumnos') && resumen.includes('1 sin corregir') && resumen.includes('1 corregidas') && resumen.includes('1 sin identificar'), 'resumen: ' + resumen);
  ok((await page.textContent('#btnCorregirRecibidas')).includes('(1)'), 'el botón dice cuántos faltan por corregir');
  ok(await page.isVisible('#asignar-e4'), 'la entrega sin identificar sale con su selector');
  await page.screenshot({ path: OUT + '6-bandeja.png', fullPage: true });

  // enlace: crea el token y lo enseña con su QR
  await page.click('text=🔗 Enlace para los alumnos');
  await page.waitForSelector('#enlaceInput');
  const enlace = await page.inputValue('#enlaceInput');
  const pt = patches.find(p => p.tabla === 'tareas' && p.b.token_entrega);
  ok(pt && /^[A-Za-z0-9_-]{32}$/.test(pt.b.token_entrega) && pt.b.entrega_abierta === true, 'crea un token aleatorio de 32 caracteres y abre la entrega');
  ok(enlace === `https://app.test/entregar.html#t=${pt?.b.token_entrega}`, 'el enlace apunta a entregar.html con el token en el fragmento (no llega al servidor)');
  await page.waitForSelector('#qrEnlace svg', { timeout: 15000 });
  ok(true, 'muestra el QR del enlace para proyectarlo');
  await page.screenshot({ path: OUT + '7-enlace.png' });
  await page.click('#chkAuto');
  await page.waitForTimeout(300);
  ok(patches.some(p => p.tabla === 'tareas' && p.b.correccion_auto === true && p.b.rubrica === '- Rúbrica guardada (10 pts)'), 'activar la corrección nocturna guarda la rúbrica en la tarea');
  await page.click('#modal .modal-actions >> text=Cerrar');

  // asignar la de correo sin identificar
  await page.selectOption('#asignar-e4', 'a-3');
  await page.click('.sin-identificar-item >> text=Asignar');
  await page.waitForTimeout(300);
  ok(patches.some(p => p.tabla === 'entregas' && p.b.alumno_id === 'a-3' && p.filtro.includes('e4')), 'asigna la entrega al alumno elegido');

  // corregir lo recibido
  page.once('dialog', d => d.accept());
  await page.click('#btnCorregirRecibidas');
  await page.waitForFunction(() => document.getElementById('progressText').textContent.includes('completada'), null, { timeout: 20000 });
  const ce = correcciones.filter(c => c.via === 'entregas');
  ok(ce.length === 2 && ce.every(c => c.tarea_id === 't-1' && c.rubrica && c.curso === '3ESO'), `pide corregir solo a quien tiene algo pendiente: ${ce.map(c => c.alumno_id).join(', ')}`);
  ok(!ce.some(c => c.alumno_id === 'a-2'), 'lo ya corregido por la noche no se vuelve a cobrar');
  const tarjetas = await page.$$eval('.student-card', els => els.map(e => e.textContent));
  ok(tarjetas.some(t => t.includes('Luis') && t.includes('Corregido esta noche')), 'la corrección nocturna aparece para revisar');
  ok(tarjetas.some(t => t.includes('Sara') && t.includes('Todavía no ha entregado')), 'quien no ha entregado aparece como tal');
  ok(await page.isVisible('text=👁 Ver trabajo'), 'las tarjetas de entregas tienen «Ver trabajo»');
  await page.click('.student-card:has-text("Ana") >> text=👁 Ver trabajo');
  await page.waitForSelector('#modal a[href*="token=ver"]');
  ok((await page.$$('#modal a[href*="token=ver"]')).length === 2, 'ver trabajo: un enlace por página');
  await page.click('#modal >> text=Cerrar');
  const idxAna = await page.evaluate(() => cards.findIndex(c => c.alumno.nombre.startsWith('Ana')));
  await page.click(`#aprobarBtn-${idxAna}`);
  await page.waitForTimeout(500);
  ok(patches.some(p => p.tabla === 'entregas' && p.b.estado === 'aprobada' && p.filtro.includes('e1') && p.filtro.includes('e2')), 'al aprobar, sus entregas quedan cerradas');
  ok(borrados.includes('u-1/t-1/e1.jpg') && borrados.includes('u-1/t-1/e2.jpg'), 'y sus archivos se borran del almacén');
  await page.screenshot({ path: OUT + '8-recibidas.png', fullPage: true });
  ok(errores.length === 0, 'sin errores de JS' + (errores.length ? ': ' + errores.join(' | ') : ''));
}

console.log('== Escaneo de libretas con pegatinas QR ==');
{
  correcciones.length = 0; creditosApi = 10; db.entregas = [];
  // PDF de 4 páginas generado con el propio Chromium: QR de Ana, página suelta, QR de Marta, QR ajeno
  const gen = await (await browser.newContext()).newPage();
  await gen.setContent('<html><body></body></html>');
  await gen.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js' });
  await gen.evaluate(() => {
    const qr = (t) => { const q = qrcode(0, 'M'); q.addData(t); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };
    const pag = (cont) => `<div style="box-sizing:border-box;height:250mm;page-break-after:always;padding:15mm;font:20px serif">${cont}</div>`;
    document.body.innerHTML =
      pag(`<div style="width:35mm">${qr('LV1:a-1')}</div><p>Ana: página 1 de la libreta</p>`) +
      pag('<p>Ana: página 2, sin pegatina</p>') +
      pag(`<div style="width:35mm">${qr('LV1:a-3')}</div><p>Marta: su página</p>`) +
      pag(`<div style="width:35mm">${qr('https://otra-cosa.example')}</div><p>Un QR que no es de Lápiz Verde</p>`);
  });
  fs.writeFileSync(OUT + 'escaneo.pdf', await gen.pdf({ format: 'A4' }));
  ok((fs.readFileSync(OUT + 'escaneo.pdf').toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length === 4, 'PDF de prueba de 4 páginas');

  const { page, errores } = await prepararPagina(browser, { conSesion: true });
  await page.waitForSelector('#app:not(.hidden)');
  await page.selectOption('#selGrupo', 'g-1');
  await page.waitForFunction(() => !document.getElementById('selTarea').disabled);
  await page.selectOption('#selTarea', 't-1');
  await page.setInputFiles('#escaneoFile', OUT + 'escaneo.pdf');
  page.once('dialog', d => d.accept());
  await page.click('#btnCorregir');
  await page.waitForFunction(() => document.getElementById('progressText').textContent.includes('completada'), null, { timeout: 60000 });
  const corregidos = await page.evaluate(() => cards.filter(c => c.result).map(c => c.alumno.nombre.split(' ')[0]).sort().join(','));
  const paginas = correcciones.map(c => c.archivos.length).sort().join(',');
  ok(corregidos === 'Ana,Marta' && correcciones.length === 2, `solo se corrige a Ana y Marta (${corregidos})`);
  ok(paginas === '1,2' && correcciones.every(c => c.archivos.every(a => a.tipo === 'jpeg')), 'Ana: su pegatina y la página siguiente (2 páginas); Marta: 1 página');
  ok((await page.textContent('#statsBar')).includes('2 sin entrega'), 'Luis y Sara salen como sin entrega');
  await page.screenshot({ path: OUT + '9-escaneo.png', fullPage: true });
  ok(errores.length === 0, 'sin errores de JS' + (errores.length ? ': ' + errores.join(' | ') : ''));
}

console.log('== Cuaderno: pegatinas QR y buzón ==');
{
  patches.length = 0;
  const { page, ctx, errores } = await prepararPagina(browser, { conSesion: true });
  await page.waitForSelector('#app:not(.hidden)');
  await page.click('.tab-btn[data-tab="cuaderno"]');
  await page.click('.grupo-card');
  await page.waitForSelector('.notas-table');
  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('text=🏷️ Pegatinas QR')]);
  await popup.waitForSelector('.pegatina svg', { timeout: 15000 });
  ok((await popup.$$('.pegatina svg')).length === 4, 'una pegatina con QR por alumno');
  ok((await popup.textContent('.hoja')).includes('Ana López García'), 'con el nombre completo');
  await popup.screenshot({ path: OUT + '10-pegatinas.png', fullPage: true });
  await popup.close();

  ok(await page.isHidden('#btnBuzon'), 'el buzón no se ofrece hasta tener un dominio neutro');
  ok(errores.length === 0, 'sin errores de JS' + (errores.length ? ': ' + errores.join(' | ') : ''));
}

console.log('== Página del alumno (entregar.html) ==');
{
  llamadasEntregas.length = 0; subidas.length = 0;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', e => errores.push(e.message));
  await ctx.route('**/*', (route) => prepararRuta(route));
  await page.goto('https://app.test/entregar.html#t=' + 'T'.repeat(32));
  await page.waitForSelector('#formulario:not(.hidden)');
  ok((await page.textContent('#titulo')) === 'Libreta semana 12', 'muestra la tarea');
  ok((await page.textContent('#grupo')) === 'Entrega para 3.º ESO A · Bruno', 'con el grupo y el nombre del profe');
  const texto = (await page.innerText('body')) + ' ' + await page.title();   // solo lo que se ve
  ok(!/lápiz verde|\bIA\b|inteligencia artificial/i.test(texto),
    'la página del alumno no menciona la marca ni la IA');
  ok((await page.$$eval('#alumno option', o => o.length)) === 3, 'lista los alumnos para elegir');
  ok(await page.isDisabled('#enviar'), 'sin nombre ni archivo no se puede entregar');
  await page.selectOption('#alumno', 'a-1');
  await page.setInputFiles('#archivos', [OUT + 'foto-grande.png', OUT + 'foto-grande.png']);
  ok((await page.textContent('#enviar')) === 'Entregar 2 archivos', 'dos fotos elegidas');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'en móvil no hay scroll horizontal');
  await page.screenshot({ path: OUT + '12-alumno.png', fullPage: true });
  await page.click('#enviar');
  await page.waitForSelector('#hecho:not(.hidden)', { timeout: 15000 });
  const prep = llamadasEntregas.find(l => l.accion === 'preparar');
  ok(prep.alumno_id === 'a-1' && prep.archivos.length === 2 && prep.archivos.every(a => a.mime === 'image/jpeg' && a.bytes < 600000), 'las fotos se reducen a JPEG antes de subir');
  ok(subidas.length === 2 && subidas.every(s => s.metodo === 'PUT' && s.tipo.includes('multipart/form-data')), 'sube cada foto a su URL firmada');
  ok(llamadasEntregas.some(l => l.accion === 'confirmar' && l.ids.length === 2), 'confirma la entrega al terminar');
  ok(!subidas.some(s => s.url.includes('T'.repeat(32))) && llamadasEntregas.every(l => l.t), 'el token viaja en el cuerpo, nunca en la URL');
  ok((await page.textContent('#hechoTexto')).includes('2 archivos'), 'pantalla de «¡Entregado!»');
  await page.screenshot({ path: OUT + '13-alumno-hecho.png', fullPage: true });
  await page.goto('about:blank');   // cambiar solo el fragmento no recarga la página
  await page.goto('https://app.test/entregar.html#t=malo');
  await page.waitForSelector('#fallo:not(.hidden)');
  ok((await page.textContent('#falloTexto')).includes('no es válido'), 'enlace malo → mensaje claro');
  ok(errores.length === 0, 'sin errores de JS' + (errores.length ? ': ' + errores.join(' | ') : ''));
}

console.log('== Pasar notas: hoja de Moodle, extensión y copiar ==');
{
  db.notas = [
    { alumno_id: 'a-1', tarea_id: 't-1', nota: 9.2, faltas: null, origen: 'markmate', comentario_ia: 'Muy buen <comentario>.', mejoras_ia: 'uno\ndos', mensaje_motivador: '¡Sigue así!' },
    { alumno_id: 'a-2', tarea_id: 't-1', nota: 4.6, faltas: null, origen: 'manual' },
  ];
  const { page, ctx, errores } = await prepararPagina(browser, { conSesion: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://app.test' });
  // La extensión en la página: su puente con un chrome.storage de mentira
  await page.evaluate(() => { window.__guardado = null; window.chrome = { runtime: { getManifest: () => ({ version: '1.0.0' }) }, storage: { local: { get: async () => ({}), remove: async () => {}, set: async (o) => { window.__guardado = o; } } } }; });
  await page.addScriptTag({ path: REPO + 'extension/puente.js' });
  await page.waitForSelector('#app:not(.hidden)');
  await page.click('.tab-btn[data-tab="cuaderno"]');
  await page.waitForSelector('.grupo-card');
  await page.click('.grupo-card');
  await page.waitForSelector('.notas-table');
  await page.click('text=📤 Pasar notas');
  await page.waitForSelector('#pnQue');
  ok((await page.$$eval('#pnQue option', o => o.map(x => x.textContent))).join('|') === 'Comentario tema 3|Media de la 1.ª evaluación|Media de todas las tareas', 'elige tarea, media de la evaluación o media total');
  await page.waitForFunction(() => document.getElementById('pnExtTexto').textContent.includes('está instalada'));
  ok(true, 'detecta que la extensión está instalada');

  // Hoja de calificaciones de Aules
  const hoja = '﻿"Identificador","Nombre completo","Dirección de correo","Estado","Calificación","Calificación máxima","Última modificación (calificación)","Comentarios de retroalimentación"\n' +
    '"Participante 1","Ana López García","ana@x.es","Enviado","","100,00","-",""\n' +
    '"Participante 2","Luis Pérez","","Enviado","","100,00","-",""\n' +
    '"Participante 3","Marta Ruiz","","Sin entrega","","100,00","-",""\n' +
    '"Participante 4","Alguien Nuevo","","Sin entrega","","100,00","-",""\n';
  const descarga = page.waitForEvent('download');
  await page.setInputFiles('#pnHoja', { name: 'calificaciones-tarea.csv', mimeType: 'text/csv', buffer: Buffer.from(hoja) });
  const d = await descarga;
  const csv = fs.readFileSync(await d.path(), 'utf8');
  ok(d.suggestedFilename() === 'calificaciones-tarea (rellena).csv', 'descarga la hoja rellena con su nombre');
  ok(csv.includes('"Participante 1","Ana López García","ana@x.es","Enviado","92,00","100,00","-","<p>Muy buen &lt;comentario&gt;.</p><p>Para mejorar:<br>1. uno<br>2. dos</p><p>¡Sigue así!</p><p>Bruno</p>"'), 'Ana: 9,2 → 92,00 sobre 100, con comentario escapado y firma');
  ok(csv.includes('"Participante 2","Luis Pérez","","Enviado","46,00"'), 'Luis: nota manual, sin comentario');
  const resultado = await page.textContent('#pnResultado');
  ok(resultado.includes('2 notas puestas') && resultado.includes('Marta Ruiz') && resultado.includes('Alguien Nuevo'), 'resume lo puesto, lo que va sin nota y lo que no está');

  await page.setInputFiles('#pnHoja', { name: 'otra.csv', mimeType: 'text/csv', buffer: Buffer.from('Nombre;Nota\nAna;7\n') });
  await page.waitForFunction(() => document.getElementById('pnResultado').textContent.includes('No parece'));
  ok(true, 'un CSV que no es de Moodle → explica cómo descargar la hoja');

  // Enviar a la extensión
  await page.click('text=Enviar a la extensión');
  await page.waitForFunction(() => window.__guardado);
  const g = await page.evaluate(() => window.__guardado.notas);
  ok(g.titulo === 'Comentario tema 3' && g.grupo === '3.º ESO A' && g.alumnos.length === 4, 'la extensión recibe la tarea y los 4 alumnos');
  ok(g.alumnos[0].nota === 9.2 && g.alumnos[0].comentario.startsWith('Muy buen') && g.alumnos[2].nota === null, 'con nota y comentario; sin nota quien no la tiene');
  ok(g.alumnos.every(a => !('email' in a) && !('id' in a)), 'a la extensión solo van nombre, nota y comentario');
  await page.waitForSelector('.toast.show');
  ok((await page.textContent('#toast')).includes('enviadas a la extensión'), 'confirma el envío');

  // Media de la evaluación y copiar
  await page.selectOption('#pnQue', 'e:1');
  await page.click('text=📋 Copiar notas');
  await page.waitForTimeout(300);
  const copiado = await page.evaluate(() => navigator.clipboard.readText());
  ok(copiado.split('\n')[0] === 'López García, Ana\t9,2' && copiado.includes('Pérez, Luis\t4,6') && copiado.includes('Ruiz, Marta\t'), 'copia la media con coma, en columnas');

  // Descargar la extensión
  const descargaExt = page.waitForEvent('download');
  await page.click('text=⬇️ Descargar la extensión');
  const de = await descargaExt;
  const zipExt = await JSZip.loadAsync(fs.readFileSync(await de.path()));
  const enZip = Object.keys(zipExt.files).filter(f => !zipExt.files[f].dir).sort();
  ok(de.suggestedFilename() === 'pasar-notas.zip' && enZip.join() === ['LEEME.txt', 'fondo.js', 'manifest.json', 'popup.html', 'popup.js', 'puente.js', 'rellenar.js'].map(f => 'pasar-notas/' + f).sort().join(), 'descarga la extensión completa en un ZIP');
  const manifest = JSON.parse(await zipExt.file('pasar-notas/manifest.json').async('string'));
  ok(manifest.manifest_version === 3 && !manifest.host_permissions && manifest.permissions.join() === 'storage,activeTab,scripting,alarms', 'la extensión no pide acceso a todas las webs');
  ok(manifest.content_scripts[0].exclude_matches.some(m => m.includes('entregar')), 'el puente no se carga en la página pública de los alumnos');
  const enManifest = [manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts[0].js];
  ok(enManifest.every(f => enZip.includes('pasar-notas/' + f)), 'el ZIP lleva todos los archivos que pide el manifest');
  await page.screenshot({ path: OUT + '14-pasar-notas.png', fullPage: true });
  ok(errores.length === 0, 'sin errores de JS' + (errores.length ? ': ' + errores.join(' | ') : ''));
}

console.log('== ZIP descargado de Drive (Classroom) o de OneDrive (Teams) ==');
{
  const { page, errores } = await prepararPagina(browser, { conSesion: true });
  await page.waitForSelector('#app:not(.hidden)');
  const r = await page.evaluate(() => {
    const drive = ['Comentario tema 3/Ana López García - Comentario tema 3.pdf', 'Comentario tema 3/IMG_2041.jpg', 'Comentario tema 3/Luis Pérez - foto 1.jpg', 'Comentario tema 3/Luis Pérez - foto 2.jpg'];
    const onedrive = ['Student Work/Submitted files/López García, Ana/Comentario tema 3/trabajo.pdf', 'Student Work/Submitted files/Pérez, Luis/Comentario tema 3/foto.png'];
    return {
      ana: buscarArchivosAlumno(drive, 'Ana López García'), luis: buscarArchivosAlumno(drive, 'Luis Pérez'),
      anaOne: buscarArchivosAlumno(onedrive, 'Ana López García'), luisOne: buscarArchivosAlumno(onedrive, 'Luis Pérez'),
    };
  });
  ok(r.ana.length === 1 && r.luis.length === 2, 'Drive (Classroom): archivos con el nombre del alumno, incluidas varias fotos');
  ok(r.anaOne.length === 1 && r.luisOne.length === 1, 'OneDrive (Teams): carpeta «Apellidos, Nombre»');
  ok(errores.length === 0, 'sin errores de JS');
}

console.log('== Extensión: rellenar páginas de calificaciones ==');
{
  const datos = { alumnos: [
    { nombre: 'Ana', apellidos: 'López García', nota: 9.2, comentario: 'Muy bien, Ana' },
    { nombre: 'Luis', apellidos: 'Pérez', nota: 4.6, comentario: 'Repasa' },
    { nombre: 'Marta', apellidos: 'Ruiz', nota: null, comentario: '' },
    { nombre: 'Ana', apellidos: 'López', nota: 6, comentario: '' },
  ] };
  const page = await browser.newPage();
  const rellenar = async (html, op) => {
    await page.setContent(html);
    await page.addScriptTag({ path: REPO + 'extension/rellenar.js' });
    return page.evaluate(([d, o]) => globalThis.__pasarNotas(d, o), [datos, op]);
  };
  const valores = () => page.$$eval('input:not([type=checkbox]), select, textarea', els => els.map(e => e.value));

  // Aules (Moodle): calificación rápida, sobre 100, con filtro de búsqueda y casilla de comentarios
  let r = await rellenar(`
    <form><input type="search" placeholder="Buscar"><select name="perpage"><option>10</option><option>100</option></select>
    <table><tr><th>Nombre</th><th>Calificación</th><th>Comentarios</th></tr>
    <tr><td><input type="checkbox"></td><td><a>Ana López García</a><br>ana@x.es</td><td><input type="text" id="quickgrade_11" value=""> / 100,00</td><td><textarea id="quickgrade_comments_11"></textarea></td></tr>
    <tr><td><input type="checkbox"></td><td><a>Luis Pérez Martín</a></td><td><input type="text" id="quickgrade_12" value=""> / 100,00</td><td><textarea id="quickgrade_comments_12"></textarea></td></tr>
    <tr><td><input type="checkbox"></td><td><a>Marta Ruiz</a></td><td><input type="text" id="quickgrade_13" value=""> / 100,00</td><td><textarea id="quickgrade_comments_13"></textarea></td></tr>
    <tr><td><input type="checkbox"></td><td><a>Ana López</a></td><td><input type="text" id="quickgrade_14" value=""> / 100,00</td><td><textarea id="quickgrade_comments_14"></textarea></td></tr>
    </table></form>`, { comentarios: true, coma: true });
  let v = await valores();
  ok(v.join('|') === '|10|92|Muy bien, Ana|46|Repasa|||60|', 'Aules: notas sobre 100 y comentarios en su fila (filtros intactos): ' + v.join('|'));
  ok(r.hechos.length === 3 && r.comentarios === 2, '3 notas y 2 comentarios; Marta sin nota se queda en blanco');
  ok(await page.$eval('#quickgrade_11', e => e.style.outline.includes('3px')), 'marca en verde lo que ha rellenado');

  // Classroom: filas hechas con div, nota sobre 10 con decimales y coma; un campo de React
  r = await rellenar(`
    <div role="list">
      <div role="listitem"><div><span>Ana López García</span></div><div><input aria-label="Nota" type="text"><span>/10</span></div></div>
      <div role="listitem"><div><span>Luis Pérez</span></div><div><input aria-label="Nota" type="text"><span>/10</span></div></div>
    </div>
    <script>window.cambios = 0; document.querySelectorAll('input').forEach(i => i.addEventListener('input', () => window.cambios++));</script>`, { coma: true });
  v = await valores();
  ok(v.join('|') === '9,2|4,6', 'Classroom: nota con coma en cada fila');
  ok(await page.evaluate(() => window.cambios) === 2, 'lanza los eventos que esperan las webs modernas');

  // ITACA/Séneca: APELLIDOS, NOMBRE en mayúsculas y desplegables de notas enteras
  r = await rellenar(`
    <table>
      <tr><td>LÓPEZ GARCÍA, ANA</td><td><select><option value="">-</option>${[1,2,3,4,5,6,7,8,9,10].map(n => `<option value="${n}">${n}</option>`).join('')}</select></td></tr>
      <tr><td>PÉREZ, LUIS</td><td><select><option value="">-</option><option value="IN">Insuficiente</option><option value="SU">Suficiente</option><option value="NT">Notable</option></select></td></tr>
    </table>`, { entero: true });
  v = await valores();
  ok(v.join('|') === '9|IN', 'ITACA: 9,2 → 9 y 4,6 → Insuficiente (nadie aprueba por redondeo)');

  r = await rellenar(`<table><tr><td>Luis Pérez</td><td><input type="text"></td></tr></table>`, { entero: true });
  ok((await valores()).join() === '4', 'redondear a entero: 4,6 → 4, no 5');

  // Seguridad: una casilla que no está en la fila de un único alumno no se toca
  r = await rellenar(`<div>Ana López García · Luis Pérez · Marta Ruiz <input type="text" id="global"></div>`, {});
  ok((await valores()).join() === '' && r.hechos.length === 0, 'una casilla común a varios alumnos no se rellena');
  r = await rellenar(`<table><tbody>
      <tr><td>Pedro Gil</td><td><input type="text" id="pedro"></td></tr>
      <tr><td>Luis Pérez</td><td><input type="text" id="luis"></td></tr>
      <tr><td>Carmen Sanz</td><td><input type="text" id="carmen"></td></tr></tbody></table>`, {});
  ok((await valores()).join('|') === '|4.6|', 'en una tabla con alumnos ajenos solo se rellena la fila del nuestro');
  r = await rellenar(`<div><div>Luis Pérez</div><div><input type="text" id="a"></div><div><input type="text" id="b"></div></div>`, {});
  ok((await valores()).join('|') === '|', 'sin filas claras, un bloque con dos casillas no se rellena');
  r = await rellenar(`<table><tr><td>Ana López Pérez</td><td><input type="text"></td></tr><tr><td>Ana López García</td><td><input type="text"></td></tr></table>`, {});
  ok((await valores()).join('|') === '6|9.2', 'Ana López García recibe su nota en su fila; la otra fila es de Ana López (que también está en el cuaderno)');
  r = await rellenar(`<table><tr><td>Luis Pérez</td><td><input type="text"></td><td><input type="text"></td></tr></table>`, {});
  ok((await valores()).join('|') === '|' && r.ambiguos > 0, 'una fila con una casilla por tarea no se rellena (no se sabe cuál es)');
  r = await rellenar(`<ul><li><div>Ana López García <input type="text"></div><div>Ana López <input type="text"></div></li></ul>`, {});
  ok((await valores()).join('|') === '9.2|6', 'toda la lista en un solo elemento: cada casilla con el nombre de su bloque');
  r = await rellenar(`<ul><li><span>Ana López García</span> <span>Ana López</span> <input type="text"> <input type="text"></li></ul>`, {});
  ok((await valores()).join('|') === '|', 'nombres y casillas sin agrupar: no se cruzan notas');
  r = await rellenar(`<table><tr><td>Pedro Gil</td><td><input type="text"></td></tr></table>`, {});
  ok(r.hechos.length === 0, 'una página sin nuestros alumnos no se toca');
  await page.close();
}

await browser.close();
console.log(fails ? `\n${fails} FALLOS` : '\nTodo correcto');
process.exit(fails ? 1 : 0);
