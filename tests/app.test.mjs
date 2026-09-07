import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp, deferred, order, USER_A, USER_B, ORDER_ID } from './browser-harness.mjs';

test('restore rejects malformed, empty, foreign-owner, duplicate and invalid-date backups before any RPC', async () => {
    const app = await createApp();
    app.login();
    for (const data of [[null], [], [order({ user_id: USER_B })], [order(), order()],
        [order({ fecha: '2026-02-30' })], [order({ fotos: ['javascript:alert(1)'] })]]) {
        app.set('testBackup', data);
        await app.evaluate('restoreToCloud(testBackup)');
    }
    assert.equal(app.calls.rpc.length, 0);
    assert.equal(app.calls.query.length, 0);
});

test('restore preserves UUIDs and uses only one owner-bound RPC; missing migration never deletes', async () => {
    const app = await createApp();
    app.login();
    app.client.rpc = async (name, args) => {
        app.calls.rpc.push({ name, args });
        return { error: { code: 'PGRST202', message: 'Function missing' } };
    };
    app.set('testBackup', [order()]);
    await app.evaluate('restoreToCloud(testBackup)');
    assert.equal(app.calls.rpc.length, 1);
    assert.equal(app.calls.rpc[0].name, 'restore_work_orders');
    assert.equal(app.calls.rpc[0].args.p_orders[0].id, ORDER_ID);
    assert.equal(app.calls.rpc[0].args.p_user_id, USER_A);
    assert.equal(app.calls.query.length, 0);
    assert.match(app.get('notification-message').textContent, /no confirmada/);
});

test('legacy sample is normalized without forwarding legacy column names', async () => {
    const app = await createApp();
    app.login();
    app.set('testBackup', JSON.parse(readFileSync(new URL('../sample_backup.json', import.meta.url))));
    const [normalized] = app.evaluate(`normalizeBackup(testBackup, '${USER_A}')`);
    assert.equal(normalized.order_number, 100);
    assert.equal(normalized.created_at, '2026-05-13T14:50:00.000Z');
    assert.match(normalized.id, /^[a-f0-9-]{36}$/);
    assert.equal(normalized.user_id, USER_A);
    assert.equal(normalized.orderNumber, undefined);
    assert.equal(normalized.createdAt, undefined);
});

test('restore cannot cross an account transition during file confirmation', async () => {
    const app = await createApp();
    app.login();
    app.set('testBackup', [order()]);
    app.set('oldContext', app.evaluate('accountContext()'));
    app.evaluate('clearAccountState()');
    app.login(USER_B);
    await app.evaluate('restoreToCloud(testBackup, oldContext)');
    assert.equal(app.calls.rpc.length, 0);
});

test('real table/detail/print/public/error rendering keeps malicious order fields inert', async () => {
    const app = await createApp();
    app.login();
    const payload = '<img src=x onerror="globalThis.auditMarker=1">';
    const malicious = order(Object.fromEntries(['nombre', 'vehiculo', 'dominio', 'novedades',
        'telefono', 'notas_extra', 'forma_pago'].map(field => [field, payload])));
    malicious.status = 'Finalizada';
    malicious.fotos = ['https://example.test/a\' onclick=\'alert(1)', 'javascript:alert(1)'];
    app.set('testOrder', malicious);
    app.set('allOrders', [malicious]);
    app.evaluate('renderOrders(); viewOrder(testOrder); printWorkOrder(testOrder)');
    for (const html of [app.get('orders-table-body').children[0].innerHTML,
        app.get('view-order-content').innerHTML, app.calls.print.join('')]) {
        assert.ok(!html.includes(payload));
        assert.ok(html.includes('&lt;img'));
    }
    const gallery = app.get('detail-gallery');
    assert.equal(gallery.children.length, 2);
    assert.equal(gallery.children[1].children[0].src, '');
    assert.equal(typeof gallery.children[0].children[0].onclick, 'function');
    app.client.from = () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: malicious }) });
    await app.evaluate(`showPublicOrderView('${ORDER_ID}')`);
    assert.equal(app.get('pub-trabajos').textContent, payload);
    app.set('testPayload', payload);
    app.evaluate('showNotification(testPayload); showPublicError(testPayload)');
    assert.equal(app.get('notification-message').textContent, payload);
    assert.ok(!app.get('public-container').innerHTML.includes(payload));
});

