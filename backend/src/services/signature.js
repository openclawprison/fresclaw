const sharp = require('sharp');

async function addSignature(imageBuffer, signature) {
  if (!signature) return imageBuffer;

  // Escape XML special characters
  const escaped = signature.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const svg = `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">
    <text x="994" y="1000" text-anchor="end"
      font-family="Georgia, serif" font-style="italic" font-size="18"
      fill="rgba(0,0,0,0.35)">${escaped}</text>
  </svg>`;

  return sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function createThumbnail(imageBuffer, width = 300) {
  return sharp(imageBuffer)
    .resize(width)
    .jpeg({ quality: 80 })
    .toBuffer();
}

module.exports = { addSignature, createThumbnail };
