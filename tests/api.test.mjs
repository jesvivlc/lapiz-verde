// Prueba los endpoints de /api con la red simulada (Supabase, Anthropic, Stripe, Resend).
// Ejecutar: npm test
import { Readable } from 'node:stream';
import Stripe from 'stripe';

process.env.ANTHROPIC_API_KEY = 'test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  FAIL') + ' ' + m); if (!c) fails++; };

// ── Red simulada ──
// Supabase: un PostgREST mínimo en memoria (tablas + filtros eq/in/gte/is) y un almacén de archivos.
let estado, tablas, almacen;
const U1 = 'user-1';
const G1 = '10000000-0000-4000-8000-000000000001', T1 = '20000000-0000-4000-8000-000000000001';
const A1 = '30000000-0000-4000-8000-000000000001', A2 = '30000000-0000-4000-8000-000000000002', AX = '30000000-0000-4000-8000-0000000000ff';
const TOKEN = 'tok_' + 'x'.repeat(36);
function reiniciar() {
  estado = { creditos: 5, llamadas: [], anthropicStatus: 200, anthropicBody: null, resend: 0 };
  tablas = {
    perfiles: [{ id: U1, nombre: 'Bruno' }],
    grupos: [{ id: G1, owner_id: U1, nombre: '3.º ESO A' }],
    tareas: [{ id: T1, owner_id: U1, grupo_id: G1, titulo: 'Libreta semana 12', token_entrega: TOKEN, entrega_abierta: true }],
    alumnos: [
      { id: 'a-1', owner_id: U1, grupo_id: 'g-x', nombre: 'Ana', email: 'ana@alumnos.es', activo: true },
      { id: A1, owner_id: U1, grupo_id: G1, nombre: 'Ana', apellidos: 'López García', activo: true },
      { id: A2, owner_id: U1, grupo_id: G1, nombre: 'Ana', apellidos: 'Lucas', activo: true },
      { id: AX, owner_id: 'otro', grupo_id: 'g-otro', nombre: 'Intruso', activo: true },
    ],
    entregas: [],
    uso_ia: [],
  };
  almacen = new Map();
}
const respuestaIA = { nota: 7.5, nota_texto: 'Notable', comentario: 'Bien', propuestas_mejora: ['a', 'b', 'c'], mensaje_motivador: '¡Ánimo!', legible: true };

function filtrar(filas, params) {
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k)) continue;
    const [op, ...resto] = v.split('.');
    const val = resto.join('.');
    filas = filas.filter((f) => {
      const x = f[k];
      if (op === 'eq') return String(x) === val;
      if (op === 'gte') return String(x) >= val;
      if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')).includes(String(x));
      if (op === 'is') return x == null;
      if (op === 'not') return x != null;   // solo se usa not.is.null
      return true;
    });
  }
  const orden = params.get('order');
  if (orden) {
    const [col, dir] = orden.split(',')[0].split('.');
    filas = [...filas].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (dir === 'desc' ? -1 : 1));
  }
  if (params.get('limit')) filas = filas.slice(0, Number(params.get('limit')));
  return filas;
}

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const metodo = init.method || 'GET';
  const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  estado.llamadas.push({ url, body, metodo });
  const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
  const u = new URL(url);
  if (u.pathname === '/auth/v1/user') {
    const auth = new Headers(init.headers).get('authorization');
    return auth === 'Bearer buen-token' ? json({ id: U1, email: 'profe@x.es', aud: 'authenticated' }) : json({ msg: 'bad jwt' }, 401);
  }
  if (u.pathname.endsWith('/rpc/consumir_credito')) {
    if (estado.creditos <= 0) return json(null);
    estado.creditos--; return json(estado.creditos);
  }
  if (u.pathname.endsWith('/rpc/devolver_credito')) { estado.creditos++; return json(null); }
  if (u.pathname.endsWith('/rpc/acreditar_pago')) { estado.pago = body; return json(true); }
  if (u.pathname.startsWith('/rest/v1/')) {
    const tabla = u.pathname.slice('/rest/v1/'.length);
    tablas[tabla] ??= [];
    if (metodo === 'POST') {
      const nuevas = (Array.isArray(body) ? body : [body]).map((f) => ({ created_at: new Date().toISOString(), ...f }));
      tablas[tabla].push(...nuevas);
      return json(nuevas, 201);
    }
    const filas = filtrar(tablas[tabla], u.searchParams);
    if (metodo === 'PATCH') { filas.forEach((f) => Object.assign(f, body)); return json(filas); }
    if (metodo === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `*/${filas.length}` } });
    return json(filas);
  }
  if (u.pathname.startsWith('/storage/v1/object/upload/sign/entregas/')) {
    const ruta = decodeURIComponent(u.pathname.slice('/storage/v1/object/upload/sign/entregas/'.length));
    return json({ url: `/object/upload/sign/entregas/${ruta}?token=firma-${ruta.length}` });
  }
  if (u.pathname === '/storage/v1/object/list/entregas') {
    const nombres = [...almacen.keys()].filter((k) => k.startsWith(body.prefix + '/')).map((k) => k.slice(body.prefix.length + 1));
    return json(nombres.filter((n) => !body.search || n.includes(body.search)).map((name) => ({ name })));
  }
  if (u.pathname.startsWith('/storage/v1/object/entregas/')) {
    const ruta = decodeURIComponent(u.pathname.slice('/storage/v1/object/entregas/'.length));
    return almacen.has(ruta) ? new Response(almacen.get(ruta)) : json({ error: 'not found' }, 400);
  }
  if (url.includes('api.anthropic.com')) {
    estado.anthropicBody = body;
    if (estado.anthropicStatus !== 200) return json({ type: 'error', error: { type: 'invalid_request_error', message: 'mal' } }, estado.anthropicStatus);
    return json({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: JSON.stringify(respuestaIA) }],
      usage: { input_tokens: 3000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  }
  if (url.includes('api.resend.com')) { estado.resend++; estado.resendBody = body; return json({ id: 'e1' }); }
  throw new Error('URL no simulada: ' + url);
};

