-- ═══════════════════════════════════════════════════════════════════
-- 003 — Recepción de entregas: enlace por tarea, pegatinas QR,
--       buzón de correo por grupo y corrección nocturna.
--
-- Cómo ejecutarlo: panel de Supabase → SQL Editor → pegar entero → Run.
-- Es idempotente. Se puede ejecutar ANTES de publicar el código nuevo:
-- solo añade columnas, tablas y el almacén de archivos.
--
-- Todos los canales escriben en la misma tabla `entregas`: una fila por
-- archivo recibido. El servidor (service_role) es el único que crea filas;
-- el profesor solo ve, reasigna, descarta o borra las suyas.
-- ═══════════════════════════════════════════════════════════════════

-- ── Tareas: enlace de entrega y corrección automática ──────────────
alter table public.tareas add column if not exists token_entrega   text;
alter table public.tareas add column if not exists entrega_abierta boolean not null default false;
alter table public.tareas add column if not exists correccion_auto boolean not null default false;
create unique index if not exists tareas_token_entrega_idx on public.tareas (token_entrega);

-- El token es lo único que protege el enlace: que no pueda ser corto
alter table public.tareas drop constraint if exists tareas_token_largo;
alter table public.tareas add constraint tareas_token_largo
  check (token_entrega is null or token_entrega ~ '^[A-Za-z0-9_-]{32,64}$');


-- ── Grupos: buzón de correo (grupo-x7k2…@entregas.lapizverde.com) ──
alter table public.grupos add column if not exists buzon text;
create unique index if not exists grupos_buzon_idx on public.grupos (buzon);
alter table public.grupos drop constraint if exists grupos_buzon_formato;
alter table public.grupos add constraint grupos_buzon_formato
  check (buzon is null or buzon ~ '^[a-z0-9-]{12,48}$');


-- ── Lotes de corrección nocturna (Batch API). Solo el servidor ─────
create table if not exists public.lotes_ia (
  id          uuid primary key default gen_random_uuid(),
  batch_id    text not null unique,
  estado      text not null default 'enviado' check (estado in ('enviado', 'recogido', 'error')),
  created_at  timestamptz not null default now()
);
alter table public.lotes_ia enable row level security;
revoke all on public.lotes_ia from anon, authenticated;


-- ── Entregas: un archivo recibido por cualquier canal ──────────────
create table if not exists public.entregas (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  tarea_id       uuid not null references public.tareas(id) on delete cascade,
  alumno_id      uuid references public.alumnos(id) on delete set null,  -- null = sin identificar
  canal          text not null check (canal in ('enlace', 'correo')),
  ruta           text,                -- ruta en el almacén; null cuando ya se ha borrado el archivo
  nombre_fichero text,
  mime           text,
  bytes          integer,
  remitente      text,                -- correo de quien lo envió (canal correo)
  correo_id      text,                -- id del correo en Resend: evita duplicados si el aviso llega dos veces
  estado         text not null default 'subiendo'
                 check (estado in ('subiendo', 'pendiente', 'corrigiendo', 'corregida', 'aprobada', 'error', 'descartada')),
  resultado      jsonb,               -- propuesta de la IA, pendiente de que el profesor la apruebe
  error          text,
  lote_id        uuid references public.lotes_ia(id) on delete set null,
  lote_clave     text,
  created_at     timestamptz not null default now(),
  corregida_at   timestamptz
);
alter table public.entregas add column if not exists correo_id text;
create index if not exists entregas_tarea_alumno_idx on public.entregas (tarea_id, alumno_id);
create index if not exists entregas_owner_estado_idx on public.entregas (owner_id, estado);
create index if not exists entregas_lote_idx         on public.entregas (lote_id);
create index if not exists entregas_correo_idx       on public.entregas (correo_id);

alter table public.entregas enable row level security;

drop policy if exists entregas_select_propias on public.entregas;
create policy entregas_select_propias on public.entregas
  for select using (owner_id = (select auth.uid()));

-- Reasignar una entrega solo a un alumno propio y del mismo grupo que la tarea
drop policy if exists entregas_update_propias on public.entregas;
create policy entregas_update_propias on public.entregas
  for update
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and (alumno_id is null or exists (
      select 1 from public.alumnos a
      join public.tareas t on t.grupo_id = a.grupo_id
      where a.id = alumno_id and t.id = tarea_id and a.owner_id = (select auth.uid())
    ))
  );

drop policy if exists entregas_delete_propias on public.entregas;
create policy entregas_delete_propias on public.entregas
  for delete using (owner_id = (select auth.uid()));

-- El profesor no crea filas (las crea el servidor) y solo puede tocar alumno y estado
revoke insert, update, truncate on public.entregas from anon, authenticated;
revoke all on public.entregas from anon;
grant select, delete on public.entregas to authenticated;
grant update (alumno_id, estado) on public.entregas to authenticated;


-- ── Almacén de archivos (Supabase Storage), privado ────────────────
-- Ruta de cada archivo: <owner_id>/<tarea_id>/<entrega_id>.<ext>
-- Suben los alumnos con una URL firmada que da el servidor; nadie sube
-- directamente. El profesor puede ver y borrar solo su carpeta.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('entregas', 'entregas', false, 15728640,
            array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;

    execute 'drop policy if exists entregas_leer_propias on storage.objects';
    execute $p$create policy entregas_leer_propias on storage.objects
      for select to authenticated
      using (bucket_id = 'entregas' and (storage.foldername(name))[1] = (select auth.uid())::text)$p$;

    execute 'drop policy if exists entregas_borrar_propias on storage.objects';
    execute $p$create policy entregas_borrar_propias on storage.objects
      for delete to authenticated
      using (bucket_id = 'entregas' and (storage.foldername(name))[1] = (select auth.uid())::text)$p$;
  end if;
end $$;