test('logout clears account UI, draft, photos and exports; late fetch cannot repopulate', async () => {
    const app = await createApp();
    app.login();
    const pending = deferred();
    app.client.from = () => ({ select() { return this; }, eq() { return this; },
        order() { return this; }, range: () => pending.promise });
    app.set('allOrders', [order()]);
    app.set('selectedFotosFiles', [{ name: 'private.jpg' }]);
    app.get('nombre').value = 'Private draft';
    app.evaluate('renderOrders()');
    const request = app.evaluate('fetchOrders()');
    await app.get('logout-btn').click();
    assert.equal(app.evaluate('allOrders.length'), 0);
    assert.equal(app.evaluate('selectedFotosFiles.length'), 0);
    assert.equal(app.get('nombre').value, '');
    assert.equal(app.get('orders-table-body').innerHTML, '');
    app.login(USER_B);
    app.evaluate('ordersReady = false');
    pending.resolve({ data: [order()], error: null });
    assert.equal(await request, false);
    assert.equal(app.evaluate('allOrders.length'), 0);
    await app.get('backup-btn').click();
    assert.match(app.get('notification-message').textContent, /Espera/);
});

test('auth event clears synchronously and defers auth calls outside the SDK callback', async () => {
    const app = await createApp();
    app.login();
    app.set('allOrders', [order()]);
    let authCalls = 0;
    app.client.auth.getUser = async () => { authCalls++; return { data: { user: { id: USER_B } } }; };
    app.client.auth.handler('SIGNED_IN', { user: { id: USER_B } });
    assert.equal(authCalls, 0);
    assert.equal(app.evaluate('allOrders.length'), 0);
    assert.equal(app.get('app-container').classList.contains('hidden'), true);
    await [...app.timers.values()].at(-1)();
    assert.equal(authCalls, 1);
});

test('camera cancellation/reopen never changes new-order routing or duplicates file processing', async () => {
    const app = await createApp();
    app.login();
    app.set('testOrder', order());
    app.evaluate('setupAddMorePhotos(testOrder)');
    await app.get('open-add-more-camera-modal').click();
    await app.get('camera-cancel-btn').click();
    await app.get('open-add-more-camera-modal').click();
    await app.get('camera-gallery-btn').click();
    const extra = app.get('add-more-input-gallery');
    await extra.dispatch('change', { target: { files: [{ name: 'extra.jpg' }], value: '' } });
    assert.equal(app.evaluate('morePhotosToUpload.length'), 1);
    await app.get('open-camera-modal').click();
    await app.get('camera-gallery-btn').click();
    assert.equal(app.get('fotos-input-gallery').clicks, 1);
    assert.equal(extra.clicks, 1);
    await app.get('fotos-input-gallery').dispatch('change', { target: { files: [{ name: 'new.jpg' }], value: '' } });
    assert.equal(app.evaluate('selectedFotosFiles.length'), 1);
    assert.equal(app.evaluate('morePhotosToUpload.length'), 1);
});

test('missing photo RPC fails before uploading; storage failure retains selection and compensates successes', async () => {
    const app = await createApp();
    app.login();
    app.set('testOrder', order());
    app.evaluate('setupAddMorePhotos(testOrder)');
    app.set('morePhotosToUpload', [{ blob: new Blob(['a']) }, { blob: new Blob(['b']) }]);
    app.client.rpc = async () => ({ error: { message: 'Function missing' } });
    await app.get('upload-more-btn').click();
    assert.equal(app.calls.upload.length, 0);
    app.client.rpc = async (name, args) => { app.calls.rpc.push({ name, args }); return { data: [], error: null }; };
    const originalStorage = app.client.storage.from;
    app.client.storage.from = () => ({ ...originalStorage(), upload: async path => {
        app.calls.upload.push(path);
        return app.calls.upload.length === 1 ? { data: { path } } : { data: null, error: { message: 'Upload failed' } };
    } });
    await app.get('upload-more-btn').click();
    assert.equal(app.calls.rpc.length, 1); // Probe only; no photo mutation after failure.
    assert.equal(app.calls.remove.length, 1);
    assert.equal(app.calls.remove[0].length, 1);
    assert.equal(app.evaluate('morePhotosToUpload.length'), 2);
    assert.equal(app.evaluate('morePhotosToUpload[0].uploadedUrl'), undefined);
    assert.match(app.get('notification-message').textContent, /No se completó/);
});

