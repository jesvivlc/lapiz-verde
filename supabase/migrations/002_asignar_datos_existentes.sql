-- ═══════════════════════════════════════════════════════════════════
-- 002 — Asignar los grupos, alumnos, tareas y notas que ya existían
--       a tu usuario, y hacer owner_id obligatorio.
--
-- Antes de ejecutarlo:
--   1. Haber ejecutado 001.
--   2. Haber iniciado sesión UNA vez en la app nueva con tu correo
--      (así se crea tu usuario).
--   3. Cambiar TU_EMAIL_AQUI por ese correo, abajo.
-- ═══════════════════════════════════════════════════════════════════

do $$
declare
  v_user uuid;
begin
  select id into v_user from auth.users where email = 'TU_EMAIL_AQUI';

  if v_user is null then
    raise exception 'No existe ningún usuario con ese correo. Inicia sesión en la app primero y revisa el correo escrito.';
  end if;

  update public.grupos  set owner_id = v_user where owner_id is null;
  update public.alumnos set owner_id = v_user where owner_id is null;
  update public.tareas  set owner_id = v_user where owner_id is null;
  update public.notas   set owner_id = v_user where owner_id is null;

  -- Tu cuenta no gasta créditos de prueba: saldo generoso
  update public.perfiles set creditos = greatest(creditos, 1000) where id = v_user;
end $$;

alter table public.grupos  alter column owner_id set not null;
alter table public.alumnos alter column owner_id set not null;
alter table public.tareas  alter column owner_id set not null;
alter table public.notas   alter column owner_id set not null;
