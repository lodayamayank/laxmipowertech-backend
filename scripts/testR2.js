import "dotenv/config";
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const acct = process.env.R2_ACCOUNT_ID;
const bucket = process.env.R2_BUCKET_NAME;
console.log(
  "Key ID starts with:",
  process.env.R2_ACCESS_KEY_ID.slice(0, 4),
  "| bucket:",
  bucket,
  "\n",
);

const client = (endpoint) =>
  new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

const attempt = async (label, fn) => {
  try {
    const out = await fn();
    console.log("  OK  ", label, out || "");
  } catch (e) {
    console.log(
      "  FAIL",
      label,
      "->",
      e.name,
      e.$metadata?.httpStatusCode || "",
    );
  }
};

for (const [name, host] of [
  ["default", ""],
  ["EU", "eu."],
  ["FedRAMP", "fedramp."],
]) {
  console.log(`Endpoint: ${name}`);
  const s3 = client(`https://${acct}.${host}r2.cloudflarestorage.com`);
  await attempt("list buckets", async () =>
    JSON.stringify(
      (await s3.send(new ListBucketsCommand({}))).Buckets.map((b) => b.Name),
    ),
  );
  await attempt("list objects in your bucket", () =>
    s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 })),
  );
  await attempt("write test object", () =>
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "diagnose.txt",
        Body: "hello",
      }),
    ),
  );
  await attempt("delete test object", () =>
    s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: "diagnose.txt" })),
  );
  console.log("");
}