test('uncertain photo RPC keeps uploaded URLs for idempotent retry and sends deltas, not stale snapshots', async () => {
    const app = await createApp();
    app.login();
    app.set('testOrder', order({ fotos: ['https://example.test/base.jpg'] }));
    app.evaluate('setupAddMorePhotos(testOrder)');
    app.set('morePhotosToUpload', [{ blob: new Blob(['a']) }]);
    let fail = true;
    app.client.rpc = async (name, args) => {
        app.calls.rpc.push({ name, args });
        return { data: [], error: args.p_add.length && fail ? { message: 'Connection lost' } : null };
    };
    await app.get('upload-more-btn').click();
    assert.equal(app.calls.remove.length, 0);
    assert.equal(app.calls.upload.length, 1);
    fail = false;
    await app.get('upload-more-btn').click();
    assert.equal(app.calls.upload.length, 1);
    const deltas = app.calls.rpc.filter(call => call.args.p_add.length);
    assert.equal(deltas.length, 2);
    assert.equal(deltas[0].args.p_add[0], deltas[1].args.p_add[0]);
    assert.equal(deltas[0].args.p_add.length, 1);
    assert.equal(app.evaluate('morePhotosToUpload.length'), 0);
    assert.match(app.get('notification-message').textContent, /éxito/);
});

test('photo removal sends an owner-bound delta and never deletes backup-shared storage objects', async () => {
    const app = await createApp();
    app.login();
    await app.evaluate(`deleteSpecificPhoto('${ORDER_ID}', 'https://example.test/photo.jpg', 0)`);
    await app.get('modal-buttons').children[0].click();
    assert.equal(app.calls.rpc[0].name, 'change_order_photos');
    assert.equal(app.calls.rpc[0].args.p_remove[0], 'https://example.test/photo.jpg');
    assert.equal(app.calls.rpc[0].args.p_add.length, 0);
    assert.equal(app.calls.remove.length, 0);
});

test('order fetching respects owner and follows a server cap smaller than the requested page', async () => {
    const app = await createApp();
    app.login();
    let page = 0;
    const ranges = [];
    const filters = [];
    app.client.from = () => ({ select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
        order() { return this; }, range: async (start, end) => {
            ranges.push([start, end]);
            return { data: page++ < 2 ? [order({ order_number: page })] : [], error: null };
        } });
    assert.equal(await app.evaluate('fetchOrders()'), true);
    assert.equal(app.evaluate('allOrders.length'), 2);
    assert.deepEqual(ranges.map(range => range[0]), [0, 1, 2]);
    assert.ok(filters.every(([key, value]) => key === 'user_id' && value === USER_A));
});

test('new-order upload captures its owner and cannot insert after the account changes', async () => {
    const app = await createApp();
    app.login();
    for (const [id, value] of Object.entries({ 'order-number': '2', fecha: '2026-05-13',
        nombre: 'A private draft', vehiculo: 'Car', dominio: 'AAA123', novedades: 'Repair' })) {
        app.get(id).value = value;
    }
    app.set('selectedFotosFiles', [{ blob: new Blob(['private photo']) }]);
    const upload = deferred();
    const originalStorage = app.client.storage.from;
    let path;
    app.client.storage.from = () => ({ ...originalStorage(), upload: value => { path = value; return upload.promise; } });
    const saving = app.get('work-order-form').dispatch('submit');
    assert.ok(path.startsWith(USER_A + '/'));
    app.evaluate('clearAccountState()');
    app.login(USER_B);
    app.get('nombre').value = 'B new draft';
    upload.resolve({ data: { path }, error: null });
    await saving;
    assert.equal(app.calls.query.length, 0);
    assert.equal(app.get('nombre').value, 'B new draft');
    assert.equal(app.get('save-btn').disabled, false);
});

test('new-order submission still inserts its captured form and uploaded URLs on success', async () => {
    const app = await createApp();
    app.login();
    for (const [id, value] of Object.entries({ 'order-number': '2', fecha: '2026-05-13',
        nombre: 'Customer', vehiculo: 'Car', dominio: 'aaa123', novedades: 'Repair' })) {
        app.get(id).value = value;
    }
    app.set('selectedFotosFiles', [{ blob: new Blob(['photo']) }]);
    await app.get('work-order-form').dispatch('submit');
    const inserted = app.calls.query.find(call => call.insert).insert[0];
    assert.equal(inserted.user_id, USER_A);
    assert.equal(inserted.order_number, 2);
    assert.equal(inserted.dominio, 'AAA123');
    assert.equal(inserted.fotos.length, 1);
    assert.match(inserted.fotos[0], /^https:/);
    assert.equal(app.evaluate('selectedFotosFiles.length'), 0);
});
