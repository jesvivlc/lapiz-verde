// Prueba las migraciones contra una réplica mínima de Supabase en Postgres (PGlite).
// Ejecutar: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const REPO = new URL('../migrations/', import.meta.url).pathname;
const db = new PGlite();
const q = (s, p) => db.query(s, p);
let fails = 0;
const ok = (c, m) => { console.log((c ? '  OK  ' : '  FAIL') + ' ' + m); if (!c) fails++; };
async function asUser(uid, fn) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
async function expectErr(p, m) { try { await p; ok(false, m + ' (no dio error)'); } catch (e) { ok(true, m + ' → ' + e.message.split('\n')[0]); } }

// ── Réplica mínima del entorno Supabase ──
await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table grupos (id uuid primary key default gen_random_uuid(), nombre text, nivel text, anio_academico text, created_at timestamptz default now());
create table alumnos (id uuid primary key default gen_random_uuid(), grupo_id uuid references grupos(id), nombre text, apellidos text, email text, activo boolean default true, created_at timestamptz default now());
create table tareas (id uuid primary key default gen_random_uuid(), grupo_id uuid references grupos(id), titulo text, descripcion text, evaluacion text, fecha_entrega date, peso_nota numeric, created_at timestamptz default now());
create table notas (id uuid primary key default gen_random_uuid(), alumno_id uuid references alumnos(id), tarea_id uuid references tareas(id), nota numeric, faltas int, comentario_ia text, mejoras_ia text, mensaje_motivador text, comentario_profesor text, origen text check (origen in ('manual','markmate')), corregido_at timestamptz, created_at timestamptz default now(), unique (alumno_id, tarea_id));
create view v_resumen_grupo as select g.id grupo_id, g.nombre grupo_nombre, g.nivel, g.anio_academico,
  (select count(*) from alumnos a where a.grupo_id=g.id) total_alumnos, (select count(*) from tareas t where t.grupo_id=g.id) total_tareas,
  (select avg(n.nota) from notas n join alumnos a on a.id=n.alumno_id where a.grupo_id=g.id) media_general from grupos g;
create view v_media_alumno_evaluacion as select a.id alumno_id, t.evaluacion, avg(n.nota) media from notas n join alumnos a on a.id=n.alumno_id join tareas t on t.id=n.tarea_id group by 1,2;

-- políticas abiertas de cuando la app no tenía login (la 001 debe quitarlas)
alter table alumnos enable row level security;
create policy "Enable read access for all users" on alumnos for select using (true);
create policy "Permitir todo" on notas for all using (true) with check (true);

