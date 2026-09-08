import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, ORDER_ID } from './browser-harness.mjs';

const files = count => Array.from({ length: count }, (_, index) => ({
    blob: new Blob([`photo-${index}`]),
    name: `photo-${index}.jpg`
}));

function installStorage(app, uploadResults, removeResult = { error: null }) {
    const calls = { uploads: [], removals: [] };
    app.client.storage.from = () => ({
        async upload(path, blob, options) {
            calls.uploads.push({ path, blob, options });
            const result = uploadResults.shift();
            return typeof result === 'function' ? result(path) : result;
        },
        getPublicUrl(path) {
            return { data: { publicUrl: `https://example.test/photos/${path}` } };
        },
        async remove(paths) {
            calls.removals.push(paths);
            return removeResult;
        }
    });
    return calls;
}

async function addPhotos(app, selected) {
    app.set('testValue', selected);
    return app.evaluate(`addOrderPhotos('${ORDER_ID}', testValue, accountContext())`);
}

test('successful uploads persist one atomic photo delta', async () => {
    const app = await createApp();
    app.login();
    const storage = installStorage(app, [
        path => ({ data: { path }, error: null }),
        path => ({ data: { path }, error: null })
    ]);
    const rpcCalls = [];
    app.client.rpc = async (name, args) => {
        rpcCalls.push({ name, args });
        return { data: args.p_add, error: null };
    };

    const urls = await addPhotos(app, files(2));

    assert.equal(storage.uploads.length, 2);
    assert.equal(rpcCalls.length, 2);
    assert.deepEqual([...rpcCalls[0].args.p_add], []);
    assert.deepEqual([...rpcCalls[0].args.p_remove], []);
    assert.equal(rpcCalls[1].name, 'change_order_photos');
    assert.deepEqual([...rpcCalls[1].args.p_add], [...urls]);
    assert.deepEqual([...rpcCalls[1].args.p_remove], []);
    assert.equal(app.calls.queries.length, 0, 'photo arrays must not use direct table updates');
});

test('a second upload failure compensates only the first upload from that operation', async () => {
    const app = await createApp();
    app.login();
    const selected = files(2);
    const storage = installStorage(app, [
        path => ({ data: { path }, error: null }),
        { data: null, error: { message: 'second upload rejected' } }
    ]);

    await assert.rejects(addPhotos(app, selected), error => {
        assert.equal(error.photoFailure, 'upload');
        assert.equal(error.cleanupFailed, false);
        app.set('testValue', error);
        assert.match(app.evaluate('photoFailureMessage(testValue)'), /Falló la subida de fotos/);
        return true;
    });
    assert.equal(storage.removals.length, 1);
    assert.equal(storage.removals[0].length, 1);
    assert.equal(selected[0].uploadedUrl, undefined);
});

test('a thrown upload compensates its known generated path', async () => {
    const app = await createApp();
    app.login();
    const selected = files(1);
    const storage = installStorage(app, [() => { throw new Error('connection reset'); }]);

    await assert.rejects(addPhotos(app, selected), error => {
        assert.equal(error.photoFailure, 'upload');
        assert.equal(error.cleanupFailed, false);
        return true;
    });
    assert.equal(storage.removals.length, 1);
    assert.equal(storage.removals[0].length, 1);
    assert.equal(selected[0].uploadedPath, undefined);
});

test('malformed upload responses compensate only each generated operation path', async () => {
    for (const response of [undefined, null, [], {}, { data: null, error: null }]) {
        const app = await createApp();
        app.login();
        const selected = files(1);
        const storage = installStorage(app, [response]);

        await assert.rejects(addPhotos(app, selected), error => {
            assert.equal(error.photoFailure, 'upload');
            assert.equal(error.cleanupFailed, false);
            return true;
        });
        const requestedPath = storage.uploads[0].path;
        assert.equal(storage.removals.length, 1);
        assert.deepEqual([...storage.removals[0]], [requestedPath]);
        assert.match(requestedPath, /^aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa\/[0-9a-f-]+\.jpg$/);
        assert.equal(selected[0].uploadedPath, undefined);
    }
});

test('a mismatched upload path compensates only the generated operation path', async () => {
    const app = await createApp();
    app.login();
    const selected = files(1);
    const returnedPath = 'another-owner/existing.jpg';
    const storage = installStorage(app, [() => ({ data: { path: returnedPath }, error: null })]);

    await assert.rejects(addPhotos(app, selected), error => {
        assert.equal(error.photoFailure, 'upload');
        assert.equal(error.cleanupFailed, false);
        return true;
    });
    const requestedPath = storage.uploads[0].path;
    assert.equal(storage.removals.length, 1);
    assert.deepEqual([...storage.removals[0]], [requestedPath]);
    assert.notEqual(requestedPath, returnedPath);
    assert.equal(selected[0].uploadedPath, undefined);
});

