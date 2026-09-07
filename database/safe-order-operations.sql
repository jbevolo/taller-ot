-- Apply manually after the deployment checks in database/README.md.
-- This migration creates no tables, changes no RLS policies, and grants no table access.
begin;

do $preflight$
declare
    missing text;
begin
    if to_regclass('public.work_orders') is null then
        raise exception 'Existing public.work_orders table required; inspect the deployed schema first';
    end if;
    if not exists (
        select 1 from pg_class where oid = 'public.work_orders'::regclass and relrowsecurity
    ) then
        raise exception 'Enable and audit owner-scoped RLS before deploying these functions';
    end if;
    select string_agg(required.name, ', ') into missing
    from unnest(array['id', 'user_id', 'order_number', 'fecha', 'nombre', 'telefono',
        'vehiculo', 'dominio', 'novedades', 'garantia', 'oblea', 'ph', 'nv',
        'retencion', 'mangueras', 'fotos', 'status', 'monto_cobrado', 'forma_pago', 'notas_extra']) required(name)
    where not exists (
        select 1 from pg_attribute a where a.attrelid = 'public.work_orders'::regclass
        and a.attname = required.name and a.attnum > 0 and not a.attisdropped
        and a.attgenerated = '' and a.attidentity = ''
    );
    if missing is not null then
        raise exception 'Missing or generated application columns: %', missing;
    end if;
    if (select count(*) from pg_attribute where attrelid = 'public.work_orders'::regclass
        and attname in ('id', 'user_id') and atttypid = 'uuid'::regtype) <> 2 then
        raise exception 'id and user_id must be UUID columns';
    end if;
    if not exists (
        select 1 from pg_attribute where attrelid = 'public.work_orders'::regclass
        and attname = 'fotos' and atttypid in ('jsonb'::regtype, 'json'::regtype, 'text[]'::regtype)
    ) then
        raise exception 'Supported fotos types: jsonb, json, text[]; adapt and test other types first';
    end if;
    if not exists (
        select 1 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid
        and a.attname = 'id' where c.conrelid = 'public.work_orders'::regclass
        and c.contype in ('p', 'u') and c.conkey = array[a.attnum] and not c.condeferrable
    ) then
        raise exception 'A nondeferrable primary/unique constraint on id is required';
    end if;
end;
$preflight$;