-- datos que ya existían
insert into grupos (id, nombre) values ('11111111-1111-1111-1111-111111111111', 'Grupo antiguo de Bruno');
insert into alumnos (id, grupo_id, nombre) values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Ana');
insert into tareas (id, grupo_id, titulo) values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Tarea antigua');
insert into notas (alumno_id, tarea_id, nota) values ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 7);
`);

console.log('== 001 (dos veces, idempotencia) ==');
const m1 = fs.readFileSync(REPO + '001_multiusuario.sql', 'utf8');
await db.exec(m1); await db.exec(m1); ok(true, '001 ejecutada dos veces sin error');

const A = (await q(`insert into auth.users (email) values ('bruno@x.es') returning id`)).rows[0].id;
const B = (await q(`insert into auth.users (email) values ('otra@x.es') returning id`)).rows[0].id;
ok((await q(`select count(*)::int c from perfiles`)).rows[0].c === 2, 'trigger crea perfiles al registrarse');
ok((await q(`select creditos from perfiles where id=$1`, [B])).rows[0].creditos === 20, '20 créditos de regalo');

console.log('== 002 ==');
await db.exec(fs.readFileSync(REPO + '002_asignar_datos_existentes.sql', 'utf8').replaceAll('TU_EMAIL_AQUI', 'bruno@x.es'));
ok((await q(`select count(*)::int c from grupos where owner_id=$1`, [A])).rows[0].c === 1, 'datos antiguos asignados a Bruno');
ok((await q(`select creditos from perfiles where id=$1`, [A])).rows[0].creditos === 1000, 'Bruno con 1000 créditos');

console.log('== Aislamiento ==');
await db.exec(`set role anon;`);
ok((await q(`select count(*)::int c from grupos`)).rows[0].c === 0, 'anónimo no ve grupos');
ok((await q(`select count(*)::int c from v_resumen_grupo`)).rows[0].c === 0, 'anónimo no ve la vista');
ok((await q(`select count(*)::int c from alumnos`)).rows[0].c === 0, 'anónimo no ve alumnos (política antigua abierta eliminada)');
ok((await q(`select count(*)::int c from notas`)).rows[0].c === 0, 'anónimo no ve notas (política antigua abierta eliminada)');
await expectErr(q(`truncate notas`), 'anónimo no puede vaciar tablas con TRUNCATE');
await db.exec(`reset role;`);
ok((await q(`select count(*)::int c from pg_policies where tablename in ('alumnos','notas') and policyname in ('Enable read access for all users','Permitir todo')`)).rows[0].c === 0, 'políticas antiguas borradas');

await asUser(A, async () => {
  ok((await q(`select count(*)::int c from v_resumen_grupo`)).rows[0].c === 1, 'Bruno ve su grupo en la vista');
  ok((await q(`select count(*)::int c from notas`)).rows[0].c === 1, 'Bruno ve su nota');
});
await asUser(B, async () => {
  ok((await q(`select count(*)::int c from grupos`)).rows[0].c === 0, 'B no ve los grupos de Bruno');
  ok((await q(`select count(*)::int c from v_resumen_grupo`)).rows[0].c === 0, 'B no ve la vista de Bruno');
  ok((await q(`select count(*)::int c from v_media_alumno_evaluacion`)).rows[0].c === 0, 'B no ve medias de Bruno');
  const g = (await q(`insert into grupos (nombre) values ('Grupo de B') returning id, owner_id`)).rows[0];
  ok(g.owner_id === B, 'owner_id se rellena solo con auth.uid()');
  await q(`insert into alumnos (grupo_id, nombre) values ($1, 'Luis')`, [g.id]);
  ok(true, 'B mete alumno en su grupo');
  await expectErr(q(`insert into alumnos (grupo_id, nombre) values ('11111111-1111-1111-1111-111111111111', 'Intruso')`), 'B no puede meter alumnos en el grupo de Bruno');
  await expectErr(q(`insert into notas (alumno_id, tarea_id, nota) values ('22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333', 0)`), 'B no puede poner notas a alumnos de Bruno');
  const upd = await q(`update notas set nota = 0 returning id`);
  ok(upd.rows.length === 0, 'B no puede modificar notas de Bruno');
  await expectErr(q(`update perfiles set creditos = 99999 where id = $1`, [B]), 'B no puede subirse los créditos');
  await q(`update perfiles set nombre = 'Profe B' where id = $1`, [B]); ok(true, 'B sí puede cambiar su nombre');
  await expectErr(q(`select devolver_credito($1)`, [B]), 'B no puede llamar a devolver_credito');
  await expectErr(q(`select acreditar_pago('fake', $1, 1000, 0)`, [B]), 'B no puede acreditarse pagos');
  await expectErr(q(`insert into pagos (user_id, stripe_session_id, creditos) values ($1, 'x', 1000)`, [B]), 'B no puede insertar pagos');
});

console.log('== Créditos (como servidor) ==');
await db.exec(`set role service_role;`);
let last;
for (let i = 0; i < 20; i++) last = (await q(`select consumir_credito($1) c`, [B])).rows[0].c;
ok(last === 0, 'consume 20 créditos hasta 0');
ok((await q(`select consumir_credito($1) c`, [B])).rows[0].c === null, 'con 0 créditos devuelve null (se niega)');
ok((await q(`select acreditar_pago('cs_1', $1, 100, 900) r`, [B])).rows[0].r === true, 'pago acreditado');
ok((await q(`select acreditar_pago('cs_1', $1, 100, 900) r`, [B])).rows[0].r === false, 'mismo pago repetido: no suma dos veces');
ok((await q(`select creditos from perfiles where id=$1`, [B])).rows[0].creditos === 100, 'saldo final 100');
await db.exec(`reset role;`);

console.log('== 003 entregas (dos veces) ==');
// Réplica mínima de Supabase Storage para probar el bloque del almacén
await db.exec(`
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema storage to anon, authenticated, service_role;
grant select, delete on storage.objects to authenticated;
alter table storage.objects enable row level security;
`);
const m3 = fs.readFileSync(REPO + '003_entregas.sql', 'utf8');
await db.exec(m3); await db.exec(m3); ok(true, '003 ejecutada dos veces sin error');
await expectErr(q(`update tareas set token_entrega = 'corto' where id = '33333333-3333-3333-3333-333333333333'`), 'token de entrega corto → rechazado');
await q(`update tareas set token_entrega = $1, entrega_abierta = true where id = '33333333-3333-3333-3333-333333333333'`, ['a'.repeat(40)]);
ok(true, 'token largo aceptado');
ok((await q(`select public from storage.buckets where id = 'entregas'`)).rows[0]?.public === false, 'almacén "entregas" creado y privado');
await q(`insert into storage.objects (bucket_id, name) values ('entregas', $1), ('entregas', $2)`, [`${A}/t/1.pdf`, `${B}/t/2.pdf`]);
await asUser(A, async () => {
  const filas = (await q(`select name from storage.objects`)).rows;
  ok(filas.length === 1 && filas[0].name.startsWith(A), 'en el almacén, Bruno solo ve su carpeta');
});
// segundo grupo de Bruno con un alumno, para probar reasignaciones entre grupos
await q(`insert into grupos (id, owner_id, nombre) values ('44444444-4444-4444-4444-444444444444', $1, 'Otro grupo de Bruno')`, [A]);
await q(`insert into alumnos (id, grupo_id, owner_id, nombre) values ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', $1, 'Pepe')`, [A]);
await q(`insert into alumnos (id, grupo_id, owner_id, nombre) values ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', $1, 'Eva')`, [A]);
// el servidor crea las entregas
await db.exec(`set role service_role;`);
const E = (await q(`insert into entregas (owner_id, tarea_id, alumno_id, canal, ruta, estado) values ($1, '33333333-3333-3333-3333-333333333333', null, 'correo', 'x', 'pendiente') returning id`, [A])).rows[0].id;
await db.exec(`reset role;`);

