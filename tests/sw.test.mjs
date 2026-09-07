import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function worker() {
    const handlers = {};
    const entries = new Map();
    const deleted = [];
    const requests = [];
    let network = async () => new Response('new shell');
    let cacheWriteFails = false;
    let cdnFails = false;
    const cache = {
        match: async key => entries.get(key)?.clone(),
        put: async (key, value) => {
            if (cacheWriteFails) throw new Error('Quota exceeded');
            entries.set(key, value.clone());
        },
        addAll: async values => { requests.push(...values); },
        add: async value => { requests.push(value); if (cdnFails) throw new Error('CDN unavailable'); }
    };
    const sandbox = vm.createContext({
        self: { registration: { scope: 'https://example.test/taller/' },
            clients: { claim: async () => {} }, addEventListener: (type, handler) => { handlers[type] = handler; } },
        caches: { open: async () => cache, keys: async () => [
            'taller-ot-v1', 'taller-ot:https://example.test/taller/:v1',
            'taller-ot:https://example.test/taller/:v2', 'unrelated-cache'
        ], delete: async name => { deleted.push(name); } },
        fetch: async (...args) => { requests.push(args); return network(...args); }, URL, Request, Response
    });
    vm.runInContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), sandbox);
    return {
        entries, deleted, requests,
        network(handler) { network = handler; },
        failCacheWrites() { cacheWriteFails = true; },
        failCDN() { cdnFails = true; },
        dispatch(type, request) {
            let result;
            handlers[type]({ request, respondWith: value => { result = value; }, waitUntil: value => { result = value; } });
            return result;
        }
    };
}

const shell = 'https://example.test/taller/index.html';
const navigate = url => ({ method: 'GET', mode: 'navigate', url });

test('installation reloads local shell assets and tolerates optional CDN failure', async () => {
    const sw = worker();
    sw.failCDN();
    await sw.dispatch('install');
    assert.deepEqual(sw.requests.slice(0, 3).map(request => request.url),
        [shell, 'https://example.test/taller/manifest.json', 'https://example.test/taller/icon.png']);
    assert.ok(sw.requests.slice(0, 3).every(request => request.cache === 'reload'));
});

test('real worker fetches and caches updated HTML even when an old shell exists', async () => {
    const sw = worker();
    sw.entries.set(shell, new Response('old shell'));
    const response = await sw.dispatch('fetch', navigate(shell));
    assert.equal(await response.text(), 'new shell');
    assert.equal(await sw.entries.get(shell).clone().text(), 'new shell');
    assert.equal(sw.requests.length, 1);
});

test('root and customer-link navigations fall back to canonical shell while offline', async () => {
    const sw = worker();
    sw.entries.set(shell, new Response('offline shell'));
    sw.network(async () => { throw new Error('Offline'); });
    for (const url of ['https://example.test/taller/', shell + '?id=order']) {
        assert.equal(await (await sw.dispatch('fetch', navigate(url))).text(), 'offline shell');
    }
});

test('worker never intercepts backend, other pages, or mutation requests', () => {
    const sw = worker();
    for (const request of [
        { method: 'GET', url: 'https://project.supabase.co/rest/v1/work_orders' },
        { method: 'POST', url: shell }, navigate('https://example.test/other/index.html')
    ]) assert.equal(sw.dispatch('fetch', request), undefined);
});

test('activation removes obsolete app caches but preserves unrelated and current caches', async () => {
    const sw = worker();
    await sw.dispatch('activate');
    assert.deepEqual(sw.deleted, ['taller-ot-v1', 'taller-ot:https://example.test/taller/:v1']);
});

test('network success survives cache-write failure; HTTP failure uses offline shell', async () => {
    const sw = worker();
    sw.failCacheWrites();
    assert.equal(await (await sw.dispatch('fetch', navigate(shell))).text(), 'new shell');
    sw.entries.set(shell, new Response('last working shell'));
    sw.network(async () => new Response('Unavailable', { status: 503 }));
    assert.equal(await (await sw.dispatch('fetch', navigate(shell))).text(), 'last working shell');
});
