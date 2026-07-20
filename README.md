# or3-provider-s3

S3-compatible object storage provider for OR3 Chat.

- Server-side `StorageGatewayAdapter` (`id: 's3'`)
- Generates presigned PUT/GET URLs
- Keeps credentials server-only

Destructive S3 blob GC is temporarily disabled. GC requests report
`status: "disabled"` and `deleted_count: 0` without listing or deleting objects.
It must remain disabled until liveness is derived from canonical materialized
reference state rather than partial object listings.

See OR3 docs: `public/_documentation/cloud/provider-s3.md` in the host app.
