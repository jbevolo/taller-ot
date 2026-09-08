import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, deferred, order, USER_A, USER_B } from './browser-harness.mjs';

test('account transition clears sensitive state and rejects a stale order response', async () => {
    const app = await createApp();
    app.login(USER_A);
    app.set('allOrders', [order()]);
    app.set('selectedFotosFiles', [{ name: 'private.jpg' }]);
    app.set('morePhotosToUpload', [{ name: 'private-extra.jpg' }]);
    app.get('nombre').value = 'Private draft';
    app.evaluate('renderOrders()');

    const pending = deferred();
    app.client.from = () => ({
        select() { return this; },
        eq() { return this; },
        order: () => pending.promise
    });
    const request = app.evaluate('fetchOrders()');

    app.client.auth.handler('SIGNED_IN', { user: { id: USER_B } });
    assert.equal(app.evaluate('allOrders.length'), 0);
    assert.equal(app.evaluate('selectedFotosFiles.length'), 0);
    assert.equal(app.evaluate('morePhotosToUpload.length'), 0);
    assert.equal(app.get('nombre').value, '');
    assert.equal(app.get('orders-table-body').innerHTML, '');
    assert.equal(app.get('app-container').classList.contains('hidden'), true);

    app.login(USER_B);
    pending.resolve({ data: [order()], error: null });
    assert.equal(await request, false);
    assert.equal(app.evaluate('allOrders.length'), 0);
    assert.equal(app.get('orders-table-body').innerHTML, '');
});

test('sign-out clears visible state immediately and rejects a late order response', async () => {
    const app = await createApp();
    app.login(USER_A);
    app.set('allOrders', [order()]);
    app.evaluate('renderOrders()');

    const pending = deferred();
    app.client.from = () => ({
        select() { return this; },
        eq() { return this; },
        order: () => pending.promise
    });
    const request = app.evaluate('fetchOrders()');
    await app.get('logout-btn').click();

    assert.equal(app.evaluate('currentUser'), null);
    assert.equal(app.evaluate('allOrders.length'), 0);
    assert.equal(app.get('orders-table-body').innerHTML, '');
    pending.resolve({ data: [order()], error: null });
    assert.equal(await request, false);
    assert.equal(app.evaluate('allOrders.length'), 0);
});

test('stored payloads remain inert in table, detail, public, notification, and print paths', async () => {
    const app = await createApp();
    app.login();
    const payload = `</td><img src=x onerror="globalThis.auditMarker=1"><script>alert('xss')</script>'"`;
    const malicious = order(Object.fromEntries([
        'nombre', 'telefono', 'vehiculo', 'dominio', 'novedades', 'forma_pago', 'notas_extra'
    ].map(field => [field, payload])));
    malicious.status = 'Finalizada';
    malicious.monto_cobrado = payload;
    malicious.fotos = [
        `https://example.test/photo.jpg' onerror='alert(1)`,
        'javascript:alert(1)'
    ];

    app.set('allOrders', [malicious]);
    app.set('testOrder', malicious);
    app.evaluate('renderOrders(); viewOrder(testOrder); printWorkOrder(testOrder)');

    const rendered = [
        app.get('orders-table-body').children[0].innerHTML,
        app.get('view-order-content').innerHTML,
        app.calls.print.join('')
    ];
    for (const html of rendered) {
        assert.ok(!html.includes(payload));
        assert.ok(!html.includes('<script>alert'));
        assert.ok(html.includes('&lt;'));
        assert.ok(html.includes('&quot;'));
        assert.ok(html.includes('&#39;'));
    }

    const gallery = app.get('detail-gallery');
    assert.equal(gallery.children.length, 2);
    assert.equal(gallery.children[1].children[0].src, '');
    assert.equal(typeof gallery.children[0].children[0].onclick, 'function');

    app.client.from = () => ({
        select() { return this; },
        eq() { return this; },
        single: async () => ({ data: malicious, error: null })
    });
    await app.evaluate(`showPublicOrderView('${malicious.id}')`);
    assert.equal(app.get('pub-trabajos').textContent, payload);
    assert.equal(app.get('pub-notas').textContent, payload);

    app.set('testPayload', payload);
    app.evaluate('showNotification(testPayload); showPublicError(testPayload)');
    assert.equal(app.get('notification-message').textContent, payload);
    assert.ok(!app.get('public-container').innerHTML.includes(payload));
    assert.ok(app.get('public-container').innerHTML.includes('&lt;script&gt;'));
});
