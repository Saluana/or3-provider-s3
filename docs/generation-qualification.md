# Dormant immutable-generation qualification

Implementation is approved; production migration and cleanup activation are not.
No existing adapter registration, bucket setting, client wire field or live data
is changed by this work. New factories must be explicitly constructed in tests.

Failure cases to establish before implementation:

- Disabled factories perform no storage/network/database work.
- Unsupported conditional creates or disabled bucket versioning fail closed.
- A generation binds workspace, SHA-256, byte count, MIME, namespace and canonical
  allocation; legacy MD5/hash-only paths are never adopted implicitly.
- Concurrent uploads have one conditional-create winner. Commit freezes the
  verified immutable VersionId; downloads never resolve a mutable latest alias.
- Canonical publication, metadata/reference writes, restoration and deletion
  claims use the existing SQLite coordinator and its transaction guards.
- Missing/mismatched/transaction-local claims cannot authorize byte removal.
- Cleanup retains a permanent non-delete-marker tombstone at the upload key
  before removing an exact old VersionId. Old signed uploads cannot recreate it.
- Two workers, lost delete responses and retries cannot remove another generation
  or release accounting before exact-version absence is verified.
- Restore-before-claim retains bytes; claim-before-restore rejects stale writes.
- Failed or incomplete proof retains the allocation/accounting hold.
- Legacy identity migration is prepared from verified backup originals; execution
  remains unavailable until backed-up cutover is separately approved.

Hippius's published compatibility matrix is stale on conditional creates. A real
disposable-bucket probe on 2026-11-05 verified If-None-Match overwrite rejection,
concurrent-create exclusion, immutable version reads and exact-version removal
while a retained tombstone still rejects stale uploads. This evidence does not
authorize turning on cleanup or changing an existing bucket's versioning.
