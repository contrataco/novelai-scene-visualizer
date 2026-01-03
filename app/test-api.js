const Store = require('electron-store');
const AdmZip = require('adm-zip');

const store = new Store({
  encryptionKey: 'novelai-scene-visualizer-key',
  name: 'config'
});

const apiToken = store.get('apiToken');
console.log('Token found:', apiToken ? 'Yes' : 'No');

async function testGenerate() {
  const prompt = 'a fantasy castle at sunset, anime style';
  const negativePrompt = 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing';
  const seed = Math.floor(Math.random() * 4294967295);

  const requestBody = {
    model: 'nai-diffusion-4-curated-preview',
    action: 'generate',
    input: prompt,
    parameters: {
      width: 640,
      height: 640,
      steps: 28,
      scale: 5,
      sampler: 'k_euler_ancestral',
      n_samples: 1,
      seed: seed,
      negative_prompt: negativePrompt,
      // V4 model required parameters
      params_version: 3,
      legacy: false,
      legacy_uc: false,
      legacy_v3_extend: false,
      cfg_rescale: 0,
      controlnet_strength: 1,
      dynamic_thresholding: true,
      skip_cfg_above_sigma: null,
      noise_schedule: 'karras',
      qualityToggle: true,
      sm: false,
      sm_dyn: false,
      autoSmea: true,
      use_coords: false,
      prefer_brownian: true,
      deliberate_euler_ancestral_bug: false,
      // V4 prompt structures (required)
      v4_prompt: {
        use_coords: false,
        use_order: true,
        caption: {
          base_caption: prompt + ', rating:general, best quality, very aesthetic, absurdres',
          char_captions: []
        }
      },
      v4_negative_prompt: {
        legacy_uc: false,
        caption: {
          base_caption: negativePrompt,
          char_captions: []
        }
      }
    }
  };

  console.log('Making API request...');

  try {
    const response = await fetch('https://image.novelai.net/ai/generate-image', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiToken,
        'Content-Type': 'application/json',
        'Accept': 'application/zip'
      },
      body: JSON.stringify(requestBody)
    });

    console.log('Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.log('Error response:', errorText);
      return;
    }

    const arrayBuffer = await response.arrayBuffer();
    console.log('Response size:', arrayBuffer.byteLength, 'bytes');

    const buffer = Buffer.from(arrayBuffer);
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    console.log('ZIP entries:', entries.map(e => e.entryName));

    const imageEntry = entries.find(e => e.entryName.endsWith('.png') || e.entryName.endsWith('.jpg'));
    if (imageEntry) {
      console.log('Image found:', imageEntry.entryName, 'size:', imageEntry.getData().length, 'bytes');
      console.log('SUCCESS! API is working correctly');
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

testGenerate();
