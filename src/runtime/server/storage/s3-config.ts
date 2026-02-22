export interface S3StorageConfig {
    authEnabled: boolean;
    storageEnabled: boolean;
    providerId: string | undefined;
    strict: boolean;

    endpoint: string | undefined;
    region: string | undefined;
    bucket: string | undefined;
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
    sessionToken: string | undefined;

    forcePathStyle: boolean;
    keyPrefix: string;
    urlTtlSeconds: number;
    requireChecksum: boolean;
}

export interface S3StorageConfigDiagnostics {
    isValid: boolean;
    errors: string[];
    warnings: string[];
    config: S3StorageConfig;
}

const DEFAULT_URL_TTL_SECONDS = 900;
const MAX_URL_TTL_SECONDS = 24 * 60 * 60;
const ALLOW_INSECURE_HTTP_ENV = 'OR3_STORAGE_S3_ALLOW_INSECURE_HTTP';

function isStrictMode(runtimeConfig: ReturnType<typeof useRuntimeConfig>): boolean {
    if (process.env.OR3_STRICT_CONFIG === 'true') return true;
    if (process.env.NODE_ENV === 'production') return true;
    return runtimeConfig.auth?.strict === true;
}

function parseBool(value: string | undefined): boolean {
    return value === 'true';
}

function normalizePrefix(value: string | undefined): string {
    const raw = (value ?? '').trim();
    if (!raw) return '';
    const noSlashes = raw.replace(/^\/+/, '').replace(/\/+$/, '');
    return noSlashes ? `${noSlashes}/` : '';
}

function parseUrlOrUndefined(value: string | undefined): string | undefined {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return undefined;
    try {
        new URL(trimmed);
        return trimmed;
    } catch {
        return undefined;
    }
}

function isHttpUrl(url: string | undefined): boolean {
    if (!url) return false;
    try {
        return new URL(url).protocol === 'http:';
    } catch {
        return false;
    }
}

export function resolveS3UrlTtlSeconds(): number {
    const raw = process.env.OR3_STORAGE_S3_URL_TTL_SECONDS;
    if (!raw) return DEFAULT_URL_TTL_SECONDS;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new Error('OR3_STORAGE_S3_URL_TTL_SECONDS must be an integer between 1 and 86400.');
    }

    if (parsed < 1 || parsed > MAX_URL_TTL_SECONDS) {
        throw new Error('OR3_STORAGE_S3_URL_TTL_SECONDS must be between 1 and 86400.');
    }

    return parsed;
}

export function validateS3StorageConfig(
    runtimeConfig: ReturnType<typeof useRuntimeConfig>
): S3StorageConfigDiagnostics {
    const authEnabled = runtimeConfig.auth?.enabled === true || runtimeConfig.public?.auth?.enabled === true;
    const storageEnabled = runtimeConfig.storage?.enabled === true || runtimeConfig.public?.storage?.enabled === true;
    const providerId = (runtimeConfig.storage?.provider || runtimeConfig.public?.storage?.provider) as string | undefined;

    const endpoint = parseUrlOrUndefined(process.env.OR3_STORAGE_S3_ENDPOINT);
    const region = (process.env.OR3_STORAGE_S3_REGION ?? '').trim() || undefined;
    const bucket = (process.env.OR3_STORAGE_S3_BUCKET ?? '').trim() || undefined;
    const accessKeyId = (process.env.OR3_STORAGE_S3_ACCESS_KEY_ID ?? '').trim() || undefined;
    const secretAccessKey = (process.env.OR3_STORAGE_S3_SECRET_ACCESS_KEY ?? '').trim() || undefined;
    const sessionToken = (process.env.OR3_STORAGE_S3_SESSION_TOKEN ?? '').trim() || undefined;

    const forcePathStyle = parseBool(process.env.OR3_STORAGE_S3_FORCE_PATH_STYLE);
    const keyPrefix = normalizePrefix(process.env.OR3_STORAGE_S3_KEY_PREFIX);

    const config: S3StorageConfig = {
        authEnabled,
        storageEnabled,
        providerId,
        strict: isStrictMode(runtimeConfig),
        endpoint,
        region,
        bucket,
        accessKeyId,
        secretAccessKey,
        sessionToken,
        forcePathStyle,
        keyPrefix,
        urlTtlSeconds: DEFAULT_URL_TTL_SECONDS,
        requireChecksum: parseBool(process.env.OR3_STORAGE_S3_REQUIRE_CHECKSUM),
    };

    const errors: string[] = [];
    const warnings: string[] = [];

    if (!authEnabled) warnings.push('auth.enabled=false; s3 storage adapter registration skipped.');
    if (!storageEnabled) warnings.push('storage.enabled=false; s3 storage adapter registration skipped.');
    if (providerId && providerId !== 's3') {
        warnings.push(`storage.provider=${providerId}; s3 storage adapter remains idle.`);
    }

    if (String(process.env.OR3_STORAGE_S3_ENDPOINT ?? '').trim() && !endpoint) {
        errors.push('OR3_STORAGE_S3_ENDPOINT must be a valid URL.');
    }

    if (isHttpUrl(endpoint) && process.env[ALLOW_INSECURE_HTTP_ENV] !== 'true') {
        errors.push(
            `OR3_STORAGE_S3_ENDPOINT must use HTTPS unless ${ALLOW_INSECURE_HTTP_ENV}=true is explicitly set.`
        );
    }

    if (!region) errors.push('Missing OR3_STORAGE_S3_REGION.');
    if (!bucket) errors.push('Missing OR3_STORAGE_S3_BUCKET.');
    if (!accessKeyId) errors.push('Missing OR3_STORAGE_S3_ACCESS_KEY_ID.');
    if (!secretAccessKey) errors.push('Missing OR3_STORAGE_S3_SECRET_ACCESS_KEY.');

    try {
        config.urlTtlSeconds = resolveS3UrlTtlSeconds();
    } catch (err) {
        errors.push((err as Error).message);
    }

    if (config.requireChecksum) {
        warnings.push('OR3_STORAGE_S3_REQUIRE_CHECKSUM=true; ensure your S3 host supports x-amz-checksum-sha256 for PutObject presigned URLs.');
    }

    return {
        isValid: errors.length === 0,
        errors,
        warnings,
        config,
    };
}
