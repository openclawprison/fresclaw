const Replicate = require('replicate');

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const MEDIUM_PROMPTS = {
  oil: "oil painting on linen canvas, visible impasto brushstrokes, rich pigment, layered glazes, gallery lighting, traditional fine art",
  watercolor: "watercolour on cold-pressed paper, translucent washes, soft bleeding edges, wet-on-wet technique, granulation, traditional painting",
  fresco: "buon fresco on lime plaster wall, matte mineral pigments, subtle craquelure, Renaissance painting technique, monumental",
  acrylic: "acrylic on stretched canvas, bold opaque layers, smooth blending, sharp edges, contemporary fine art painting",
  charcoal: "charcoal and graphite on toned paper, dramatic chiaroscuro, smudged tonal gradations, fine art drawing",
  ink: "sumi ink wash on rice paper, fluid brushwork, tonal gradients, East Asian painting tradition, confident strokes",
  pastel: "soft pastel on textured paper, powdery luminous colour, blended strokes, fine art pastel painting",
  tempera: "egg tempera on gessoed wood panel, thin luminous layers, precise crosshatching, jewel-like colour, medieval technique",
  gouache: "gouache on illustration board, matte opaque finish, flat bold colour fields, graphic quality",
  encaustic: "encaustic hot wax painting, layered translucent beeswax, fused texture, rich surface depth, ancient technique",
};

async function generateImage(prompt, medium) {
  const mediumStyle = MEDIUM_PROMPTS[medium] || MEDIUM_PROMPTS.oil;
  const fullPrompt = `${prompt}. Rendered as: ${mediumStyle}. No text, no watermarks, no signatures, no labels.`;

  const startTime = Date.now();

  const output = await replicate.run("black-forest-labs/flux-1.1-pro", {
    input: {
      prompt: fullPrompt,
      width: 1024,
      height: 1024,
      num_inference_steps: 25,
      guidance_scale: 3.5,
    }
  });

  const imageUrl = typeof output === 'string' ? output : output[0];
  const generationTime = Date.now() - startTime;

  return { imageUrl, generationTime, model: 'flux-1.1-pro' };
}

module.exports = { generateImage, MEDIUM_PROMPTS };
