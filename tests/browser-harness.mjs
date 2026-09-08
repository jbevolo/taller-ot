import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

export const USER_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
export const USER_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
export const ORDER_ID = '11111111-1111-4111-8111-111111111111';

export const order = (overrides = {}) => ({
    id: ORDER_ID,
    user_id: USER_A,
    order_number: 1,
    fecha: '2026-05-13',
    nombre: 'Customer',
    telefono: '12345678',
    vehiculo: 'Car',
    dominio: 'AAA123',
    novedades: 'Repair\nCheck brakes',
    garantia: false,
    oblea: false,
    ph: false,
    nv: false,
    retencion: false,
    mangueras: false,
    status: 'Abierta',
    fotos: [],
    monto_cobrado: null,
    forma_pago: '',
    notas_extra: '',
    ...overrides
});

export function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

// Execute the complete current inline application; only browser and Supabase boundaries are doubled.
export async function createApp() {
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
                add: name => this.classes.add(name),
                remove: name => this.classes.delete(name),
                contains: name => this.classes.has(name)
            };
        }

        set innerHTML(value) {
            this.html = value;
            this.children = [];
            for (const match of value.matchAll(/id="([^"]+)"/g)) {
                elements.set(match[1], new Element());
            }
        }

        get innerHTML() { return this.html || ''; }

        querySelector(selector) {
            if (selector.startsWith('.') && !this.innerHTML.includes(selector.slice(1))) return null;
            return new Element();
        }

        appendChild(child) { this.children.push(child); return child; }
        append(...children) { this.children.push(...children); }
        addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }

        async dispatch(type, event = {}) {
            const full = { target: this, preventDefault() {}, ...event };
            if (this['on' + type]) await this['on' + type](full);
            for (const handler of this.listeners[type] || []) await handler(full);
        }

        click() { return this.dispatch('click'); }

        reset() {
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

    const calls = { print: [], queries: [] };
    const client = {
        auth: {
            getUser: async () => ({ data: { user: null }, error: null }),
            signInWithPassword: async () => ({ error: null }),
            signUp: async () => ({ error: null }),
            signOut: async () => ({ error: null }),
            onAuthStateChange(handler) { client.auth.handler = handler; }
        },
        rpc: async () => ({ data: [], error: null }),
        from(table) {
            const query = { table };
            calls.queries.push(query);
            const chain = {
                select(value) { query.select = value; return chain; },
                eq(key, value) { (query.filters ||= []).push([key, value]); return chain; },
                order() { return chain; },
                single: async () => ({ data: order(), error: null }),
                insert: async () => ({ error: null }),
                update() { return chain; },
                delete() { return chain; },
                then(done) { return Promise.resolve({ data: [], error: null }).then(done); }
            };
            return chain;
        },
        storage: { from: () => ({
            upload: async path => ({ data: { path }, error: null }),
            getPublicUrl: path => ({ data: { publicUrl: `https://example.test/${path}` } }),
            remove: async () => ({ error: null })
        }) }
    };

    const timers = new Map();
    let timerId = 0;
    const window = {
        supabase: { createClient: () => client },
        location: { search: '', href: 'https://example.test/index.html' },
        addEventListener() {},
        open: () => ({
            document: { write: value => calls.print.push(value), close() {} },
            focus() {},
            print() {},
            close() {}
        })
    };
    const sandbox = vm.createContext({
        window,
        navigator: {},
        document: {
            getElementById: id => elements.get(id) || null,
            createElement: tag => new Element(tag)
        },
        console: { log() {}, error() {} },
        URL,
        URLSearchParams,
        Blob,
        TextEncoder,
        crypto: webcrypto,
        setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: id => timers.delete(id),
        FileReader: class {
            readAsText(file) { queueMicrotask(() => this.onload({ target: { result: file.text } })); }
            readAsDataURL() { queueMicrotask(() => this.onload({ target: { result: 'data:image/jpeg;base64,eA==' } })); }
        },
        Image: class {
            width = 100;
            height = 100;
            set src(_value) { queueMicrotask(() => this.onload()); }
        }
    });

    vm.runInContext(`'use strict';\n${source}`, sandbox, { filename: 'index.html (real inline module)' });
    const evaluate = expression => vm.runInContext(expression, sandbox);
    await new Promise(resolve => setImmediate(resolve));

    return {
        client,
        calls,
        timers,
        evaluate,
        get: id => elements.get(id),
        set(name, value) {
            sandbox.testValue = value;
            evaluate(`${name} = testValue`);
        },
        login(id = USER_A) {
            evaluate(`currentUser = { id: '${id}', email: '${id}@example.test' }`);
        }
    };
}
