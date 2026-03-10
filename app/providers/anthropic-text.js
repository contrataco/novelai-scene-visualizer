/**
 * Anthropic Text Provider — Messages API for scene analysis and lore features.
 * TEXT-ONLY provider (not image generation).
 * Follows generateTextFn contract: async (messages, options) => { output: string }
 */

const LOG_PREFIX = '[Anthropic-Text]';

const id = 'anthropic';
const name = 'Anthropic';
const defaultModel = 'claude-sonnet-4-20250514';

/**
 * Generate text via Anthropic Messages API.
 * Converts OpenAI-style messages to Anthropic format (system separate from messages).
 * @param {Array<{role: string, content: string}>} messages
 * @param {{max_tokens?: number, temperature?: number, model?: string}} options
 * @param {import('electron-store')} store
 * @returns {Promise<{output: string}>}
 */
async function generateText(messages, options, store) {
  const apiKey = store.get('anthropicApiKey');
  if (!apiKey) throw new Error('Anthropic API key not configured');

  const model = options.model || store.get('anthropicModel') || defaultModel;
  const maxTokens = options.max_tokens || 300;
  const temperature = options.temperature || 0.4;

  // Extract system message and convert to Anthropic format
  let system = '';
  const userMessages = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      system = msg.content;
    } else {
      userMessages.push({ role: msg.role, content: msg.content });
    }
  }

  // Anthropic requires at least one user message
  if (userMessages.length === 0) {
    userMessages.push({ role: 'user', content: system || 'Hello' });
    system = '';
  }

  console.log(`${LOG_PREFIX} Calling ${model} (max_tokens=${maxTokens}, temp=${temperature})`);

  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: userMessages,
  };
  if (system) body.system = system;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Anthropic API timed out after 60s');
    throw err;
  }

  if (!response.ok) {
    clearTimeout(timeout);
    const text = await response.text();
    const err = new Error(`Anthropic API error ${response.status}: ${text}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  clearTimeout(timeout);
  const content = data.content?.[0]?.text || '';
  console.log(`${LOG_PREFIX} Response: ${content.length} chars`);
  return { output: content };
}

/**
 * Check if the provider is ready (has API key).
 * @param {import('electron-store')} store
 * @returns {boolean}
 */
function checkReady(store) {
  return !!store.get('anthropicApiKey');
}

module.exports = { id, name, defaultModel, generateText, checkReady };
