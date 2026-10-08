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
    if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict', 'or'].includes(k)) continue;
    const [op, ...resto] = v.split('.');
    const val = resto.join('.');
    filas = filas.filter((f) => {
      const x = f[k];
      if (op === 'eq') return String(x) === val;
      if (op === 'gte') return String(x) >= val;
      if (op === 'lt') return String(x) < val;
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
    const unaFila = (new Headers(init.headers).get('accept') || '').includes('vnd.pgrst.object');
    if (metodo === 'POST') {
      const porDefecto = { lotes_ia: { estado: 'enviado' } }[tabla] ?? {};
      const nuevas = (Array.isArray(body) ? body : [body])
        .map((f) => ({ id: globalThis.crypto.randomUUID(), created_at: new Date().toISOString(), ...porDefecto, ...f }));
      if (tabla === 'correos_procesados' && nuevas.some((n) => tablas[tabla].some((f) => f.correo_id === n.correo_id))) {
        return json({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409);
      }
      tablas[tabla].push(...nuevas);
      return json(unaFila ? nuevas[0] : nuevas, 201);
    }
    const filas = filtrar(tablas[tabla], u.searchParams);
    if (metodo === 'PATCH') { filas.forEach((f) => Object.assign(f, body)); return json(filas); }
    if (metodo === 'DELETE') { tablas[tabla] = tablas[tabla].filter((f) => !filas.includes(f)); return json(filas); }
    if (metodo === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `*/${filas.length}` } });
    return json(filas);
  }
  if (u.pathname.startsWith('/storage/v1/object/upload/sign/entregas/')) {
    const ruta = decodeURIComponent(u.pathname.slice('/storage/v1/object/upload/sign/entregas/'.length));
    return json({ url: `/object/upload/sign/entregas/${ruta}?token=firma-${ruta.length}` });
  }
  if (u.pathname === '/storage/v1/object/list/entregas') {
    const nombres = [...almacen.keys()].filter((k) => k.startsWith(body.prefix + '/')).map((k) => k.slice(body.prefix.length + 1));
    const tipo = (n) => (n.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
    return json(nombres.filter((n) => !body.search || n.includes(body.search))
      .map((name) => ({ name, metadata: { size: almacen.get(`${body.prefix}/${name}`).length, mimetype: tipo(name) } })));
  }
  if (u.pathname.startsWith('/storage/v1/object/entregas/') && metodo === 'POST') {
    almacen.set(decodeURIComponent(u.pathname.slice('/storage/v1/object/entregas/'.length)), init.body);
    return json({ Key: 'entregas/x' });
  }
  if (u.pathname === '/storage/v1/object/entregas' && metodo === 'DELETE') {
    body.prefixes.forEach((r) => almacen.delete(r));
    return json(body.prefixes.map((name) => ({ name })));
  }
  if (u.host === 'api.resend.com' && u.pathname.startsWith('/emails/receiving/')) return json({ object: 'list', data: estado.adjuntos ?? [] });
  if (u.host === 'cdn.resend.test') return new Response(Buffer.alloc(Number(u.searchParams.get('bytes') || 100)));
  if (u.pathname.startsWith('/storage/v1/object/entregas/')) {
    const ruta = decodeURIComponent(u.pathname.slice('/storage/v1/object/entregas/'.length));
    return almacen.has(ruta) ? new Response(almacen.get(ruta)) : json({ error: 'not found' }, 400);
  }
  if (u.host === 'api.anthropic.com' && u.pathname === '/v1/messages/batches' && metodo === 'POST') {
    estado.lote = body;
    return json({ id: 'msgbatch_1', type: 'message_batch', processing_status: 'in_progress' });
  }
  if (u.host === 'api.anthropic.com' && u.pathname === '/v1/messages/batches/msgbatch_1') {
    return json({ id: 'msgbatch_1', type: 'message_batch', processing_status: estado.loteTerminado ? 'ended' : 'in_progress',
      results_url: estado.loteTerminado ? 'https://api.anthropic.com/v1/messages/batches/msgbatch_1/results' : null });
  }
  if (u.host === 'api.anthropic.com' && u.pathname === '/v1/messages/batches/msgbatch_1/results') {
    const lineas = estado.lote.requests.map((r) => JSON.stringify((estado.loteFallos ?? []).includes(r.custom_id)
      ? { custom_id: r.custom_id, result: { type: 'errored', error: { type: 'error', error: { type: 'invalid_request_error', message: 'imagen rota' } } } }
      : { custom_id: r.custom_id, result: { type: 'succeeded', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(respuestaIA) }], usage: { input_tokens: 2000, output_tokens: 400 } } } }));
    return new Response(lineas.join('\n') + '\n', { headers: { 'content-type': 'application/binary' } });
  }
  if (url.includes('api.anthropic.com')) {
    estado.anthropicBody = body;
    if (estado.anthropicStatus !== 200) return json({ type: 'error', error: { type: 'invalid_request_error', message: 'mal' } }, estado.anthropicStatus);
    return json({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: estado.stopReason ?? 'end_turn',
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
reiniciar(); estado.stopReason = 'refusal'; res = respuesta();
await corregir(peticion({ body: { ...base, texto_tarea: 'x' } }), res);
ok(res.statusCode === 422 && estado.creditos === 4 && tablas.uso_ia.some((u) => u.input_tokens === 3000), 'si la IA trabajó pero se negó: no se devuelve (ya está pagada) y se registra el uso');

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
await entrega(peticion({ token: null, body: { accion: 'info', t: TOKEN } }), res);
ok(res.statusCode === 200 && res.cuerpo.tarea.titulo === 'Libreta semana 12' && res.cuerpo.alumnos.length === 2, 'con el enlace: tarea y alumnos SOLO de ese grupo');
ok(res.cuerpo.profesor === 'Bruno', 'incluye la firma del profesor para la página');
ok(JSON.stringify(res.cuerpo).indexOf('López García') === -1 && !JSON.stringify(res.cuerpo).includes('email'), 'no expone apellidos completos ni correos');
ok(etiquetasAlumnos([{ id: 1, nombre: 'Ana', apellidos: 'López' }, { id: 2, nombre: 'Ana', apellidos: 'Lucas' }, { id: 3, nombre: 'Leo', apellidos: 'Gil' }])
  .map((a) => a.etiqueta).join('|') === 'Ana López|Ana Lucas|Leo G.', 'dos «Ana L.» → se distinguen por el primer apellido');
reiniciar(); res = respuesta();
await entrega(peticion({ token: null, body: { accion: 'info', t: 'tok_' + 'y'.repeat(36) } }), res);
ok(res.statusCode === 404, 'token que no existe → 404');
reiniciar(); tablas.tareas[0].entrega_abierta = false; res = respuesta();
await entrega(peticion({ token: null, body: { accion: 'info', t: TOKEN } }), res);
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
ok(tablas.entregas[0].bytes === 4, 'guarda el tamaño REAL del archivo, no el declarado (300000)');
almacen.set(tablas.entregas[1].ruta, Buffer.alloc(16 * 1024 * 1024));   // declaró 900 KB y subió 16 MB
const rutaGrande = tablas.entregas[1].ruta;
res = respuesta();
await entrega(peticion({ token: null, body: { accion: 'confirmar', t: TOKEN, ids } }), res);
ok(res.cuerpo.recibidas === 0 && tablas.entregas.length === 1 && !almacen.has(rutaGrande), 'si lo subido pasa de 15 MB: se rechaza y se borra');

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
reiniciar(); res = respuesta();
tablas.entregas = Array.from({ length: 40 }, (_, i) => ({ tarea_id: T1, alumno_id: A1, estado: i % 2 ? 'descartada' : 'aprobada', created_at: '2020-01-01' }));
await entrega(peticion({ token: null, body: { accion: 'preparar', t: TOKEN, alumno_id: A1, archivos: [{ nombre: 'a.jpg', mime: 'image/jpeg', bytes: 10 }] } }), res);
ok(res.statusCode === 200, 'lo descartado o aprobado no gasta el cupo del alumno');
reiniciar(); res = respuesta();
tablas.entregas = Array.from({ length: 120 }, (_, i) => ({ tarea_id: T1, alumno_id: 'otro-' + i, estado: 'subiendo', created_at: new Date().toISOString() }));
await entrega(peticion({ token: null, body: { accion: 'preparar', t: TOKEN, alumno_id: A1, archivos: [{ nombre: 'a.jpg', mime: 'image/jpeg', bytes: 10 }] } }), res);
ok(res.statusCode === 429, 'demasiadas subidas a medias en la tarea → 429 (no se puede llenar el almacén a ciegas)');
reiniciar(); res = respuesta();
tablas.entregas = Array.from({ length: 10 }, () => ({ tarea_id: T1, alumno_id: A2, estado: 'subiendo', created_at: new Date().toISOString() }));
await entrega(peticion({ token: null, body: { accion: 'preparar', t: TOKEN, alumno_id: A2, archivos: [{ nombre: 'a.jpg', mime: 'image/jpeg', bytes: 10 }] } }), res);
const bloqueadoA2 = res.statusCode; res = respuesta();
await entrega(peticion({ token: null, body: { accion: 'preparar', t: TOKEN, alumno_id: A1, archivos: [{ nombre: 'a.jpg', mime: 'image/jpeg', bytes: 10 }] } }), res);
ok(bloqueadoA2 === 429 && res.statusCode === 200, 'quien deja 10 subidas a medias se bloquea a sí mismo, no a la clase');

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

console.log('== /api/correo-entrante (buzón del grupo) ==');
process.env.RESEND_WEBHOOK_SECRET = 'whsec_' + Buffer.from('secreto-de-prueba-123').toString('base64');
const { default: correo, firmaValida, elegirTarea, direccion } = await import('../api/correo-entrante.js');
const crypto = await import('node:crypto');
function avisoFirmado(evento, { secreto = process.env.RESEND_WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const cuerpo = JSON.stringify(evento);
  const clave = Buffer.from(secreto.replace(/^whsec_/, ''), 'base64');
  const firma = crypto.createHmac('sha256', clave).update(`msg_1.${ts}.${cuerpo}`).digest('base64');
  const req = Readable.from([Buffer.from(cuerpo)]);
  req.method = 'POST';
  req.headers = { 'svix-id': 'msg_1', 'svix-timestamp': String(ts), 'svix-signature': `v1,${firma}` };
  return req;
}
const BUZON = '3-eso-a-5e7200f543';
const correoDe = (from, subject, extra = {}) => ({ type: 'email.received', data: { email_id: 'em-1', from, to: [`${BUZON}@entregas.lapizverde.com`], subject, ...extra } });
function conBuzon() {
  reiniciar();
  tablas.grupos[0].buzon = BUZON;
  tablas.alumnos.find((a) => a.id === A1).email = 'Ana.Lopez@alumnos.es';
  tablas.tareas.push({ id: '20000000-0000-4000-8000-000000000002', owner_id: U1, grupo_id: G1, titulo: 'Redacción', entrega_abierta: false, created_at: '2026-10-09' });
  estado.adjuntos = [
    { id: 'at1', filename: 'pagina1.jpg', size: 300000, content_type: 'image/jpeg', content_disposition: 'attachment', download_url: 'https://cdn.resend.test/at1?bytes=300000' },
    { id: 'at2', filename: 'logo.png', size: 3000, content_type: 'image/png', content_disposition: 'inline', download_url: 'https://cdn.resend.test/at2?bytes=3000' },
    { id: 'at3', filename: 'virus.exe', size: 1000, content_type: 'application/x-msdownload', content_disposition: 'attachment', download_url: 'https://cdn.resend.test/at3' },
    { id: 'at4', filename: 'trabajo.pdf', size: 900000, content_type: 'application/pdf', content_disposition: 'attachment', download_url: 'https://cdn.resend.test/at4?bytes=900000' },
  ];
}
ok(direccion('Ana López <Ana.Lopez@Alumnos.es>') === 'ana.lopez@alumnos.es', 'saca la dirección del remitente');
const tareasP = [{ id: 1, titulo: 'Libreta', entrega_abierta: true }, { id: 2, titulo: 'Libreta semana 12', entrega_abierta: true }, { id: 3, titulo: 'Otra', entrega_abierta: true }, { id: 4, titulo: 'Cerrada', entrega_abierta: false }];
ok(elegirTarea(tareasP, 'Re: libreta SEMANA 12 de Ana')?.id === 2 && elegirTarea(tareasP, 'mi trabajo')?.id === 1, 'tarea por el asunto (la más específica); si no, la última abierta');
ok(elegirTarea(tareasP, 'te mando lo de cerrada') === null, 'si la tarea del asunto tiene la entrega cerrada → no se acepta');

conBuzon(); res = respuesta();
await correo(avisoFirmado(correoDe('Ana López <ana.lopez@alumnos.es>', 'Libreta semana 12')), res);
ok(res.statusCode === 200 && res.cuerpo.recibidos === 2 && res.cuerpo.identificado === true, 'guarda la foto y el PDF (no el logo ni el .exe) y reconoce a Ana por su correo');
ok(tablas.entregas.every((e) => e.alumno_id === A1 && e.tarea_id === T1 && e.estado === 'pendiente' && e.canal === 'correo' && e.correo_id === 'em-1'), 'entregas pendientes de Ana en «Libreta semana 12»');
ok(tablas.entregas.every((e) => almacen.has(e.ruta) && e.ruta.startsWith(`${U1}/${T1}/`)), 'archivos en la carpeta del profesor');
ok((tablas.archivos_por_borrar ?? []).length === 0, 'al terminar bien, ningún archivo queda apuntado para borrar');
res = respuesta();
await correo(avisoFirmado(correoDe('ana.lopez@alumnos.es', 'Libreta semana 12')), res);
ok(res.cuerpo.ignorado === 'ya recibido' && tablas.entregas.length === 2, 'si Resend repite el aviso, no se duplica');

conBuzon(); res = respuesta();
await correo(avisoFirmado(correoDe('desconocido@gmail.com', 'cosas')), res);
ok(res.cuerpo.recibidos === 2 && tablas.entregas.every((e) => e.alumno_id === null && e.remitente === 'desconocido@gmail.com' && e.tarea_id === T1),
  'remitente desconocido → «sin identificar», en la última tarea abierta');
conBuzon(); res = respuesta();
await correo(avisoFirmado(correoDe('ana.lopez@alumnos.es', 'Redacción')), res);
ok(res.cuerpo.ignorado && tablas.entregas.length === 0, 'tarea del asunto con la entrega cerrada → no se guarda');

conBuzon(); res = respuesta();
await correo(avisoFirmado(correoDe('ana.lopez@alumnos.es', 'hola'), { secreto: 'whsec_' + Buffer.from('otro').toString('base64') }), res);
ok(res.statusCode === 401 && tablas.entregas.length === 0, 'firma falsa → 401 y no guarda nada');
conBuzon(); res = respuesta();
await correo(avisoFirmado(correoDe('ana.lopez@alumnos.es', 'hola'), { ts: Math.floor(Date.now() / 1000) - 3600 }), res);
ok(res.statusCode === 401, 'aviso de hace una hora (reenviado) → 401');
conBuzon(); res = respuesta();
await correo(avisoFirmado({ ...correoDe('a@b.es', 'x'), data: { ...correoDe('a@b.es', 'x').data, to: ['no-existe-123456@entregas.lapizverde.com'] } }), res);
ok(res.statusCode === 200 && res.cuerpo.ignorado === 'buzón desconocido' && tablas.entregas.length === 0, 'buzón que no existe → se ignora');
conBuzon(); estado.adjuntos = []; res = respuesta();
await correo(avisoFirmado(correoDe('ana.lopez@alumnos.es', 'Libreta semana 12')), res);
ok(res.cuerpo.ignorado === 'sin adjuntos válidos', 'correo sin adjuntos → se ignora');

console.log('== /api/cron-nocturno (Batch API) ==');
const { default: cron } = await import('../api/cron-nocturno.js');
const peticionCron = (fase, secreto = 'cron-secreto') => peticion({ metodo: 'GET', token: null, query: { fase }, headers: { authorization: `Bearer ${secreto}` } });
const T2 = '20000000-0000-4000-8000-000000000009';
function conNocturna() {
  reiniciar();
  tablas.grupos[0].nivel = '3ESO';
  Object.assign(tablas.tareas[0], { correccion_auto: true, rubrica: '- Contenido (10 pts)' });
  tablas.tareas.push({ id: T2, owner_id: U1, grupo_id: G1, titulo: 'Sin nocturna', correccion_auto: false, rubrica: 'x' });
  const e = (id, alumno, tarea, estadoE = 'pendiente', extra = {}) => ({ id, owner_id: U1, tarea_id: tarea, alumno_id: alumno, ruta: `${U1}/${tarea}/${id}.jpg`, mime: 'image/jpeg', bytes: 10, estado: estadoE, created_at: '2026-10-08T10:00:00Z', ...extra });
  tablas.entregas = [
    e('e0000000-0000-4000-8000-00000000000a', A1, T1), e('e0000000-0000-4000-8000-00000000000b', A1, T1),
    e('e0000000-0000-4000-8000-00000000000c', A2, T1),
    e('e0000000-0000-4000-8000-00000000000d', A1, T2),                         // tarea sin nocturna
    e('e0000000-0000-4000-8000-00000000000e', null, T1),                       // sin identificar
  ];
  tablas.entregas.forEach((x) => almacen.set(x.ruta, Buffer.from('foto')));
  tablas.lotes_ia = [];
}
delete process.env.CRON_SECRET;
conNocturna(); res = respuesta();
await cron(peticionCron('enviar'), res);
ok(res.statusCode === 503, 'sin CRON_SECRET configurado → 503');
process.env.CRON_SECRET = 'cron-secreto';
conNocturna(); res = respuesta();
await cron(peticionCron('enviar', 'otro'), res);
ok(res.statusCode === 401 && !estado.lote, 'secreto equivocado → 401');

conNocturna(); res = respuesta();
await cron(peticionCron('enviar'), res);
const reqs = estado.lote?.requests ?? [];
ok(res.statusCode === 200 && res.cuerpo.enviados === 2 && reqs.length === 2, 'envía un lote con 2 alumnos (no la otra tarea ni lo sin identificar)');
ok(reqs.every((r) => /^[0-9a-f]{32}$/.test(r.custom_id) && r.params.model === 'claude-sonnet-5'), 'peticiones con clave válida para la Batch API');
ok(reqs.find((r) => r.params.messages[0].content[1].text.includes('Ana López García'))?.params.messages[0].content.length === 4, 'Ana: sus 2 fotos en la misma corrección');
ok(estado.creditos === 3, 'cobra 1 corrección por alumno');
ok(tablas.entregas.filter((x) => x.estado === 'corrigiendo').length === 3 && tablas.lotes_ia.length === 1, 'marca las entregas como «corrigiendo» y guarda el lote');

conNocturna(); estado.creditos = 1; res = respuesta();
await cron(peticionCron('enviar'), res);
ok(res.cuerpo.enviados === 1 && tablas.entregas.filter((x) => x.estado === 'pendiente' && x.tarea_id === T1 && x.alumno_id).length > 0, 'sin saldo para todos: envía lo que puede y el resto se queda pendiente');

conNocturna(); res = respuesta();
await cron(peticionCron('enviar'), res);
const loteGuardado = estado.lote; const creditosTrasEnviar = estado.creditos;
res = respuesta();
await cron(peticionCron('recoger'), res);
ok(res.cuerpo.lotes_en_curso === 1 && tablas.entregas.filter((x) => x.estado === 'corrigiendo').length === 3, 'lote aún en marcha → no toca nada');
estado.loteTerminado = true;
estado.loteFallos = [loteGuardado.requests.find((r) => r.params.messages[0].content[1].text.includes('Lucas')).custom_id];
tablas.entregas.push({ id: 'vieja', owner_id: U1, tarea_id: T1, alumno_id: A1, ruta: `${U1}/${T1}/vieja.jpg`, estado: 'aprobada', created_at: '2026-10-01' },
  { id: 'abandonada', owner_id: U1, tarea_id: T1, alumno_id: A1, ruta: `${U1}/${T1}/abandonada.jpg`, estado: 'subiendo', created_at: '2020-01-01' });
almacen.set(`${U1}/${T1}/vieja.jpg`, 'x');
res = respuesta();
await cron(peticionCron('recoger'), res);
const anaE = tablas.entregas.filter((x) => x.alumno_id === A1 && x.tarea_id === T1 && x.lote_id);
const lucasE = tablas.entregas.filter((x) => x.alumno_id === A2);
ok(res.cuerpo.corregidas === 1 && anaE.every((x) => x.estado === 'corregida' && x.resultado?.nota === 7.5), 'Ana: propuesta guardada, lista para revisar por la mañana');
ok(res.cuerpo.fallidas === 1 && lucasE.every((x) => x.estado === 'error') && estado.creditos === creditosTrasEnviar + 1, 'Lucas falló: queda con error y se le devuelve la corrección');
ok(tablas.lotes_ia[0].estado === 'recogido' && tablas.uso_ia.some((u) => u.tipo === 'correccion_lote' && u.input_tokens === 2000), 'lote cerrado y coste registrado');
ok(!almacen.has(`${U1}/${T1}/vieja.jpg`) && tablas.entregas.find((x) => x.id === 'vieja').ruta === null, 'borra el archivo de lo ya aprobado');
ok(!tablas.entregas.some((x) => x.id === 'abandonada'), 'borra las subidas que nunca se completaron');
ok(tablas.entregas.find((x) => x.id === 'vieja').resultado == null, 'y la propuesta de la IA de lo ya aprobado');
reiniciar(); tablas.lotes_ia = []; tablas.archivos_por_borrar = [{ ruta: `${U1}/t/huerfano.jpg` }]; almacen.set(`${U1}/t/huerfano.jpg`, 'x');
res = respuesta();
await cron(peticionCron('recoger'), res);
ok(!almacen.has(`${U1}/t/huerfano.jpg`) && tablas.archivos_por_borrar.length === 0, 'borra los archivos huérfanos (de entregas o tareas borradas)');

console.log(fails ? `\n${fails} FALLOS` : '\nTodo correcto');
process.exit(fails ? 1 : 0);