test('an invalid public URL compensates the successfully uploaded object', async () => {
    const app = await createApp();
    app.login();
    const selected = files(1);
    const storage = installStorage(app, [path => ({ data: { path }, error: null })]);
    app.client.storage.from = () => ({
        async upload(path, blob, options) {
            storage.uploads.push({ path, blob, options });
            return { data: { path }, error: null };
        },
        getPublicUrl() {
            return { data: { publicUrl: 'javascript:alert(1)' } };
        },
        async remove(paths) {
            storage.removals.push(paths);
            return { error: null };
        }
    });

    await assert.rejects(addPhotos(app, selected), error => {
        assert.equal(error.photoFailure, 'upload');
        assert.equal(error.cleanupFailed, false);
        return true;
    });
    assert.equal(storage.removals.length, 1);
    assert.equal(storage.removals[0].length, 1);
    assert.equal(selected[0].uploadedPath, undefined);
});

test('a confirmed RPC rejection compensates newly uploaded objects', async () => {
    const app = await createApp();
    app.login();
    const storage = installStorage(app, [path => ({ data: { path }, error: null })]);
    let rpcCall = 0;
    app.client.rpc = async () => ++rpcCall === 1
        ? { data: [], error: null }
        : { data: null, error: { message: 'delta rejected' } };

    await assert.rejects(addPhotos(app, files(1)), error => {
        assert.equal(error.photoFailure, 'persistence');
        assert.equal(error.ambiguous, false);
        assert.equal(error.cleanupFailed, false);
        app.set('testValue', error);
        assert.match(app.evaluate('photoFailureMessage(testValue)'), /Falló la persistencia de las fotos/);
        return true;
    });
    assert.equal(storage.removals.length, 1);
});

test('failed compensation is surfaced as a partial failure', async () => {
    const app = await createApp();
    app.login();
    const storage = installStorage(
        app,
        [path => ({ data: { path }, error: null })],
        { error: { message: 'cleanup rejected' } }
    );
    let rpcCall = 0;
    app.client.rpc = async () => ++rpcCall === 1
        ? { data: [], error: null }
        : { data: null, error: { message: 'delta rejected' } };

    await assert.rejects(addPhotos(app, files(1)), error => {
        assert.equal(error.cleanupFailed, true);
        app.set('testValue', error);
        assert.match(app.evaluate('photoFailureMessage(testValue)'), /compensación falló parcialmente/);
        return true;
    });
    assert.equal(storage.removals.length, 1);
});

test('an ambiguous RPC result retains uploaded objects and retry metadata', async () => {
    const app = await createApp();
    app.login();
    const selected = files(1);
    const storage = installStorage(app, [path => ({ data: { path }, error: null })]);
    let rpcCall = 0;
    app.client.rpc = async () => {
        if (++rpcCall === 1) return { data: [], error: null };
        throw new Error('connection lost after request');
    };

    await assert.rejects(addPhotos(app, selected), error => {
        assert.equal(error.ambiguous, true);
        app.set('testValue', error);
        assert.match(app.evaluate('photoFailureMessage(testValue)'), /objetos se conservaron/);
        return true;
    });
    assert.equal(storage.removals.length, 0);
    assert.match(selected[0].uploadedUrl, /^https:/);
});

test('invalid successful RPC data is ambiguous and retains uploads for retry', async () => {
    for (const invalidData of [null, {}, ['javascript:alert(1)']]) {
        const app = await createApp();
        app.login();
        const selected = files(1);
        const storage = installStorage(app, [path => ({ data: { path }, error: null })]);
        let rpcCall = 0;
        app.client.rpc = async () => ++rpcCall === 1
            ? { data: [], error: null }
            : { data: invalidData, error: null };

        await assert.rejects(addPhotos(app, selected), error => {
            assert.equal(error.photoFailure, 'persistence');
            assert.equal(error.ambiguous, true);
            app.set('testValue', error);
            assert.match(app.evaluate('photoFailureMessage(testValue)'), /objetos se conservaron/);
            return true;
        });
        assert.equal(storage.removals.length, 0);
        assert.match(selected[0].uploadedPath, /^aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa\//);
        assert.match(selected[0].uploadedUrl, /^https:/);
    }
});

test('photo removal uses an atomic delta and retains the Storage object', async () => {
    const app = await createApp();
    app.login();
    const storage = installStorage(app, []);
    const rpcCalls = [];
    app.client.rpc = async (name, args) => {
        rpcCalls.push({ name, args });
        return { data: [], error: null };
    };
    const photoUrl = 'https://example.test/photos/existing.jpg';

    await app.evaluate(`deleteSpecificPhoto('${ORDER_ID}', '${photoUrl}', 0)`);
    await app.get('modal-buttons').children[0].click();

    assert.deepEqual([...rpcCalls[0].args.p_add], []);
    assert.deepEqual([...rpcCalls[0].args.p_remove], [photoUrl]);
    assert.equal(storage.removals.length, 0);
});

test('new-order persistence rejection compensates its uploads', async () => {
    const app = await createApp();
    app.login();
    const storage = installStorage(app, [path => ({ data: { path }, error: null })]);
    app.set('selectedFotosFiles', files(1));
    app.client.from = () => ({ insert: async () => ({ error: { message: 'insert rejected' } }) });

    await app.get('work-order-form').dispatch('submit');

    assert.equal(storage.removals.length, 1);
    assert.match(app.get('notification-message').textContent, /Falló la persistencia de las fotos/);
});
