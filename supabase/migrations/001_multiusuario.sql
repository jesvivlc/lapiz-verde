-- ═══════════════════════════════════════════════════════════════════
-- 001 — Multiusuario: perfiles, créditos, pagos, uso de IA, owner_id + RLS
--
-- Cómo ejecutarlo: panel de Supabase → SQL Editor → pegar entero → Run.
-- Es idempotente: se puede ejecutar más de una vez sin romper nada.
--
-- ⚠️  En cuanto se ejecuta, la RLS queda activa: sin sesión iniciada no
-- se ve ningún dato. Ejecútalo DESPUÉS de publicar la rama fase-1
-- (la versión antigua de la app no tiene login y dejaría de ver datos).
-- Después ejecuta 002 para asignarte los datos que ya existen.
-- ═══════════════════════════════════════════════════════════════════

-- ── Perfiles (uno por usuario de auth) ─────────────────────────────
create table if not exists public.perfiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  nombre      text,
  creditos    integer not null default 20 check (creditos >= 0),
  created_at  timestamptz not null default now()
);

-- Crear el perfil automáticamente al registrarse
create or replace function public.crear_perfil_nuevo_usuario()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.perfiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.crear_perfil_nuevo_usuario();

-- Perfiles para usuarios que ya existieran antes de este script
insert into public.perfiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

alter table public.perfiles enable row level security;

drop policy if exists perfiles_select_propio on public.perfiles;
create policy perfiles_select_propio on public.perfiles
  for select using (id = (select auth.uid()));

drop policy if exists perfiles_update_propio on public.perfiles;
create policy perfiles_update_propio on public.perfiles
  for update using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- El usuario solo puede cambiar su nombre, nunca sus créditos
revoke insert, update, delete on public.perfiles from anon, authenticated;
grant select on public.perfiles to authenticated;
grant update (nombre) on public.perfiles to authenticated;


-- ── Pagos (Stripe) ─────────────────────────────────────────────────
create table if not exists public.pagos (
  id                 bigint generated always as identity primary key,
  user_id            uuid not null references auth.users(id) on delete cascade,
  stripe_session_id  text not null unique,
  creditos           integer not null,
  importe_cents      integer,
  created_at         timestamptz not null default now()
);

alter table public.pagos enable row level security;
drop policy if exists pagos_select_propio on public.pagos;
create policy pagos_select_propio on public.pagos
  for select using (user_id = (select auth.uid()));
revoke insert, update, delete on public.pagos from anon, authenticated;


-- ── Uso de IA (para medir el coste real por corrección) ────────────
create table if not exists public.uso_ia (
  id                    bigint generated always as identity primary key,
  user_id               uuid references auth.users(id) on delete set null,
  tipo                  text not null,            -- 'correccion' | 'rubrica' | 'email'
  modelo                text,
  input_tokens          integer,
  output_tokens         integer,
  cache_read_tokens     integer,
  cache_creation_tokens integer,
  ok                    boolean not null default true,
  created_at            timestamptz not null default now()
);

alter table public.uso_ia enable row level security;
drop policy if exists uso_ia_select_propio on public.uso_ia;
create policy uso_ia_select_propio on public.uso_ia
  for select using (user_id = (select auth.uid()));
revoke insert, update, delete on public.uso_ia from anon, authenticated;


