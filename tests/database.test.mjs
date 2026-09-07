import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { order, USER_A, USER_B, ORDER_ID } from './browser-harness.mjs';

const migration = readFileSync(new URL('../database/safe-order-operations.sql', import.meta.url), 'utf8');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${quote(JSON.stringify(value))}::jsonb`;
const asOwner = (sql, owner = USER_A) => `set role authenticated; set request.jwt.claim.sub = '${owner}'; ${sql}`;
const restore = (orders, owner = USER_A) => `select public.restore_work_orders(${json(orders)}, '${owner}');`;
const photos = (add = [], remove = [], id = ORDER_ID, owner = USER_A) =>
    `select public.change_order_photos('${id}', ${json(add)}, ${json(remove)}, '${owner}');`;

test('isolated PostgreSQL executes the real migration, rollback and concurrent RPCs', { timeout: 60000 }, async t => {
    for (const binary of ['initdb', 'pg_ctl', 'psql']) {
        try { execFileSync(binary, ['--version'], { stdio: 'pipe' }); }
        catch { t.skip(`${binary} unavailable; install PostgreSQL separately to run database tests`); return; }
    }
    // Always initialize our own private, disposable cluster. Never consume DATABASE_URL/PGHOST.
    const directory = mkdtempSync(join(tmpdir(), 'pg-'));
    const dataDirectory = join(directory, 'data');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith('PG') && key !== 'DATABASE_URL'));
    Object.assign(env, { PGHOST: directory, PGPORT: '55439', PGUSER: 'postgres',
        PGDATABASE: 'postgres', PGPASSFILE: '/dev/null', PGCONNECT_TIMEOUT: '5' });
    const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', directory, '-p', '55439', '-U', 'postgres', '-d', 'postgres'];
    const sql = input => execFileSync('psql', args, { input, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    function asyncSQL(input, ready) {
        const process = spawn('psql', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '', errors = '', announced = false;
        process.stdout.on('data', chunk => {
            output += chunk;
            if (!announced && output.includes('LOCK_HELD')) { announced = true; ready?.(); }
        });
        process.stderr.on('data', chunk => { errors += chunk; });
        process.stdin.end(input);
        return new Promise((resolve, reject) => {
            process.on('error', reject);
            process.on('exit', code => code === 0 ? resolve(output) : reject(new Error(errors)));
        });
    }
    let started = false;
    try {
        execFileSync('initdb', ['-D', dataDirectory, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'], { stdio: 'pipe', env });
        execFileSync('pg_ctl', ['-D', dataDirectory, '-l', join(directory, 'postgres.log'), '-o',
            `-F -k '${directory}' -p 55439 -c listen_addresses='' -c unix_socket_permissions=0700`, '-w', 'start'], { stdio: 'pipe', env });
        started = true;

        await t.test('preflight rejects absent schema rather than inventing tables', () => {
            assert.throws(() => sql(migration), /Existing public.work_orders/);
        });

        sql(`
            create role anon nologin;
            create role authenticated nologin;
            create schema auth;
            create function auth.uid() returns uuid language sql stable as
            $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
            grant usage on schema auth to authenticated, anon;
            create table public.work_orders (
                id uuid primary key default gen_random_uuid(), user_id uuid not null,
                order_number integer not null check (order_number > 0), fecha date not null,
                nombre text not null, telefono text, vehiculo text not null, dominio text not null,
                novedades text not null, garantia boolean default false, oblea boolean default false,
                ph boolean default false, nv boolean default false, retencion boolean default false,
                mangueras boolean default false, fotos jsonb, status text not null,
                monto_cobrado numeric check (monto_cobrado >= 0), forma_pago text, notas_extra text,
                created_at timestamptz default now()
            );
            alter table public.work_orders enable row level security;
            create policy owner_access on public.work_orders to authenticated
                using (user_id = auth.uid()) with check (user_id = auth.uid());
            grant select, insert, update, delete on public.work_orders to authenticated;
        `);

        await t.test('migration is idempotent and exposes only invoker RPCs to authenticated users', () => {
            const permissions = sql(`select relacl::text from pg_class where oid = 'public.work_orders'::regclass;`);
            sql(migration);
            sql(migration);
            assert.equal(sql(`select relacl::text from pg_class where oid = 'public.work_orders'::regclass;`), permissions);
            assert.equal(sql(`select bool_and(not prosecdef) from pg_proc
                where proname in ('restore_work_orders', 'change_order_photos');`), 't');
            assert.equal(sql(`select has_function_privilege('anon', 'public.restore_work_orders(jsonb,uuid)', 'execute');`), 'f');
            assert.equal(sql(`select has_function_privilege('anon', 'public.change_order_photos(uuid,jsonb,jsonb,uuid)', 'execute');`), 'f');
            assert.throws(() => sql(`set role anon; ${restore([order()])}`), /permission denied/);
            assert.throws(() => sql(`set role authenticated; ${restore([order()])}`), /owner mismatch/);
        });

        await t.test('restore preserves retained IDs, dependent rows, omitted defaults and other owners', () => {
            sql(asOwner(restore([order(), order({ id: '44444444-4444-4444-8444-444444444444', order_number: 2 })])));
            const other = order({ id: '22222222-2222-4222-8222-222222222222', user_id: USER_B });
            sql(asOwner(restore([other], USER_B), USER_B));
            sql(`create table order_notes (order_id uuid references work_orders(id) on delete cascade);
                insert into order_notes values ('${ORDER_ID}');`);
            sql(asOwner(restore([order({ nombre: 'Restored customer' })])));
            assert.equal(sql(`select nombre from work_orders where id = '${ORDER_ID}';`), 'Restored customer');
            assert.equal(sql('select count(*) from order_notes;'), '1');
            assert.equal(sql(`select count(*) from work_orders where user_id = '${USER_B}';`), '1');
            assert.equal(sql(`select count(*) from work_orders where user_id = '${USER_A}';`), '1');
            assert.equal(sql(`select created_at is not null from work_orders where id = '${ORDER_ID}';`), 't');
        });

        await t.test('malformed backup and late constraint failure leave the entire old dataset unchanged', () => {
            const before = sql('select jsonb_agg(to_jsonb(w) order by id) from work_orders w;');
            for (const invalid of [[null], [], [order({ user_id: USER_B })]]) {
                assert.throws(() => sql(asOwner(restore(invalid))));
                assert.equal(sql('select jsonb_agg(to_jsonb(w) order by id) from work_orders w;'), before);
            }
            // First upsert succeeds, second violates a real table constraint; both must roll back.
            const invalidSecond = order({ id: '33333333-3333-4333-8333-333333333333', order_number: 2, monto_cobrado: -1 });
            assert.throws(() => sql(asOwner(restore([order({ nombre: 'Must roll back' }), invalidSecond]))), /check constraint/);
            assert.equal(sql('select jsonb_agg(to_jsonb(w) order by id) from work_orders w;'), before);
        });

        await t.test('owner mismatch, foreign-ID collision and missing table privileges fail safely', () => {
            assert.throws(() => sql(asOwner(restore([order()], USER_B))), /owner mismatch/);
            assert.throws(() => sql(asOwner(restore([order({ id: '22222222-2222-4222-8222-222222222222' })]))));
            assert.throws(() => sql(asOwner(photos([], [], '22222222-2222-4222-8222-222222222222'))), /not found or not owned/);
            sql('revoke update on work_orders from authenticated;');
            assert.throws(() => sql(asOwner(restore([order()]))), /permission denied/);
            sql('grant update on work_orders to authenticated;');
        });

        await t.test('photo add retry is idempotent and removal keeps unrelated URLs', () => {
            const a = 'https://example.test/a.jpg', b = 'https://example.test/b.jpg';
            sql(asOwner(photos([a, b])));
            assert.deepEqual(JSON.parse(sql(asOwner(photos([a])))), [a, b]);
            assert.deepEqual(JSON.parse(sql(asOwner(photos([], [a])))), [b]);
        });

        await t.test('two actual database sessions serialize concurrent photo append and removal', async () => {
            sql(asOwner(restore([order({ fotos: ['https://example.test/base.jpg'] })])));
            let ready;
            const locked = new Promise(resolve => { ready = resolve; });
            const first = asyncSQL(`begin; ${asOwner(photos(['https://example.test/a.jpg'], ['https://example.test/base.jpg']))}
                \n\\echo LOCK_HELD\nselect pg_sleep(0.3); commit;`, ready);
            await Promise.race([locked, first.then(() => { throw new Error('Lock marker missing'); })]);
            const second = asyncSQL(asOwner(photos(['https://example.test/b.jpg'])));
            await Promise.all([first, second]);
            assert.deepEqual(JSON.parse(sql(asOwner(photos()))), ['https://example.test/a.jpg', 'https://example.test/b.jpg']);
        });

        await t.test('replacement lock serializes a concurrent photo change without losing the append', async () => {
            let ready;
            const locked = new Promise(resolve => { ready = resolve; });
            const first = asyncSQL(`begin; ${asOwner(restore([order()]))}
                \n\\echo LOCK_HELD\nselect pg_sleep(0.3); commit;`, ready);
            await Promise.race([locked, first.then(() => { throw new Error('Lock marker missing'); })]);
            const second = asyncSQL(asOwner(photos(['https://example.test/after-restore.jpg'])));
            await Promise.all([first, second]);
            assert.deepEqual(JSON.parse(sql(asOwner(photos()))), ['https://example.test/after-restore.jpg']);
        });

        await t.test('existing JSON and text-array photo schemas also work without schema conversion', () => {
            for (const type of ['json', 'text[]']) {
                sql(`alter table work_orders alter column fotos type ${type} using ${type === 'json' ? "'[]'::json" : "'{}'::text[]"};`);
                sql(migration);
                sql(asOwner(restore([order({ fotos: ['https://example.test/base.jpg'] })])));
                assert.deepEqual(JSON.parse(sql(asOwner(photos(['https://example.test/new.jpg'])))),
                    ['https://example.test/base.jpg', 'https://example.test/new.jpg']);
            }
        });

        await t.test('preflight refuses disabled RLS and unsupported photo types without changing data', () => {
            sql('alter table work_orders disable row level security;');
            assert.throws(() => sql(migration), /Enable and audit owner-scoped RLS/);
            sql('alter table work_orders enable row level security;');
            sql('alter table work_orders alter column fotos type text using fotos::text;');
            assert.throws(() => sql(migration), /Supported fotos types/);
            assert.equal(sql('select count(*) from work_orders;'), '2');
        });
    } finally {
        if (started) execFileSync('pg_ctl', ['-D', dataDirectory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe', env });
        rmSync(directory, { recursive: true, force: true });
    }
});