create or replace function public.restore_work_orders(p_orders jsonb, p_user_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
set lock_timeout = '5s'
as $function$
declare
    owner_id uuid := auth.uid();
    item jsonb;
    typed public.work_orders%rowtype;
    kept_ids uuid[] := '{}';
    columns_sql text;
    updates_sql text;
    affected integer;
    allowed constant text[] := array['id', 'user_id', 'order_number', 'fecha', 'nombre',
        'telefono', 'vehiculo', 'dominio', 'novedades', 'garantia', 'oblea', 'ph', 'nv',
        'retencion', 'mangueras', 'fotos', 'status', 'monto_cobrado', 'forma_pago',
        'notas_extra', 'created_at', 'updated_at'];
begin
    if owner_id is null or owner_id is distinct from p_user_id then
        raise exception 'Authenticated owner mismatch' using errcode = '42501';
    end if;
    if jsonb_typeof(p_orders) is distinct from 'array' then
        raise exception 'Backup must be an array';
    end if;
    if jsonb_array_length(p_orders) not between 1 and 10000 or octet_length(p_orders::text) > 20971520 then
        raise exception 'Backup must contain 1..10000 orders and at most 20 MiB';
    end if;

    -- Validate every row and schema-dependent conversion before writing anything.
    for item in select value from jsonb_array_elements(p_orders) loop
        if jsonb_typeof(item) is distinct from 'object' then
            raise exception 'Each backup entry must be an object';
        end if;
        if not (item ?& array['id', 'user_id', 'order_number', 'fecha', 'nombre', 'vehiculo',
            'dominio', 'novedades', 'status', 'fotos']) then
            raise exception 'Missing required order fields';
        end if;
        if exists (
            select 1 from jsonb_object_keys(item) as keys(key)
            where not (key = any(allowed)) or not exists (
                select 1 from pg_catalog.pg_attribute a
                where a.attrelid = 'public.work_orders'::regclass and a.attname = key
                and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = ''
            )
        ) then
            raise exception 'Unknown, missing, or generated backup column';
        end if;
        if exists (
            select 1 from unnest(array['nombre', 'vehiculo', 'dominio', 'novedades']) fields(name)
            where jsonb_typeof(item -> name) is distinct from 'string' or btrim(item ->> name) = ''
        ) or item ->> 'status' not in ('Abierta', 'Finalizada') then
            raise exception 'Invalid order text or status';
        end if;
        if jsonb_typeof(item -> 'fotos') is distinct from 'array' then
            raise exception 'Photos must be an array';
        end if;
        if exists (select 1 from jsonb_array_elements(item -> 'fotos') photo
            where jsonb_typeof(photo) <> 'string' or (photo #>> '{}') !~ '^https://[^[:space:]]+$') then
            raise exception 'Invalid photo URL';
        end if;
        select * into typed from jsonb_populate_record(null::public.work_orders, item);
        if typed.id is null or typed.user_id is distinct from owner_id or typed.fecha is null
            or typed.order_number is null or typed.order_number < 1 or typed.status is null then
            raise exception 'Invalid order identity, owner, date, number, or status';
        end if;
        if typed.id = any(kept_ids) then raise exception 'Duplicate order id'; end if;
        kept_ids := array_append(kept_ids, typed.id);
    end loop;

    -- Serialize replacement against ALL table writers, including older direct-CRUD clients.
    -- A timeout/constraint/RLS/trigger error rolls back the entire RPC transaction.
    lock table public.work_orders in share row exclusive mode;
    for item in select value from jsonb_array_elements(p_orders) loop
        select string_agg(format('%I', key), ', ' order by key),
            string_agg(format('%1$I = excluded.%1$I', key), ', ' order by key) filter (where key <> 'id')
        into columns_sql, updates_sql from jsonb_object_keys(item) as keys(key);
        -- Existing IDs are updated in place; retained orders do not trigger cascading deletes.
        execute format(
            'insert into public.work_orders (%1$s) select %1$s from jsonb_populate_record(null::public.work_orders, $1)
             on conflict (id) do update set %2$s where work_orders.user_id = $2', columns_sql, updates_sql
        ) using item, owner_id;
        get diagnostics affected = row_count;
        if affected <> 1 then raise exception 'Order is not owned by the authenticated user' using errcode = '42501'; end if;
    end loop;
    delete from public.work_orders where user_id = owner_id and not (id = any(kept_ids));
    return cardinality(kept_ids);
end;
$function$;

create or replace function public.change_order_photos(
    p_order_id uuid, p_add jsonb, p_remove jsonb, p_user_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set lock_timeout = '5s'
as $function$
declare
    owner_id uuid := auth.uid();
    existing public.work_orders%rowtype;
    photos jsonb;
    merged jsonb;
begin
    if owner_id is null or owner_id is distinct from p_user_id then
        raise exception 'Authenticated owner mismatch' using errcode = '42501';
    end if;
    if jsonb_typeof(p_add) is distinct from 'array' or jsonb_typeof(p_remove) is distinct from 'array' then
        raise exception 'Photo deltas must be arrays';
    end if;
    if exists (select 1 from jsonb_array_elements(p_add || p_remove) photo
        where jsonb_typeof(photo) <> 'string' or (photo #>> '{}') !~ '^https://[^[:space:]]+$') then
        raise exception 'Photo deltas must contain HTTPS URLs';
    end if;
    select * into existing from public.work_orders
    where id = p_order_id and user_id = owner_id for update;
    if not found then raise exception 'Order not found or not owned' using errcode = '42501'; end if;
    photos := coalesce(nullif(to_jsonb(existing) -> 'fotos', 'null'::jsonb), '[]'::jsonb);
    if jsonb_typeof(photos) <> 'array' then raise exception 'Existing photos are not an array'; end if;
    if jsonb_array_length(p_add) = 0 and jsonb_array_length(p_remove) = 0 then
        return photos; -- Read-only capability/owner check before a browser uploads any files.
    end if;
    if jsonb_array_length(p_add) > 0 and existing.status = 'Finalizada' then
        raise exception 'Cannot add photos to a completed order';
    end if;
    -- Compute from the locked current value, not a browser snapshot. Retry adds are idempotent.
    select coalesce(jsonb_agg(value order by position), '[]'::jsonb) into merged
    from (
        select value, min(ordinality) as position
        from jsonb_array_elements_text(photos || p_add) with ordinality
        where value not in (select jsonb_array_elements_text(p_remove))
        group by value
    ) distinct_photos;
    update public.work_orders
    set fotos = (jsonb_populate_record(null::public.work_orders, jsonb_build_object('fotos', merged))).fotos
    where id = p_order_id and user_id = owner_id;
    if not found then raise exception 'Photo update was rejected'; end if;
    return merged;
end;
$function$;

-- Restrict only these exact signatures. SECURITY INVOKER preserves the caller's table/RLS checks.
revoke all on function public.restore_work_orders(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.change_order_photos(uuid, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.restore_work_orders(jsonb, uuid) to authenticated;
grant execute on function public.change_order_photos(uuid, jsonb, jsonb, uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