function peticion({ metodo = 'POST', token = 'buen-token', body = {}, headers = {}, query = {} } = {}) {
  return { method: metodo, query, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), host: 'localhost', ...headers }, body };
}
function respuesta() {
  const r = { statusCode: 200, cuerpo: null, headers: {} };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (j) => { r.cuerpo = j; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
const base = { nombre_alumno: 'Ana López', curso: '3ESO', nombre_tarea: 'Comentario', rubrica: '- Contenido (10 pts)' };

const { default: corregir } = await import('../api/corregir.js');

console.log('== /api/corregir ==');
reiniciar(); let res = respuesta();
await corregir(peticion({ token: null, body: { ...base, texto_tarea: 'hola' } }), res);
ok(res.statusCode === 401, 'sin sesión → 401');

reiniciar(); res = respuesta();
await corregir(peticion({ token: 'malo', body: { ...base, texto_tarea: 'hola' } }), res);
ok(res.statusCode === 401, 'token inválido → 401');

reiniciar(); res = respuesta();
await corregir(peticion({ body: { ...base, texto_tarea: 'Mi redacción' } }), res);
ok(res.statusCode === 200 && res.cuerpo.nota === 7.5, 'corrección de texto → 200 con nota');
ok(res.cuerpo.creditos_restantes === 4 && estado.creditos === 4, 'consume 1 crédito y lo devuelve en la respuesta');
const b = estado.anthropicBody;
ok(b.model === 'claude-sonnet-5', 'usa claude-sonnet-5');
ok(b.max_tokens === 16000, 'max_tokens 16000');
ok(b.messages[0].content[0].cache_control?.type === 'ephemeral' && b.messages[0].content[0].text.includes('Rúbrica'), 'rúbrica primero y cacheada');
ok(!b.messages[0].content[0].text.includes('Ana López'), 'el nombre del alumno no rompe el prefijo cacheado');
ok(tablas.uso_ia.some((u) => u.input_tokens === 3000), 'registra el uso de tokens');

reiniciar(); res = respuesta();
await corregir(peticion({ body: { ...base, archivo_base64: 'AAAA', tipo_archivo: 'jpg' } }), res);
ok(res.statusCode === 200 && estado.anthropicBody.messages[0].content[2].source.media_type === 'image/jpeg', 'imagen JPG → image/jpeg');

reiniciar(); res = respuesta();
await corregir(peticion({ body: { ...base, archivo_base64: 'AAAA', tipo_archivo: 'imagen' } }), res);
ok(res.statusCode === 400 && estado.creditos === 5, "tipo 'imagen' (el bug antiguo) → 400 sin cobrar");

reiniciar(); res = respuesta();
await corregir(peticion({ body: { ...base, curso: '4PRI', texto_tarea: 'x' } }), res);
ok(res.statusCode === 200, 'acepta cursos de primaria');

reiniciar(); estado.creditos = 0; res = respuesta();
await corregir(peticion({ body: { ...base, texto_tarea: 'x' } }), res);
ok(res.statusCode === 402 && res.cuerpo.codigo === 'SIN_CREDITOS' && !estado.anthropicBody, 'sin créditos → 402 y no llama a la IA');

reiniciar(); res = respuesta();
await corregir(peticion({ body: { ...base, rubrica: 'x'.repeat(6001), texto_tarea: 'x' } }), res);
ok(res.statusCode === 400 && estado.creditos === 5 && !estado.anthropicBody, 'rúbrica enorme → 400 sin cobrar ni llamar a la IA');

reiniciar(); estado.anthropicStatus = 400; res = respuesta();
await corregir(peticion({ body: { ...base, texto_tarea: 'x' } }), res);
ok(res.statusCode === 400 && estado.creditos === 5, 'si la IA falla, devuelve el crédito');

console.log('== /api/stripe-webhook ==');
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
const { default: webhook } = await import('../api/stripe-webhook.js');
const stripe = new Stripe('sk_test_x');
function eventoFirmado(obj, secreto = 'whsec_test') {
  const payload = JSON.stringify(obj);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: secreto });
  const req = Readable.from([Buffer.from(payload)]);
  req.method = 'POST'; req.headers = { 'stripe-signature': header };
  return req;
}
const evento = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_123', payment_status: 'paid', amount_total: 900, metadata: { user_id: 'user-1', creditos: '100' } } } };
reiniciar(); res = respuesta();
await webhook(eventoFirmado(evento), res);
ok(res.statusCode === 200 && estado.pago?.p_session === 'cs_123' && estado.pago.p_creditos === 100 && estado.pago.p_user === U1, 'pago firmado → acredita 100 créditos');
reiniciar(); res = respuesta();
await webhook(eventoFirmado(evento, 'whsec_otro'), res);
ok(res.statusCode === 400 && !estado.pago, 'firma falsa → 400 y no acredita');

