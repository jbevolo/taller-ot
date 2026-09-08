import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const USER_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const currentOrder = (overrides = {}) => ({
    id: ORDER_ID,
    user_id: USER_A,
    order_number: 1,
    fecha: '2026-05-13',
    nombre: 'Customer',
    telefono: '12345678',
    vehiculo: 'Car',
    dominio: 'AAA123',
    novedades: 'Repair brakes',
    garantia: false,
    oblea: false,
    ph: false,
    nv: false,
    retencion: false,
    mangueras: false,
    fotos: [],
    status: 'Abierta',
    monto_cobrado: null,
    forma_pago: '',
    notas_extra: '',
    created_at: '2026-05-13T14:50:00.000Z',
    ...overrides
});

function restoreSource() {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const start = html.indexOf('        const MAX_BACKUP_BYTES');
    const normalizationEnd = html.indexOf('        // --- EVENT LISTENERS: BACKUP/RESTORE ---', start);
    const restoreStart = html.indexOf('        let restoreInProgress = false;', normalizationEnd);
    const restoreEnd = html.indexOf('        // --- NOTIFICACIONES ---', restoreStart);
    assert.ok(start > 0 && normalizationEnd > start && restoreStart > normalizationEnd && restoreEnd > restoreStart,
        'restore functions must remain discoverable in the real inline application source');
    return html.slice(start, normalizationEnd) + html.slice(restoreStart, restoreEnd);
}

function createRestoreApp(rpcResult = { data: 1, error: null }) {
    const calls = { rpc: [], from: 0, notifications: [], fetches: 0 };
    const sandbox = vm.createContext({
        crypto: webcrypto,
        TextEncoder,
        currentUser: { id: USER_A },
        console: { error() {} },
        showNotification(message) { calls.notifications.push(message); },
        async fetchOrders() { calls.fetches++; },
        supabaseClient: {
            async rpc(name, args) { calls.rpc.push({ name, args }); return rpcResult; },
            from() { calls.from++; throw new Error('restore must not use direct table operations'); }
        }
    });
    vm.runInContext(restoreSource(), sandbox, { filename: 'index.html restore source' });
    return {
        calls,
        evaluate(expression, value) {
            sandbox.testValue = value;
            return vm.runInContext(expression, sandbox);
        }
    };
}

test('real current source normalizes current exports and bundled legacy aliases', () => {
    const app = createRestoreApp();
    const current = app.evaluate(`normalizeBackup(testValue, '${USER_A}')`, [currentOrder()]);
    assert.equal(current[0].id, ORDER_ID);
    assert.equal(current[0].created_at, '2026-05-13T14:50:00.000Z');

    const sample = JSON.parse(readFileSync(new URL('../sample_backup.json', import.meta.url), 'utf8'));
    const legacy = app.evaluate(`normalizeBackup(testValue, '${USER_A}')`, sample);
    assert.equal(legacy[0].order_number, 100);
    assert.equal(legacy[0].created_at, '2026-05-13T14:50:00.000Z');
    assert.match(legacy[0].id, /^[0-9a-f-]{36}$/);
    assert.equal(legacy[0].user_id, USER_A);
    assert.equal(legacy[0].orderNumber, undefined);
    assert.equal(legacy[0].createdAt, undefined);
});

test('real current source rejects dangerous backup shapes before RPC invocation', async () => {
    const app = createRestoreApp();
    const invalid = [
        [],
        [null],
        [currentOrder({ injected_column: 'danger' })],
        [currentOrder({ user_id: USER_B })],
        [currentOrder(), currentOrder()],
        [currentOrder({ id: 'not-a-uuid' })],
        [currentOrder({ fecha: '2026-02-30' })],
        [currentOrder({ fotos: 'https://example.test/photo.jpg' })],
        [currentOrder({ fotos: ['javascript:alert(1)'] })]
    ];
    for (const backup of invalid) {
        await app.evaluate(`restoreToCloud(testValue, '${USER_A}')`, backup);
    }
    const oversized = [currentOrder({ novedades: 'x'.repeat(20 * 1024 * 1024) })];
    await app.evaluate(`restoreToCloud(testValue, '${USER_A}')`, oversized);
    assert.equal(app.calls.rpc.length, 0);
    assert.equal(app.calls.from, 0);
    assert.ok(app.calls.notifications.some(message => /campo|usuario|duplicado|UUID|fecha|fotos|HTTPS|20 MiB/.test(message)));
});

test('restore preserves UUIDs, invokes only the owner RPC, and fails closed when it is unavailable', async () => {
    const app = createRestoreApp({ data: null, error: { code: 'PGRST202', message: 'Function missing' } });
    await app.evaluate(`restoreToCloud(testValue, '${USER_A}')`, [currentOrder()]);
    assert.equal(app.calls.rpc.length, 1);
    assert.equal(app.calls.rpc[0].name, 'restore_work_orders');
    assert.equal(app.calls.rpc[0].args.p_user_id, USER_A);
    assert.equal(app.calls.rpc[0].args.p_orders[0].id, ORDER_ID);
    assert.equal(app.calls.from, 0);
    assert.equal(app.calls.fetches, 0);
    assert.match(app.calls.notifications.at(-1), /no está disponible/);
});

test('restore refuses a captured backup after the signed-in owner changes', async () => {
    const app = createRestoreApp();
    app.evaluate(`currentUser = { id: '${USER_B}' }`);
    await app.evaluate(`restoreToCloud(testValue, '${USER_A}')`, [currentOrder()]);
    assert.equal(app.calls.rpc.length, 0);
    assert.match(app.calls.notifications.at(-1), /sesión cambió/);
});
