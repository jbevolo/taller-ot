import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

export const USER_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
export const USER_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
export const ORDER_ID = '11111111-1111-4111-8111-111111111111';
export const order = (overrides = {}) => ({
    id: ORDER_ID, user_id: USER_A, order_number: 1, fecha: '2026-05-13',
    nombre: 'Customer', telefono: '12345678', vehiculo: 'Car', dominio: 'AAA123',
    novedades: 'Repair\nCheck brakes', status: 'Abierta', fotos: [], ...overrides
});

export function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

// The entire real inline application runs here. Only browser/network boundaries are doubled.
// This deliberately is not an HTML parser or a browser XSS execution test.
export async function createApp(overrides = {}) {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
    const elements = new Map();
    class Element {
        constructor(tag = 'div') {
            this.tagName = tag;
            this.children = [];
            this.listeners = {};
            this.value = '';
            this.checked = false;
            this.disabled = false;
            this.textContent = '';
            this.classes = new Set();
            this.classList = {
                add: name => this.classes.add(name), remove: name => this.classes.delete(name),
                contains: name => this.classes.has(name)
            };
        }
        set innerHTML(value) {
            this.html = value;
            this.children = [];
            for (const match of value.matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element());
        }
        get innerHTML() { return this.html || ''; }
        querySelector(selector) {
            if (selector.startsWith('.') && !this.innerHTML.includes(selector.slice(1))) return null;
            return new Element();
        }
        appendChild(child) { this.children.push(child); return child; }
        append(...children) { this.children.push(...children); }
        addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
        removeEventListener(type, handler) {
            this.listeners[type] = (this.listeners[type] || []).filter(value => value !== handler);
        }
        async dispatch(type, event = {}) {
            const full = { target: this, preventDefault() {}, ...event };
            if (this['on' + type]) await this['on' + type](full);
            for (const handler of this.listeners[type] || []) await handler(full);
        }
        click() { this.clicks = (this.clicks || 0) + 1; return this.dispatch('click'); }
        reset() {
            // Clear form fields only; the real application clears other account-scoped state explicitly.
            const ids = this.id === 'complete-order-form'
                ? ['complete-order-id', 'monto-cobrado', 'forma-pago', 'notas-extra']
                : ['order-number', 'fecha', 'nombre', 'telefono', 'vehiculo', 'dominio', 'novedades'];
            ids.forEach(id => { elements.get(id).value = ''; });
        }
        focus() {}
        scrollIntoView() {}
        getContext() { return { drawImage() {} }; }
        toBlob(callback) { callback(new Blob(['compressed'])); }
    }
    for (const match of html.matchAll(/id="([^"]+)"/g)) {
        const element = new Element();
        element.id = match[1];
        elements.set(match[1], element);
    }
    const calls = { rpc: [], upload: [], remove: [], query: [], print: [] };
    const client = {
        auth: {
            getUser: async () => ({ data: { user: null }, error: null }),
            signOut: async () => ({ error: null }),
            onAuthStateChange(handler) { client.auth.handler = handler; }
        },
        rpc: async (name, args) => { calls.rpc.push({ name, args }); return { data: [], error: null }; },
        from(table) {
            const entry = { table };
            calls.query.push(entry);
            const chain = {
                select(value) { entry.select = value; return chain; },
                eq(key, value) { (entry.filters ||= []).push([key, value]); return chain; },
                order() { return chain; },
                range: async () => ({ data: [], error: null }),
                single: async () => ({ data: order(), error: null }),
                insert: async value => { entry.insert = value; return { error: null }; },
                update(value) { entry.update = value; return chain; },
                delete() { entry.delete = true; return chain; },
                then(done) { return Promise.resolve({ error: null }).then(done); }
            };
            return chain;
        },
        storage: { from: () => ({
            upload: async path => { calls.upload.push(path); return { data: { path }, error: null }; },
            getPublicUrl: path => ({ data: { publicUrl: `https://example.test/storage/v1/object/public/photos/${path}` } }),
            remove: async paths => { calls.remove.push(paths); return { error: null }; }
        }) }
    };
    Object.assign(client, overrides);
    const timers = new Map();
    let timerId = 0;
    const window = {
        supabase: { createClient: () => client },
        location: { search: '', href: 'https://example.test/index.html' },
        addEventListener() {},
        open: () => ({
            document: { write: value => calls.print.push(value), close() {} },
            focus() {}, print() {}, close() {}
        })
    };
    const sandbox = vm.createContext({
        window, navigator: {}, document: {
            getElementById: id => elements.get(id) || null,
            createElement: tag => new Element(tag)
        },
        console: { log() {}, error() {} }, URL, URLSearchParams, Blob,
        crypto: webcrypto,
        setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: id => timers.delete(id),
        FileReader: class {
            readAsText(file) { queueMicrotask(() => this.onload({ target: { result: file.text } })); }
            readAsDataURL() { queueMicrotask(() => this.onload({ target: { result: 'data:image/jpeg;base64,eA==' } })); }
        },
        Image: class {
            width = 100; height = 100;
            set src(value) { queueMicrotask(() => this.onload()); }
        }
    });
    vm.runInContext(`'use strict';\n${source}`, sandbox, { filename: 'index.html (real inline module)' });
    const evaluate = expression => vm.runInContext(expression, sandbox);
    await new Promise(resolve => setImmediate(resolve));
    return {
        client, calls, elements, evaluate, timers,
        get: id => elements.get(id),
        set(name, value) { sandbox[name] = value; sandbox.testValue = value; evaluate(`${name} = testValue`); },
        login(id = USER_A) { evaluate(`currentUser = { id: '${id}' }; ordersReady = true`); }
    };
}
