# Deploy safe restore and photo updates

**Deploy `safe-order-operations.sql` only after checking the existing database below.** The repository has no authoritative schema or RLS definitions. The migration intentionally refuses unsupported schemas instead of inventing tables, weakening policies, or falling back to destructive browser requests.

## Deployment sequence

1. Export a database backup and the `photos` bucket separately. Test recovery outside production.
2. Inspect the schema, RLS, grants, triggers, and dependent records using the read-only queries below. Resolve differences in a reviewed migration; do not bypass the preflight checks.
3. Run the regression suite locally and apply `safe-order-operations.sql` to a staging copy. Verify owner and cross-owner behavior with staging accounts.
4. During a short maintenance window, stop order/photo edits, apply the same SQL through an authorized database operator, then deploy `index.html` and `sw.js` together. No service-role credential belongs in the frontend.
5. Have users save their drafts, close **all** existing application tabs/PWA windows, and reopen. The service worker does not force activation over unsaved work. Older clients still use unsafe full-array photo updates, so retire those tabs before resuming edits.

The migration is transactional and idempotent. It creates/replaces two exact RPC signatures and refreshes the PostgREST schema cache. **It has not been applied to the deployed backend by this change.**

## Required schema and access checks

| Requirement | Behavior |
|---|---|
| Existing `public.work_orders` with the application columns | Preflight fails if required fields are missing, generated, or identity columns. |
| UUID `id` and `user_id`; nondeferrable primary/unique constraint on `id` | Stable order IDs survive restore. Owner identity is checked against `auth.uid()` and the expected browser account. |
| `fotos` is `jsonb`, `json`, or `text[]` | The RPC adapts through the existing row type; it does not convert the column. |
| Other field types/constraints accept current application values | Actual casts, constraints and triggers remain authoritative. Test the real schema in staging. |
| Owner-scoped RLS and existing SELECT/INSERT/UPDATE/DELETE access | Functions use `SECURITY INVOKER`, not elevated privileges. No table grants or policies are added. Verify the owner can see **all** of their own rows. |
| `created_at` / `updated_at`, if present in a backup | Must exist as writable columns. Unknown fields are rejected rather than silently discarded. |

Run these read-only queries as an authorized operator:

```sql
select a.attname, format_type(a.atttypid, a.atttypmod) as type,
       a.attnotnull, a.attgenerated, a.attidentity,
       pg_get_expr(d.adbin, d.adrelid) as default_value
from pg_attribute a
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where a.attrelid = 'public.work_orders'::regclass
  and a.attnum > 0 and not a.attisdropped
order by a.attnum;

select relrowsecurity, relforcerowsecurity
from pg_class where oid = 'public.work_orders'::regclass;
select * from pg_policies where schemaname = 'public' and tablename = 'work_orders';
select grantee, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'work_orders';

select conrelid::regclass as referencing_table, conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.work_orders'::regclass
   or confrelid = 'public.work_orders'::regclass;
select tgname, pg_get_triggerdef(oid)
from pg_trigger where tgrelid = 'public.work_orders'::regclass and not tgisinternal;
```

Review policies for `anon`, `authenticated`, and `PUBLIC`, including permissive policies that combine with OR. Public customer links need a separately reviewed read policy; this migration does not establish or claim the correctness of public access. The public Supabase anon key is not a secret.

Review foreign-key cascades before allowing replacement restores: retained IDs are updated without deletion, but orders omitted from the backup are intentionally deleted. Database transaction rollback does not undo external effects implemented by custom triggers/webhooks.

## RPC guarantees and boundaries

### Restore

`restore_work_orders(jsonb, uuid)` validates the entire input, upserts retained/new IDs, then removes the owner's omitted orders in **one PostgreSQL transaction**. A validation, RLS, constraint, trigger, or lock-timeout error rolls back all database writes. A table-level write lock serializes the replacement with other writers, including direct CRUD clients. This briefly blocks writes for other owners as well; use a maintenance window. Lock timeout is five seconds.

- Nonempty backups only, up to 10,000 orders / 20 MiB of serialized JSON on the server.
- Current UUIDs are preserved. Legacy `orderNumber` / `createdAt` fields are normalized by the browser; missing or legacy non-UUID IDs receive new UUIDs because they have no valid current share identity.
- Backups naming another `user_id`, duplicate IDs, unknown fields, invalid dates and invalid photo URLs are rejected. This is recovery for the current owner, not cross-account transfer.
- Unique constraints can legitimately reject a historical backup, for example when a new ID conflicts with an existing order number. Failure retains the current dataset; resolve the conflict deliberately, not by disabling constraints.
- If the response is lost after commit, the browser reports **unconfirmed**, not “nothing changed.” Reload and inspect before retrying. There is no delete/insert fallback if the RPC is missing.

### Photos

`change_order_photos(uuid, jsonb, jsonb, uuid)` locks the owned row, computes append/remove deltas from its latest photos, and updates while holding the lock. Repeating the same add does not duplicate URLs. Empty deltas perform an owner/capability check before any browser upload. Additions to completed orders are rejected.

- Storage failures are surfaced. Known successful uploads from a failed upload batch are removed on a best-effort basis, before any database write. Cleanup errors retain URLs for retry.
- After an uncertain database response, uploaded objects are **not** deleted: the transaction might have committed. Retry reuses the same URLs and an idempotent delta.
- Removing a photo unlinks it from the order but retains its Storage object. Other orders and older backups may reference it. Schedule physical deletion only with an owner-scoped, reference-aware retention policy and a documented backup-retention period.
- Failed cleanup, abandoned selections, or lost responses can leave orphaned objects. Database and Storage are not one transaction; this change does not claim otherwise.
- Backups contain photo URLs, not image bytes. Back up Storage separately. Client state and pending selections are cleared at account transitions; unfinished uploads are not transferred to the next user.

## Verify before production

- [ ] Reapplying the migration succeeds without changing application data or table permissions.
- [ ] Anonymous calls, owner mismatch, foreign IDs, and missing table grants are rejected.
- [ ] A failing second restore row rolls back an earlier successful upsert.
- [ ] A retained ID still resolves via its existing customer link; dependent rows remain intact.
- [ ] Concurrent additions and concurrent add/remove operations preserve both intended effects.
- [ ] Missing RPCs leave orders unchanged and block extra uploads before Storage is used.
- [ ] Owner RLS, public order reads, and Storage upload/delete policies work on the actual staging schema.

```sql
select has_function_privilege('anon', 'public.restore_work_orders(jsonb,uuid)', 'execute') as anon_restore,
       has_function_privilege('authenticated', 'public.restore_work_orders(jsonb,uuid)', 'execute') as user_restore,
       has_function_privilege('anon', 'public.change_order_photos(uuid,jsonb,jsonb,uuid)', 'execute') as anon_photos;
-- Expected: false, true, false.
```

## Rollback boundary

The migration changes functions and their execution grants only. To disable these new operations, an authorized operator can drop exactly `public.restore_work_orders(jsonb, uuid)` and `public.change_order_photos(uuid, jsonb, jsonb, uuid)`. The updated frontend then fails safely for restore/photo changes. Do **not** restore the old destructive browser restore or stale photo-array writes. Browser rendering/session and service-worker fixes are independent and should remain deployed.

## Sources

- [Supabase database functions: RPCs, exceptions/rollback, invoker/definer security](https://supabase.com/docs/guides/database/functions)
- [Supabase API security and function execution privileges](https://supabase.com/docs/guides/api/securing-your-api)
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
