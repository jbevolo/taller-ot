# Deploy transactional backup restore

`safe-order-operations.sql` must be reviewed and applied manually by an authorized database operator before the updated restore UI is used. This repository change does **not** mean the migration is deployed.

## Deployment checklist

1. Back up the database and test recovery outside production.
2. Inspect `public.work_orders`, its constraints, triggers, grants, foreign keys, and all RLS policies.
3. Run `node --test tests/*.test.mjs` locally. The database test creates an isolated PostgreSQL cluster and never reads Supabase credentials.
4. Apply `safe-order-operations.sql` to a staging copy, test with two authenticated owners, then apply it during a production maintenance window.
5. Deploy `index.html` only after the RPC is available. If the RPC is absent, restore fails closed and leaves current rows untouched.

The migration is transactional and idempotent. It refuses to install unless the expected writable columns, UUID identity columns, ID uniqueness, authenticated table privileges, enabled RLS, and applicable authenticated policies exist. It creates only `restore_work_orders(jsonb, uuid)`, uses `SECURITY INVOKER`, grants execution only to `authenticated`, and does not create tables, alter policies, or grant table privileges.

## Restore contract

- The browser accepts the current snake_case export and the documented legacy `orderNumber` / `createdAt` aliases.
- Current valid UUIDs are preserved. The bundled legacy sample's placeholder ID is replaced with a UUID because it never represented a valid share identity.
- Unknown fields, foreign owners, duplicate or invalid current UUIDs, invalid dates, invalid photo arrays/URLs, malformed rows, empty backups, more than 10,000 rows, and payloads over 20 MiB are rejected before mutation.
- The RPC validates every normalized row, upserts supplied IDs, and deletes only omitted rows owned by `auth.uid()` in one PostgreSQL transaction. Validation, casts, RLS, constraints, triggers, insertion, deletion, or invocation failures roll back every database write.
- Database rollback cannot undo external effects from custom triggers or webhooks. Review those before deployment. Backups contain photo URLs, not Storage objects.

## Rollback boundary

To disable the capability, an authorized operator can drop exactly:

```sql
drop function if exists public.restore_work_orders(jsonb, uuid);
```

The frontend will then report that safe restore is unavailable. Do not restore the previous browser-side DELETE-then-INSERT implementation.