console.log('== /api/enviar-feedback ==');
const { default: enviar } = await import('../api/enviar-feedback.js');
reiniciar(); res = respuesta();
await enviar(peticion({ body: { alumno_id: 'a-1', tarea: 'T', resultado: respuestaIA } }), res);
ok(res.statusCode === 503 && res.cuerpo.codigo === 'EMAIL_SIN_CONFIGURAR', 'sin Resend configurado → aviso claro');
process.env.RESEND_API_KEY = 're_x'; process.env.FROM_EMAIL = 'feedback@dominio.es';
reiniciar(); res = respuesta();
await enviar(peticion({ body: { alumno_id: 'a-1', tarea: 'T', resultado: respuestaIA, para: 'victima@x.es', firma: 'Secretaría' } }), res);
ok(res.statusCode === 200 && estado.resendBody.to === 'ana@alumnos.es' && estado.resendBody.reply_to === 'profe@x.es' && estado.resendBody.from === 'Bruno <feedback@dominio.es>',
  'envía al correo del alumno guardado y con la firma del perfil (ignora "para" y "firma" de la petición)');
reiniciar(); res = respuesta();
await enviar(peticion({ body: { alumno_id: 'alumno-de-otro', tarea: 'T', resultado: respuestaIA } }), res);
ok(res.statusCode === 404 && estado.resend === 0, 'alumno de otro profesor → 404 y no envía');
reiniciar(); res = respuesta();
await enviar(peticion({ body: { alumno_id: 'a-1', tarea: 'T', resultado: { ...respuestaIA, nota: 99 } } }), res);
ok(res.statusCode === 400 && estado.resend === 0, 'nota fuera de rango → 400');

console.log('== /api/checkout ==');
const { default: checkout } = await import('../api/checkout.js');
reiniciar(); res = respuesta();
await checkout(peticion({ token: null, body: { bono: '100' } }), res);
ok(res.statusCode === 401, 'comprar sin sesión → 401');
reiniciar(); res = respuesta();
await checkout(peticion({ body: { bono: '999' } }), res);
ok(res.statusCode === 400, 'bono inexistente → 400');

