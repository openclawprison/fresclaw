const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function uploadToR2(buffer, key, contentType = 'image/jpeg') {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));

  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

async function uploadArtwork(signedBuffer, thumbnailBuffer, artworkId) {
  const imageKey = `artworks/${artworkId}.jpg`;
  const thumbKey = `artworks/${artworkId}_thumb.jpg`;

  const [imageUrl, thumbnailUrl] = await Promise.all([
    uploadToR2(signedBuffer, imageKey),
    uploadToR2(thumbnailBuffer, thumbKey),
  ]);

  return { imageUrl, thumbnailUrl };
}

module.exports = { uploadToR2, uploadArtwork };
