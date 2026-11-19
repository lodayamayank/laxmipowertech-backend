import { S3Client } from '@aws-sdk/client-s3';

// Client is initialized lazily.
let client = null;

function required(name) {
  const value = (process.env[name] || '').trim();

  if (!value) {
    throw new Error(
      `[R2 Configuration] Missing required environment variable: ${name}`
    );
  }

  return value;
}

export function getBucketName() {
  return required('R2_BUCKET_NAME');
}

export function getR2Client() {
  if (client) return client;

  try {
    const accountId = (process.env.R2_ACCOUNT_ID || '').trim();

    const endpoint =
      (process.env.R2_ENDPOINT || '').trim() ||
      (accountId
        ? `https://${accountId}.r2.cloudflarestorage.com`
        : '');

    if (!endpoint) {
      throw new Error(
        'Set either R2_ENDPOINT or R2_ACCOUNT_ID'
      );
    }

   
    let parsedEndpoint;

    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new Error('Invalid R2 endpoint URL');
    }

    if (!['https:', 'http:'].includes(parsedEndpoint.protocol)) {
      throw new Error('R2 endpoint must use HTTP or HTTPS');
    }

    const accessKeyId = required('R2_ACCESS_KEY_ID');
    const secretAccessKey = required('R2_SECRET_ACCESS_KEY');

    client = new S3Client({
      region: (process.env.R2_REGION || 'auto').trim(),

      forcePathStyle:
        process.env.R2_FORCE_PATH_STYLE === 'true',

      endpoint: parsedEndpoint.toString(),

      credentials: {
        accessKeyId,
        secretAccessKey,
      },

      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });

    return client;

  } catch (error) {
    console.error('[R2 Client Initialization Error]', error.message);
    throw error;
  }
}