console.log('== /api/corregir con varias páginas ==');
reiniciar(); res = respuesta();
await corregir(peticion({ body: { ...base, archivos: [{ base64: 'AAAA', tipo: 'jpeg' }, { base64: 'BBBB', tipo: 'jpeg' }, { base64: 'CCCC', tipo: 'pdf' }] } }), res);
const cont = estado.anthropicBody?.messages[0].content ?? [];
ok(res.statusCode === 200 && cont.length === 5 && cont[4].type === 'document' && cont[1].text.includes('3 archivos'), '3 páginas → 3 bloques en orden, 1 sola corrección');
ok(estado.creditos === 4, 'cobra 1 corrección por alumno, no por página');
reiniciar(); res = respuesta();
await corregir(peticion({ body: { ...base, archivos: Array.from({ length: 11 }, () => ({ base64: 'A', tipo: 'jpeg' })) } }), res);
ok(res.statusCode === 400 && estado.creditos === 5, 'más de 10 páginas → 400 sin cobrar');

console.log('== /api/entrega (enlace para alumnos, sin cuenta) ==');
const { default: entrega, etiquetasAlumnos } = await import('../api/entrega.js');
reiniciar(); res = respuesta();
await entrega(peticion({ metodo: 'GET', token: null, query: { t: TOKEN } }), res);
ok(res.statusCode === 200 && res.cuerpo.tarea.titulo === 'Libreta semana 12' && res.cuerpo.alumnos.length === 2, 'con el enlace: tarea y alumnos SOLO de ese grupo');
ok(JSON.stringify(res.cuerpo).indexOf('López García') === -1 && !JSON.stringify(res.cuerpo).includes('email'), 'no expone apellidos completos ni correos');
ok(etiquetasAlumnos([{ id: 1, nombre: 'Ana', apellidos: 'López' }, { id: 2, nombre: 'Ana', apellidos: 'Lucas' }, { id: 3, nombre: 'Leo', apellidos: 'Gil' }])
  .map((a) => a.etiqueta).join('|') === 'Ana López|Ana Lucas|Leo G.', 'dos «Ana L.» → se distinguen por el primer apellido');
reiniciar(); res = respuesta();
await entrega(peticion({ metodo: 'GET', token: null, query: { t: 'tok_' + 'y'.repeat(36) } }), res);
ok(res.statusCode === 404, 'token que no existe → 404');
reiniciar(); tablas.tareas[0].entrega_abierta = false; res = respuesta();
await entrega(peticion({ metodo: 'GET', token: null, query: { t: TOKEN } }), res);
ok(res.statusCode === 410, 'entrega cerrada por el profe → 410');

reiniciar(); res = respuesta();
await entrega(peticion({ token: null, body: { accion: 'preparar', t: TOKEN, alumno_id: A1, archivos: [{ nombre: 'p1.jpg', mime: 'image/jpeg', bytes: 300000 }, { nombre: 'p2.pdf', mime: 'application/pdf', bytes: 900000 }] } }), res);
ok(res.statusCode === 200 && res.cuerpo.subidas.length === 2 && res.cuerpo.subidas[0].url.includes('/object/upload/sign/entregas/user-1/'), 'preparar → URLs firmadas en la carpeta del profesor');
ok(tablas.entregas.length === 2 && tablas.entregas.every((e) => e.estado === 'subiendo' && e.owner_id === U1 && e.alumno_id === A1 && e.canal === 'enlace'), 'crea las entregas como «subiendo», del profesor y del alumno');
const ids = res.cuerpo.subidas.map((s) => s.id);
almacen.set(tablas.entregas[0].ruta, Buffer.from('foto'));   // solo llega el primer archivo
res = respuesta();
await entrega(peticion({ token: null, body: { accion: 'confirmar', t: TOKEN, ids } }), res);
ok(res.cuerpo.recibidas === 1 && tablas.entregas[0].estado === 'pendiente' && tablas.entregas[1].estado === 'subiendo', 'confirmar solo da por recibido lo que está en el almacén');