await asUser(A, async () => {
  ok((await q(`select count(*)::int c from entregas`)).rows[0].c === 1, 'Bruno ve su entrega');
  await q(`update entregas set alumno_id = '66666666-6666-6666-6666-666666666666' where id = $1`, [E]);
  ok((await q(`select alumno_id from entregas where id = $1`, [E])).rows[0].alumno_id === '66666666-6666-6666-6666-666666666666', 'Bruno asigna la entrega a un alumno del grupo de la tarea');
  await expectErr(q(`update entregas set alumno_id = '55555555-5555-5555-5555-555555555555' where id = $1`, [E]), 'no puede asignarla a un alumno de OTRO grupo');
  await expectErr(q(`update entregas set resultado = '{"nota":10}' where id = $1`, [E]), 'no puede escribir el resultado de la IA');
  await expectErr(q(`insert into entregas (owner_id, tarea_id, canal) values ($1, '33333333-3333-3333-3333-333333333333', 'enlace')`, [A]), 'no puede crear entregas (solo el servidor)');
  await q(`update entregas set estado = 'descartada' where id = $1`, [E]); ok(true, 'puede descartarla');
  await expectErr(q(`select * from lotes_ia`), 'no ve los lotes de la IA');
});
await asUser(B, async () => {
  ok((await q(`select count(*)::int c from entregas`)).rows[0].c === 0, 'B no ve las entregas de Bruno');
  ok((await q(`update entregas set alumno_id = null returning id`)).rows.length === 0, 'B no puede modificarlas');
  ok((await q(`delete from entregas returning id`)).rows.length === 0, 'B no puede borrarlas');
});
await db.exec(`set role anon;`);
await expectErr(q(`select * from entregas`), 'anónimo no puede leer entregas');
await db.exec(`reset role;`);
await asUser(A, async () => {
  ok((await q(`delete from entregas where id = $1 returning id`, [E])).rows.length === 1, 'Bruno puede borrar su entrega');
  await expectErr(q(`select * from archivos_por_borrar`), 'no ve la cola de archivos por borrar');
  await expectErr(q(`insert into correos_procesados values ('x')`), 'no toca los correos procesados');
});
ok((await q(`select count(*)::int c from archivos_por_borrar where ruta = 'x'`)).rows[0].c === 1, 'al borrar la entrega, su archivo queda apuntado para borrarlo');
await db.exec(`set role service_role;`);
await q(`insert into entregas (owner_id, tarea_id, canal, ruta, estado) values ($1, '33333333-3333-3333-3333-333333333333', 'enlace', 'y', 'pendiente')`, [A]);
await db.exec(`reset role;`);
await q(`delete from notas where tarea_id = '33333333-3333-3333-3333-333333333333'`);
await q(`delete from tareas where id = '33333333-3333-3333-3333-333333333333'`);
ok((await q(`select count(*)::int c from archivos_por_borrar where ruta = 'y'`)).rows[0].c === 1, 'si se borra la tarea entera, sus archivos también quedan apuntados');

console.log(fails ? `\n${fails} FALLOS` : '\nTodo correcto');
process.exit(fails ? 1 : 0);
