// Prueba los endpoints de /api con la red simulada (Supabase, Anthropic, Stripe, Resend).
// Ejecutar: npm test
import { Readable } from 'node:stream';
import Stripe from 'stripe';

process.env.ANTHROPIC_API_KEY = 'test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  FAIL') + ' ' + m); if (!c) fails++; };

// ── Red simulada ──
let estado;
function reiniciar() {
  estado = { creditos: 5, llamadas: [], anthropicStatus: 200, anthropicBody: null, resend: 0 };
}
const respuestaIA = { nota: 7.5, nota_texto: 'Notable', comentario: 'Bien', propuestas_mejora: ['a', 'b', 'c'], mensaje_motivador: '¡Ánimo!', legible: true };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  estado.llamadas.push({ url, body });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (url.includes('/auth/v1/user')) {
    const auth = new Headers(init.headers).get('authorization');
    return auth === 'Bearer buen-token' ? json({ id: 'user-1', email: 'profe@x.es', aud: 'authenticated' }) : json({ msg: 'bad jwt' }, 401);
  }
  if (url.includes('/rpc/consumir_credito')) {
    if (estado.creditos <= 0) return json(null);
    estado.creditos--; return json(estado.creditos);
  }
  if (url.includes('/rpc/devolver_credito')) { estado.creditos++; return json(null); }
  if (url.includes('/rpc/acreditar_pago')) { estado.pago = body; return json(true); }
  if (url.includes('/rest/v1/uso_ia')) return init.method === 'HEAD' ? new Response(null, { status: 200, headers: { 'content-range': '0-0/0' } }) : json([], 201);
  if (url.includes('api.anthropic.com')) {
    estado.anthropicBody = body;
    if (estado.anthropicStatus !== 200) return json({ type: 'error', error: { type: 'invalid_request_error', message: 'mal' } }, estado.anthropicStatus);
    return json({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: JSON.stringify(respuestaIA) }],
      usage: { input_tokens: 3000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  }
  if (url.includes('/rest/v1/alumnos')) {
    // Solo existe el alumno a-1, del profesor user-1
    return json(url.includes('id=eq.a-1') && url.includes('owner_id=eq.user-1') ? [{ nombre: 'Ana', email: 'ana@alumnos.es' }] : []);
  }
  if (url.includes('/rest/v1/perfiles')) return json([{ nombre: 'Bruno' }]);
  if (url.includes('api.resend.com')) { estado.resend++; estado.resendBody = body; return json({ id: 'e1' }); }
  throw new Error('URL no simulada: ' + url);
};

function peticion({ metodo = 'POST', token = 'buen-token', body = {}, headers = {} } = {}) {
  return { method: metodo, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), host: 'localhost', ...headers }, body };
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
ok(estado.llamadas.some((l) => l.url.includes('/rest/v1/uso_ia') && l.body?.input_tokens === 3000), 'registra el uso de tokens');

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
ok(res.statusCode === 200 && estado.pago?.p_session === 'cs_123' && estado.pago.p_creditos === 100 && estado.pago.p_user === 'user-1', 'pago firmado → acredita 100 créditos');
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

console.log(fails ? `\n${fails} FALLOS` : '\nTodo correcto');
process.exit(fails ? 1 : 0);