-- ── Funciones de créditos: solo el servidor (service_role) puede llamarlas ──
create or replace function public.consumir_credito(p_user uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.perfiles
     set creditos = creditos - 1
   where id = p_user and creditos > 0
  returning creditos;
$$;

create or replace function public.devolver_credito(p_user uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.perfiles set creditos = creditos + 1 where id = p_user;
$$;

-- Idempotente: si Stripe reenvía el mismo evento, no suma dos veces
create or replace function public.acreditar_pago(
  p_session text, p_user uuid, p_creditos integer, p_importe integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.pagos (user_id, stripe_session_id, creditos, importe_cents)
  values (p_user, p_session, p_creditos, p_importe);
  update public.perfiles set creditos = creditos + p_creditos where id = p_user;
  return true;
exception when unique_violation then
  return false;
end;
$$;

revoke execute on function public.consumir_credito(uuid) from public, anon, authenticated;
revoke execute on function public.devolver_credito(uuid) from public, anon, authenticated;
revoke execute on function public.acreditar_pago(text, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.consumir_credito(uuid) to service_role;
grant execute on function public.devolver_credito(uuid) to service_role;
grant execute on function public.acreditar_pago(text, uuid, integer, integer) to service_role;


-- ── owner_id en las tablas existentes ──────────────────────────────
-- default auth.uid(): el frontend no tiene que rellenarlo al insertar
alter table public.grupos  add column if not exists owner_id uuid references auth.users(id) on delete cascade default auth.uid();
alter table public.alumnos add column if not exists owner_id uuid references auth.users(id) on delete cascade default auth.uid();
alter table public.tareas  add column if not exists owner_id uuid references auth.users(id) on delete cascade default auth.uid();
alter table public.notas   add column if not exists owner_id uuid references auth.users(id) on delete cascade default auth.uid();

create index if not exists grupos_owner_idx  on public.grupos (owner_id);
create index if not exists alumnos_owner_idx on public.alumnos (owner_id);
create index if not exists tareas_owner_idx  on public.tareas (owner_id);
create index if not exists notas_owner_idx   on public.notas (owner_id);

-- Columnas nuevas o que el código usa (no hace nada si ya existen)
alter table public.tareas add column if not exists rubrica text;
alter table public.notas  add column if not exists comentario_ia text;
alter table public.notas  add column if not exists mejoras_ia text;
alter table public.notas  add column if not exists mensaje_motivador text;
alter table public.notas  add column if not exists origen text default 'manual';
alter table public.notas  add column if not exists corregido_at timestamptz;


-- ── RLS en las tablas existentes ───────────────────────────────────
alter table public.grupos  enable row level security;
alter table public.alumnos enable row level security;
alter table public.tareas  enable row level security;
alter table public.notas   enable row level security;

-- Borrar cualquier política anterior (p. ej. "Enable read access for all users"
-- de cuando la app no tenía login). Las políticas permisivas se suman con OR:
-- si quedara una abierta, anularía el aislamiento entre profesores.
do $$
declare p record;
begin
  for p in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('grupos', 'alumnos', 'tareas', 'notas')
      and policyname not in ('grupos_propios', 'alumnos_propios', 'tareas_propias', 'notas_propias')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- TRUNCATE no pasa por la RLS
revoke truncate on public.grupos, public.alumnos, public.tareas, public.notas,
  public.perfiles, public.pagos, public.uso_ia from anon, authenticated;

drop policy if exists grupos_propios on public.grupos;
create policy grupos_propios on public.grupos
  for all
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- Los hijos solo pueden colgar de un grupo propio
drop policy if exists alumnos_propios on public.alumnos;
create policy alumnos_propios on public.alumnos
  for all
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.grupos g where g.id = grupo_id and g.owner_id = (select auth.uid()))
  );

drop policy if exists tareas_propias on public.tareas;
create policy tareas_propias on public.tareas
  for all
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.grupos g where g.id = grupo_id and g.owner_id = (select auth.uid()))
  );

drop policy if exists notas_propias on public.notas;
create policy notas_propias on public.notas
  for all
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.alumnos a where a.id = alumno_id and a.owner_id = (select auth.uid()))
    and exists (select 1 from public.tareas  t where t.id = tarea_id  and t.owner_id = (select auth.uid()))
  );


-- ── Vistas: que respeten la RLS de quien consulta ──────────────────
-- Sin esto, las vistas se ejecutan con permisos de su dueño y
-- cualquiera vería los grupos y medias de todos los profesores.
alter view if exists public.v_resumen_grupo           set (security_invoker = on);
alter view if exists public.v_media_alumno_evaluacion set (security_invoker = on);
