import mongoose from 'mongoose';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MONGO_CONNECT_OPTIONS = {
  serverSelectionTimeoutMS: 10000,
};

function isMongoSrvUri(uri = '') {
  return uri.startsWith('mongodb+srv://');
}

function isSrvLookupFailure(error) {
  const message = `${error?.message || error}`.toLowerCase();
  return message.includes('querysrv') && message.includes('econnrefused');
}

function normalizeJsonArray(parsedValue) {
  if (parsedValue == null) {
    return [];
  }

  return Array.isArray(parsedValue) ? parsedValue : [parsedValue];
}

async function resolveWindowsDnsRecord(recordType, hostname) {
  const command =
    recordType === 'SRV'
      ? `Resolve-DnsName -Type SRV '${hostname}' | Select-Object NameTarget,Port | ConvertTo-Json -Compress`
      : `Resolve-DnsName -Type TXT '${hostname}' | ForEach-Object { $_.Strings } | ConvertTo-Json -Compress`;

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-Command', command],
    { windowsHide: true }
  );

  if (!stdout.trim()) {
    return [];
  }

  return normalizeJsonArray(JSON.parse(stdout));
}

function buildMongoCredentials(parsedUri) {
  if (!parsedUri.username) {
    return '';
  }

  const passwordSegment = parsedUri.password ? `:${parsedUri.password}` : '';
  return `${parsedUri.username}${passwordSegment}@`;
}

function mergeMongoQueryParams(originalSearchParams, txtRecords) {
  const mergedSearchParams = new URLSearchParams();

  for (const txtRecord of txtRecords) {
    for (const [key, value] of new URLSearchParams(String(txtRecord))) {
      if (!mergedSearchParams.has(key)) {
        mergedSearchParams.set(key, value);
      }
    }
  }

  for (const [key, value] of originalSearchParams) {
    mergedSearchParams.set(key, value);
  }

  if (!mergedSearchParams.has('tls') && !mergedSearchParams.has('ssl')) {
    mergedSearchParams.set('tls', 'true');
  }

  return mergedSearchParams;
}

async function buildStandardMongoUriFromSrvUri(mongoUri) {
  const parsedUri = new URL(mongoUri.replace(/^mongodb\+srv:\/\//, 'http://'));
  const [srvRecords, txtRecords] = await Promise.all([
    resolveWindowsDnsRecord('SRV', parsedUri.hostname),
    resolveWindowsDnsRecord('TXT', parsedUri.hostname).catch(() => []),
  ]);

  if (!srvRecords.length) {
    throw new Error(`No SRV records returned for ${parsedUri.hostname}`);
  }

  const hosts = srvRecords.map(({ NameTarget, Port }) => {
    const hostname = String(NameTarget || '').replace(/\.$/, '');
    const port = Number(Port) || 27017;
    return `${hostname}:${port}`;
  });
  const databasePath = parsedUri.pathname && parsedUri.pathname !== '/' ? parsedUri.pathname : '/';
  const mergedSearchParams = mergeMongoQueryParams(parsedUri.searchParams, txtRecords);
  const credentials = buildMongoCredentials(parsedUri);
  const queryString = mergedSearchParams.toString();

  return `mongodb://${credentials}${hosts.join(',')}${databasePath}${queryString ? `?${queryString}` : ''}`;
}

async function connectDB(mongoUri = process.env.MONGO_URI) {
  const normalizedUri = (mongoUri || '').trim();

  if (!normalizedUri) {
    throw new Error('Missing MONGO_URI');
  }

  try {
    await mongoose.connect(normalizedUri, MONGO_CONNECT_OPTIONS);
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    if (process.platform !== 'win32' || !isMongoSrvUri(normalizedUri) || !isSrvLookupFailure(error)) {
      throw error;
    }

    console.log('MongoDB SRV lookup failed in Node. Retrying with Windows DNS fallback.');

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect().catch(() => {});
    }

    const fallbackUri = await buildStandardMongoUriFromSrvUri(normalizedUri);
    await mongoose.connect(fallbackUri, MONGO_CONNECT_OPTIONS);
    console.log('✅ MongoDB connected successfully');
  }
}

export default connectDB;
