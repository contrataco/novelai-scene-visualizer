/**
 * OpenAI Text Provider — Chat completions for scene analysis and lore features.
 * TEXT-ONLY provider (not image generation).
 * Follows generateTextFn contract: async (messages, options) => { output: string }
 */

const LOG_PREFIX = '[OpenAI-Text]';

const id = 'openai';
const name = 'OpenAI';
const defaultModel = 'gpt-4o-mini';

/**
 * Generate text via OpenAI chat completions API.
 * @param {Array<{role: string, content: string}>} messages
 * @param {{max_tokens?: number, temperature?: number, model?: string}} options
 * @param {import('electron-store')} store
 * @returns {Promise<{output: string}>}
 */
async function generateText(messages, options, store) {
  const apiKey = store.get('openaiApiKey');
  if (!apiKey) throw new Error('OpenAI API key not configured');

  const model = options.model || store.get('openaiModel') || defaultModel;
  const maxTokens = options.max_tokens || 300;
  const temperature = options.temperature || 0.4;

  console.log(`${LOG_PREFIX} Calling ${model} (max_tokens=${maxTokens}, temp=${temperature})`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  let response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('OpenAI API timed out after 60s');
    throw err;
  }

  if (!response.ok) {
    clearTimeout(timeout);
    const text = await response.text();
    const err = new Error(`OpenAI API error ${response.status}: ${text}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  clearTimeout(timeout);
  const content = data.choices?.[0]?.message?.content || '';
  console.log(`${LOG_PREFIX} Response: ${content.length} chars`);
  return { output: content };
}

/**
 * Check if the provider is ready (has API key).
 * @param {import('electron-store')} store
 * @returns {boolean}
 */
function checkReady(store) {
  return !!store.get('openaiApiKey');
}

module.exports = { id, name, defaultModel, generateText, checkReady };