for (const [desc, b, codigo] of [
  ['alumno de otro grupo', { alumno_id: AX, archivos: [{ nombre: 'x.jpg', mime: 'image/jpeg', bytes: 10 }] }, 400],
  ['archivo que no es PDF ni foto', { alumno_id: A1, archivos: [{ nombre: 'virus.exe', mime: 'application/x-msdownload', bytes: 10 }] }, 400],
  ['archivo de más de 15 MB', { alumno_id: A1, archivos: [{ nombre: 'x.pdf', mime: 'application/pdf', bytes: 16 * 1024 * 1024 }] }, 400],
  ['más de 10 archivos', { alumno_id: A1, archivos: Array.from({ length: 11 }, () => ({ nombre: 'x.jpg', mime: 'image/jpeg', bytes: 10 })) }, 400],
]) {
  reiniciar(); res = respuesta();
  await entrega(peticion({ token: null, body: { accion: 'preparar', t: TOKEN, ...b } }), res);
  ok(res.statusCode === codigo && tablas.entregas.length === 0, `${desc} → ${codigo} y no crea nada`);
}
reiniciar(); res = respuesta();
tablas.entregas = Array.from({ length: 29 }, () => ({ tarea_id: T1, alumno_id: A1, estado: 'pendiente', created_at: '2020-01-01' }));
await entrega(peticion({ token: null, body: { accion: 'preparar', t: TOKEN, alumno_id: A1, archivos: [{ nombre: 'a.jpg', mime: 'image/jpeg', bytes: 10 }, { nombre: 'b.jpg', mime: 'image/jpeg', bytes: 10 }] } }), res);
ok(res.statusCode === 429, 'más de 30 archivos por alumno en una tarea → 429');

console.log('== /api/corregir-entregas ==');
const { default: corregirEntregas } = await import('../api/corregir-entregas.js');
function conEntregas() {
  reiniciar();
  tablas.entregas = [
    { id: 'e1', owner_id: U1, tarea_id: T1, alumno_id: A1, ruta: 'user-1/t/e1.jpg', mime: 'image/jpeg', bytes: 4, estado: 'pendiente', created_at: '2026-10-08T08:00:00Z' },
    { id: 'e2', owner_id: U1, tarea_id: T1, alumno_id: A1, ruta: 'user-1/t/e2.pdf', mime: 'application/pdf', bytes: 4, estado: 'pendiente', created_at: '2026-10-08T08:01:00Z' },
    { id: 'e3', owner_id: U1, tarea_id: T1, alumno_id: A1, ruta: 'user-1/t/e3.jpg', mime: 'image/jpeg', bytes: 4, estado: 'descartada', created_at: '2026-10-08T08:02:00Z' },
  ];
  almacen.set('user-1/t/e1.jpg', Buffer.from('foto')); almacen.set('user-1/t/e2.pdf', Buffer.from('%PDF'));
}
const cuerpoCE = { tarea_id: T1, alumno_id: A1, curso: '3ESO', rubrica: '- Contenido (10 pts)' };
conEntregas(); res = respuesta();
await corregirEntregas(peticion({ body: cuerpoCE }), res);
const contCE = estado.anthropicBody?.messages[0].content ?? [];
ok(res.statusCode === 200 && contCE.length === 4 && contCE[2].type === 'image' && contCE[3].type === 'document', 'corrige juntas la foto y el PDF, en orden, sin la descartada');
ok(contCE[1].text.includes('Ana López García') && contCE[0].text.includes('Libreta semana 12'), 'nombre completo del alumno y título de la tarea');
ok(tablas.entregas[0].estado === 'corregida' && tablas.entregas[1].resultado?.nota === 7.5 && tablas.entregas[2].estado === 'descartada', 'guarda la propuesta en las entregas (pendiente de aprobar)');
ok(estado.creditos === 4, 'cobra 1 corrección');
conEntregas(); res = respuesta();
await corregirEntregas(peticion({ body: { ...cuerpoCE, alumno_id: AX } }), res);
ok(res.statusCode === 404 && !estado.anthropicBody && estado.creditos === 5, 'alumno de otro profesor → 404 sin cobrar');
conEntregas(); tablas.tareas[0].owner_id = 'otro'; res = respuesta();
await corregirEntregas(peticion({ body: cuerpoCE }), res);
ok(res.statusCode === 404 && estado.creditos === 5, 'tarea de otro profesor → 404 sin cobrar');
conEntregas(); estado.anthropicStatus = 400; res = respuesta();
await corregirEntregas(peticion({ body: cuerpoCE }), res);
ok(res.statusCode === 400 && estado.creditos === 5 && tablas.entregas[0].estado === 'error', 'si la IA falla: devuelve el crédito y marca las entregas con error');
conEntregas(); res = respuesta();
await corregirEntregas(peticion({ token: null, body: cuerpoCE }), res);
ok(res.statusCode === 401, 'sin sesión → 401');

console.log(fails ? `\n${fails} FALLOS` : '\nTodo correcto');
process.exit(fails ? 1 : 0);
