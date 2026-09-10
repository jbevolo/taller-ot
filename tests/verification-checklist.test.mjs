import test from "node:test";
import assert from "node:assert/strict";
import { createApp, order, USER_A, USER_B } from "./browser-harness.mjs";

const malicious = `</td><img src=x onerror="globalThis.auditMarker=1"><script>alert('x')</script>'"`;

function fillRequiredOrder(app) {
    app.login(USER_A);
    app.get("order-number").value = "7";
    app.get("fecha").value = "2026-05-13";
    app.get("nombre").value = "Customer";
    app.get("telefono").value = "123";
    app.get("vehiculo").value = "Car";
    app.get("dominio").value = "abc123";
    app.get("novedades").value = "Repair";
}

test("creation payload carries optional canonical verification checklist and safe attachment paths", async () => {
    const app = await createApp();
    fillRequiredOrder(app);
    const uploads = [];
    let inserted;
    app.client.storage.from = (bucket) => ({
        upload: async (path, file, options) => {
            uploads.push({ bucket, path, file, options });
            return { data: { path }, error: null };
        },
        getPublicUrl: (path) => ({
            data: { publicUrl: `https://example.test/${path}` },
        }),
        remove: async () => ({ error: null }),
    });
    app.client.from = (table) => ({
        insert: async (rows) => {
            inserted = { table, rows };
            return { error: null };
        },
    });

    app.set("testNote", `Checked ${malicious}`);
    app.evaluate(`setVerificationChecklistItem('REGULADOR', 'OK', testNote)`);
    app.evaluate(`setVerificationChecklistItem('CABLEADO VALVULA', 'N/A', '')`);
    app.set("verificationSelectedFiles", [
        { name: "unsafe name<script>.PDF", type: "application/pdf" },
        {
            name: "sheet.xlsx",
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
    ]);

    await app.get("work-order-form").dispatch("submit");

    assert.equal(inserted.table, "work_orders");
    const row = inserted.rows[0];
    assert.equal(row.user_id, USER_A);
    assert.deepEqual(Object.keys(row.verification_checklist), [
        "REGULADOR",
        "MANGUERAS GNC",
        "FILTRO DE GAS",
        "CAÑO ALTA PRESION",
        "MANGUERAS AGUA",
        "CUNA",
        "CILINDRO",
        "VALVULA CILINDRO",
        "RETENCION",
        "NIPLES Y VIROLAS",
        "SISTEMA VENTEO",
        "CABLEADO VALVULA",
    ]);
    assert.equal(row.verification_checklist.REGULADOR.status, "OK");
    assert.equal(
        row.verification_checklist.REGULADOR.note,
        `Checked ${malicious}`,
    );
    assert.equal(row.verification_checklist["FILTRO DE GAS"].status, null);
    assert.deepEqual(
        Array.from(row.verification_files),
        uploads.map((upload) => upload.path),
    );
    assert.ok(uploads.every((upload) => upload.bucket === "photos"));
    assert.ok(
        uploads.every((upload) =>
            upload.path.startsWith(`${USER_A}/verification/`),
        ),
    );
    assert.ok(uploads[0].path.endsWith(".pdf"));
    assert.ok(!uploads[0].path.includes("unsafe name"));
});

test("new order retains uploaded verification attachments when insert outcome is ambiguous", async () => {
    for (const insertResult of ["throw", "malformed"]) {
        const app = await createApp();
        fillRequiredOrder(app);
        const uploaded = [];
        const removals = [];
        app.client.storage.from = () => ({
            upload: async (path) => {
                uploaded.push(path);
                return { data: { path }, error: null };
            },
            getPublicUrl: (path) => ({
                data: { publicUrl: `https://example.test/${path}` },
            }),
            remove: async (paths) => {
                removals.push(paths);
                return { error: null };
            },
        });
        app.client.from = () => ({
            insert: async () => {
                if (insertResult === "throw")
                    throw new Error("network unknown");
                return null;
            },
        });
        app.set("verificationSelectedFiles", [
            { name: "check.pdf", type: "application/pdf" },
        ]);

        await app.get("work-order-form").dispatch("submit");

        assert.equal(uploaded.length, 1);
        assert.deepEqual(removals, []);
        assert.match(
            app.get("notification-message").textContent,
            /No se pudo confirmar|network unknown/,
        );
    }
});

test("new order stale-context insert outcome retains uploaded verification attachments", async () => {
    const app = await createApp();
    fillRequiredOrder(app);
    let uploaded;
    const removals = [];
    app.client.storage.from = () => ({
        upload: async (path) => {
            uploaded = path;
            return { data: { path }, error: null };
        },
        getPublicUrl: (path) => ({
            data: { publicUrl: `https://example.test/${path}` },
        }),
        remove: async (paths) => {
            removals.push(paths);
            return { error: null };
        },
    });
    app.client.from = () => ({
        insert: async () => {
            app.login(USER_B);
            return { error: null };
        },
    });
    app.set("verificationSelectedFiles", [
        { name: "check.pdf", type: "application/pdf" },
    ]);

    await app.get("work-order-form").dispatch("submit");

    assert.ok(uploaded);
    assert.deepEqual(removals, []);
});

test("new order explicit insert failure compensates verification attachments exactly once", async () => {
    const app = await createApp();
    fillRequiredOrder(app);
    let uploaded;
    const removals = [];
    app.client.storage.from = () => ({
        upload: async (path) => {
            uploaded = path;
            return { data: { path }, error: null };
        },
        getPublicUrl: (path) => ({
            data: { publicUrl: `https://example.test/${path}` },
        }),
        remove: async (paths) => {
            removals.push(paths);
            return { error: null };
        },
    });
    app.client.from = () => ({
        insert: async () => ({ error: { message: "insert rejected" } }),
    });
    app.set("verificationSelectedFiles", [
        { name: "check.pdf", type: "application/pdf" },
    ]);

    await app.get("work-order-form").dispatch("submit");

    assert.deepEqual(
        removals.map((paths) => Array.from(paths)),
        [[uploaded]],
    );
    assert.match(
        app.get("notification-message").textContent,
        /insert rejected/,
    );
});

test("verification attachments reject unsupported types before storage or persistence", async () => {
    const app = await createApp();
    fillRequiredOrder(app);
    let uploads = 0;
    let inserts = 0;
    app.client.storage.from = () => ({
        upload: async () => {
            uploads++;
            return { data: {}, error: null };
        },
    });
    app.client.from = () => ({
        insert: async () => {
            inserts++;
            return { error: null };
        },
    });
    app.set("verificationSelectedFiles", [
        { name: "payload.svg", type: "image/svg+xml" },
    ]);

    await app.get("work-order-form").dispatch("submit");

    assert.equal(uploads, 0);
    assert.equal(inserts, 0);
    assert.match(app.get("notification-message").textContent, /verificaci/i);
});

test("admin detail save persists verification for open and finalized orders", async () => {
    for (const status of ["Abierta", "Finalizada"]) {
        const app = await createApp();
        app.login(USER_A);
        let updatePayload;
        const filters = [];
        const chain = {
            update(payload) {
                updatePayload = { table: "work_orders", payload };
                return chain;
            },
            eq(key, value) {
                filters.push([key, value]);
                return filters.length >= 2
                    ? Promise.resolve({ error: null })
                    : chain;
            },
        };
        app.client.from = () => chain;
        app.set(
            "testOrder",
            order({
                status,
                verification_checklist: {
                    REGULADOR: { status: "NO OK", note: "late" },
                },
            }),
        );
        app.evaluate("viewOrder(testOrder)");

        await app.get("save-verification-btn").click();

        assert.equal(updatePayload.table, "work_orders");
        assert.equal(
            updatePayload.payload.verification_checklist.REGULADOR.status,
            "NO OK",
        );
        assert.deepEqual(filters, [
            ["id", order().id],
            ["user_id", USER_A],
        ]);
    }
});

test("admin detail can add and remove verification attachments safely", async () => {
    const app = await createApp();
    app.login(USER_A);
    const kept = `${USER_A}/verification/33333333-3333-4333-8333-333333333333.pdf`;
    const removed = `${USER_A}/verification/44444444-4444-4444-8444-444444444444.pdf`;
    let uploaded;
    const storage = { uploads: [], removals: [] };
    let updatePayload;
    app.client.storage.from = () => ({
        upload: async (path, file, options) => {
            uploaded = path;
            storage.uploads.push({ path, file, options });
            return { data: { path }, error: null };
        },
        getPublicUrl: (path) => ({
            data: { publicUrl: `https://example.test/${path}` },
        }),
        remove: async (paths) => {
            storage.removals.push(paths);
            return { error: null };
        },
    });
    let filters = 0;
    const chain = {
        update(payload) {
            updatePayload = payload;
            return chain;
        },
        eq() {
            filters++;
            return filters >= 2 ? Promise.resolve({ error: null }) : chain;
        },
    };
    app.client.from = () => chain;
    app.set("testOrder", order({ verification_files: [kept, removed] }));
    app.evaluate("viewOrder(testOrder)");

    await app.get("edit-verification-files").children[1].children[1].click();
    await app.get("edit-verification-files-input").dispatch("change", {
        target: {
            files: [{ name: "new.pdf", type: "application/pdf" }],
            value: "",
        },
    });
    await app.get("save-verification-btn").click();

    assert.deepEqual(Array.from(updatePayload.verification_files), [
        kept,
        uploaded,
    ]);
    assert.equal(storage.uploads.length, 1);
    assert.deepEqual(
        storage.removals.map((paths) => Array.from(paths)),
        [[removed]],
    );
});

test("admin detail retains verification uploads and removed existing attachments on ambiguous DB update", async () => {
    for (const updateResult of ["throw", "malformed"]) {
        const app = await createApp();
        app.login(USER_A);
        const removed = `${USER_A}/verification/44444444-4444-4444-8444-444444444444.pdf`;
        let uploaded;
        const removals = [];
        app.client.storage.from = () => ({
            upload: async (path) => {
                uploaded = path;
                return { data: { path }, error: null };
            },
            getPublicUrl: (path) => ({
                data: { publicUrl: `https://example.test/${path}` },
            }),
            remove: async (paths) => {
                removals.push(paths);
                return { error: null };
            },
        });
        let filters = 0;
        const chain = {
            update() {
                return chain;
            },
            eq() {
                filters++;
                if (filters < 2) return chain;
                if (updateResult === "throw")
                    throw new Error("network unknown");
                return Promise.resolve(null);
            },
        };
        app.client.from = () => chain;
        app.set("testOrder", order({ verification_files: [removed] }));
        app.evaluate("viewOrder(testOrder)");

        await app
            .get("edit-verification-files")
            .children[0].children[1].click();
        await app.get("edit-verification-files-input").dispatch("change", {
            target: {
                files: [{ name: "new.pdf", type: "application/pdf" }],
                value: "",
            },
        });
        await app.get("save-verification-btn").click();

        assert.ok(uploaded);
        assert.deepEqual(removals, []);
        assert.match(
            app.get("notification-message").textContent,
            /No se pudo guardar la planilla/,
        );
    }
});

test("admin detail retains verification uploads and removed existing attachments on stale-context DB update", async () => {
    const app = await createApp();
    app.login(USER_A);
    const removed = `${USER_A}/verification/44444444-4444-4444-8444-444444444444.pdf`;
    let uploaded;
    const removals = [];
    app.client.storage.from = () => ({
        upload: async (path) => {
            uploaded = path;
            return { data: { path }, error: null };
        },
        getPublicUrl: (path) => ({
            data: { publicUrl: `https://example.test/${path}` },
        }),
        remove: async (paths) => {
            removals.push(paths);
            return { error: null };
        },
    });
    let filters = 0;
    const chain = {
        update() {
            return chain;
        },
        eq() {
            filters++;
            if (filters < 2) return chain;
            app.login(USER_B);
            return Promise.resolve({ error: null });
        },
    };
    app.client.from = () => chain;
    app.set("testOrder", order({ verification_files: [removed] }));
    app.evaluate("viewOrder(testOrder)");

    await app.get("edit-verification-files").children[0].children[1].click();
    await app.get("edit-verification-files-input").dispatch("change", {
        target: {
            files: [{ name: "new.pdf", type: "application/pdf" }],
            value: "",
        },
    });
    await app.get("save-verification-btn").click();

    assert.ok(uploaded);
    assert.deepEqual(removals, []);
});

test("admin detail compensates newly uploaded verification attachments on explicit DB failure only", async () => {
    const app = await createApp();
    app.login(USER_A);
    const removed = `${USER_A}/verification/44444444-4444-4444-8444-444444444444.pdf`;
    let uploaded;
    const removals = [];
    app.client.storage.from = () => ({
        upload: async (path) => {
            uploaded = path;
            return { data: { path }, error: null };
        },
        getPublicUrl: (path) => ({
            data: { publicUrl: `https://example.test/${path}` },
        }),
        remove: async (paths) => {
            removals.push(paths);
            return { error: null };
        },
    });
    let filters = 0;
    const chain = {
        update() {
            return chain;
        },
        eq() {
            filters++;
            return filters >= 2
                ? Promise.resolve({ error: { message: "db rejected" } })
                : chain;
        },
    };
    app.client.from = () => chain;
    app.set("testOrder", order({ verification_files: [removed] }));
    app.evaluate("viewOrder(testOrder)");

    await app.get("edit-verification-files").children[0].children[1].click();
    await app.get("edit-verification-files-input").dispatch("change", {
        target: {
            files: [{ name: "new.pdf", type: "application/pdf" }],
            value: "",
        },
    });
    await app.get("save-verification-btn").click();

    assert.deepEqual(
        removals.map((paths) => Array.from(paths)),
        [[uploaded]],
    );
    assert.ok(
        !removals.flatMap((paths) => Array.from(paths)).includes(removed),
    );
    assert.match(app.get("notification-message").textContent, /db rejected/);
});

test("admin detail, public view, and printing render verification safely", async () => {
    const app = await createApp();
    app.login(USER_A);
    const checked = order({
        status: "Finalizada",
        verification_checklist: {
            REGULADOR: { status: "OK", note: malicious },
        },
        verification_files: [
            `${USER_A}/verification/22222222-2222-4222-8222-222222222222.pdf`,
            `${USER_A}/verification/${malicious}.xlsx`,
        ],
    });
    app.set("testOrder", checked);
    app.evaluate("viewOrder(testOrder); printWorkOrder(testOrder)");
    assert.ok(
        app
            .get("view-order-content")
            .innerHTML.includes("Planilla de verificación"),
    );
    assert.ok(app.get("view-order-content").innerHTML.includes("REGULADOR"));
    assert.ok(
        app
            .get("view-order-content")
            .innerHTML.includes(
                "https://example.test/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/verification/22222222-2222-4222-8222-222222222222.pdf",
            ),
    );
    assert.ok(!app.get("view-order-content").innerHTML.includes(malicious));
    assert.ok(
        app.get("view-order-content").innerHTML.includes("&lt;script&gt;"),
    );
    const printOutput = app.calls.print.join("");
    assert.ok(printOutput.includes("Planilla de verificación"));
    assert.ok(
        printOutput.includes(
            "https://example.test/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/verification/22222222-2222-4222-8222-222222222222.pdf",
        ),
    );
    assert.ok(!printOutput.includes(malicious));
    assert.ok(!printOutput.includes(`${malicious}.xlsx`));

    app.client.from = () => ({
        select() {
            return this;
        },
        eq() {
            return this;
        },
        single: async () => ({ data: checked, error: null }),
    });
    await app.evaluate(`showPublicOrderView('${checked.id}')`);
    assert.ok(
        app
            .get("pub-verification-content")
            .innerHTML.includes("Planilla de verificación"),
    );
    assert.ok(
        !app.get("pub-verification-content").innerHTML.includes(malicious),
    );
});

test("legacy orders normalize to an incomplete empty verification sheet", async () => {
    const app = await createApp();
    const normalized = app.evaluate(
        "normalizeVerificationChecklist(undefined)",
    );
    assert.equal(normalized.REGULADOR.status, null);
    assert.equal(normalized.REGULADOR.note, "");
    assert.equal(Object.keys(normalized).length, 12);
    assert.deepEqual(
        Array.from(app.evaluate("normalizeVerificationFiles(undefined)")),
        [],
    );
});
