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
teams.file('Comentario tema 3/Ana López García/Versión 1/trabajo.pdf', pdf);
teams.file('Comentario tema 3/Ana López García/Versión 2/trabajo.pdf', pdf);
teams.file('Comentario tema 3/Luis Pérez/foto.png', png);
teams.file('Comentario tema 3/Marta Ruiz/foto.jpg', png);
teams.file('Otra tarea/Sara Gil/x.pdf', pdf);
fs.writeFileSync(OUT + 'teams.zip', await teams.generateAsync({ type: 'nodebuffer' }));
const moodle = new JSZip();
moodle.file('Ana López_1234_assignsubmission_file_/redaccion.pdf', pdf);
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
const upserts = [], correcciones = [];
let creditosApi = 18;

async function prepararPagina(browser, { conSesion }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errores = [];
  page.on('pageerror', e => errores.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errores.push(m.text()); });

  await page.route('**/*', async (route) => {
    const req = route.request(); const url = new URL(req.url());
    const json = (b, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.host === 'app.test') {
      if (url.pathname === '/' || url.pathname === '/index.html') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(REPO + 'index.html') });
      if (url.pathname === '/api/corregir') {
        const b = req.postDataJSON(); correcciones.push(b);
        if (creditosApi <= 0) return json({ error: 'No te quedan correcciones.', codigo: 'SIN_CREDITOS' }, 402);
        creditosApi--;
        const legible = !b.nombre_alumno.startsWith('Marta');
        return json({ nota: legible ? 7.5 : 3, nota_texto: legible ? 'Notable' : 'Insuficiente', comentario: `Comentario para ${b.nombre_alumno}`, propuestas_mejora: ['uno', 'dos', 'tres'], mensaje_motivador: '¡Sigue así!', legible, creditos_restantes: creditosApi });
      }
      if (url.pathname === '/api/rubrica') return json({ rubrica: '- Propuesta IA (10 pts)' });
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.host.includes('cdn.')) return route.continue();
    if (url.host.includes('supabase.co')) {
      if (url.pathname === '/auth/v1/otp') return json({});
      if (url.pathname === '/auth/v1/user') return json(USER);
      if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });
      const tabla = url.pathname.replace('/rest/v1/', '');
      const m = req.method();
      if (m === 'POST' || m === 'PATCH') {
        const b = req.postDataJSON();
        if (tabla === 'notas') upserts.push(b);
        if (tabla === 'tareas' && m === 'POST') { const t = { id: 't-' + (db.tareas.length + 1), ...b }; db.tareas.unshift(t); return json(t, 201); }
        return json([], 201);
      }
      const eq = (k) => url.searchParams.get(k)?.replace(/^eq\./, '');
      let filas = db[tabla] || [];
      if (tabla === 'perfiles') filas = filas.filter(p => p.id === eq('id'));
      const cabecera = req.headers()['accept'] || '';
      if (cabecera.includes('vnd.pgrst.object')) return json(filas[0] ?? null);
      return json(filas);
    }
    return route.abort();
  });

  if (conSesion) {
    await ctx.addInitScript((user) => {
      localStorage.setItem('sb-fyoyyvzyoohsczceeyde-auth-token', JSON.stringify({
        access_token: 'tok', refresh_token: 'ref', token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, user,
      }));
    }, USER);
  }
  await page.goto('http://app.test/');
  return { page, ctx, errores };
}

const browser = await chromium.launch();

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

  ok(correcciones.length === 3, `3 correcciones enviadas (Sara es de otra tarea): ${correcciones.map(c => c.nombre_alumno).join(', ')}`);
  const ana = correcciones.find(c => c.nombre_alumno.startsWith('Ana'));
  ok(ana?.tipo_archivo === 'pdf', 'PDF de Ana enviado como pdf');
  const luis = correcciones.find(c => c.nombre_alumno.startsWith('Luis'));
  ok(luis?.tipo_archivo === 'jpeg', 'imagen de Luis convertida y enviada como jpeg (antes fallaba)');
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
  ok(correcciones.length === 1 && correcciones[0].nombre_alumno === 'Ana López', 'encuentra a Ana en el ZIP de Moodle (sin nombre de tarea en la ruta)');
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

await browser.close();
console.log(fails ? `\n${fails} FALLOS` : '\nTodo correcto');
process.exit(fails ? 1 : 0);
