// Solo campos permitidos: nunca copiar message, stack, URLs, bucket, key o credenciales.
const { isIP } = require('node:net');
const failures = new WeakMap();
const OPERATIONS = new Set(['testConnection', 'uploadStream', 'getPresignedUploadUrl',
  'listObjects', 'deleteObject', 'objectExists', 'getObjectHead', 'listMultipartUploads', 'abortMultipartUpload']);
const NETWORK_CODES = new Set(['ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ABORT_ERR', 'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT']);
const CODES = new Set([...NETWORK_CODES, 'TimeoutError', 'AbortError', 'AggregateError',
  'AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'NoSuchBucket', 'NoSuchKey',
  'NotFound', 'InvalidRange', 'RequestTimeout', 'SlowDown', 'Throttling', 'ThrottlingException',
  'InternalError', 'ServiceUnavailable', 'NotImplemented', 'InvalidRequest', 'InvalidArgument',
  'AuthorizationHeaderMalformed', 'CredentialsProviderError']);
const isObject = (value) => value !== null && typeof value === 'object';
const boundedInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function rememberR2Failure(operation, error) {
  const err = isObject(error) ? error : {};
  const details = {
    operation: OPERATIONS.has(operation) ? operation : 'unknown',
    code: CODES.has(err.code) ? err.code : (CODES.has(err.name) ? err.name : 'UNKNOWN'),
  };
  const metadata = err.$metadata || {};
  if (boundedInteger(metadata.httpStatusCode, 100, 599)) details.httpStatus = metadata.httpStatusCode;
  if (boundedInteger(metadata.attempts, 0, 100)) details.attempts = metadata.attempts;
  if (boundedInteger(metadata.totalRetryDelay, 0, 600000)) details.retryDelayMs = metadata.totalRetryDelay;

  const networkErrors = [];
  const seen = new Set([err]);
  function visit(child, depth) {
    if (!isObject(child) || depth > 3 || seen.has(child) || seen.size >= 16) return;
    seen.add(child);
    if (NETWORK_CODES.has(child.code)) {
      const item = { code: child.code };
      const family = typeof child.address === 'string' ? isIP(child.address) : 0;
      if (family) item.family = family;
      if (!networkErrors.some((entry) => entry.code === item.code && entry.family === item.family)) networkErrors.push(item);
    }
    for (const nested of Array.isArray(child.errors) ? child.errors.slice(0, 8) : []) visit(nested, depth + 1);
    visit(child.cause, depth + 1);
  }
  for (const child of Array.isArray(err.errors) ? err.errors.slice(0, 8) : []) visit(child, 1);
  visit(err.cause, 1);
  if (networkErrors.length) details.networkErrors = networkErrors;

  // El mismo error se puede registrar otra vez en una ruta o middleware. El logger reconoce
  // su identidad sin modificarlo y vuelve a usar estos campos seguros, no el mensaje original.
  if (isObject(error)) failures.set(error, details);
  return details;
}

function getR2Failure(error) {
  return isObject(error) ? failures.get(error) : undefined;
}

module.exports = { rememberR2Failure, getR2Failure };
