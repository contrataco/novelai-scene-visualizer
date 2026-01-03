/**
 * NovelAI Scene Visualizer Script
 *
 * Automatically generates images representing the current story scene.
 * Works in conjunction with the Scene Visualizer Electron app.
 *
 * @version 1.0.0
 * @author ryanrobson
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

interface ScriptSettings {
  autoGenerate: boolean;
  minTextLength: number; // Minimum new text length to trigger generation
  artStyle: string;
  useCharacterLore: boolean; // Pull character descriptions from lorebook
}

interface CharacterAppearance {
  name: string;
  appearance: string;
}

interface ScriptStorage {
  settings: ScriptSettings;
  lastProcessedSectionId: number | null;
  currentImage: string;
  lastPrompt: string;
}

const DEFAULT_SETTINGS: ScriptSettings = {
  autoGenerate: true,
  minTextLength: 100,
  artStyle: 'anime style, detailed, high quality',
  useCharacterLore: true,
};

const DEFAULT_STORAGE: ScriptStorage = {
  settings: DEFAULT_SETTINGS,
  lastProcessedSectionId: null,
  currentImage: '',
  lastPrompt: '',
};

// Processing lock
let isProcessing = false;

// ============================================================================
// STORAGE UTILITIES
// ============================================================================

async function getStorage(): Promise<ScriptStorage> {
  try {
    const stored = await api.v1.storyStorage.get('sceneVisualizerData');
    if (stored) {
      return { ...DEFAULT_STORAGE, ...JSON.parse(stored) };
    }
  } catch (e) {
    api.v1.error('[SceneVis] Error loading storage:', e);
  }
  return { ...DEFAULT_STORAGE };
}

async function saveStorage(data: ScriptStorage): Promise<void> {
  try {
    await api.v1.storyStorage.set('sceneVisualizerData', JSON.stringify(data));
  } catch (e) {
    api.v1.error('[SceneVis] Error saving storage:', e);
  }
}

// ============================================================================
// PROMPT STORAGE (for Electron to read)
// ============================================================================

// Store the latest prompt in a global location that Electron can access
// The prompt is also displayed in the UI panel for visibility
let currentPromptData: { prompt: string; negativePrompt: string } | null = null;

function setCurrentPrompt(prompt: string, negativePrompt: string): void {
  currentPromptData = { prompt, negativePrompt };
  api.v1.log('[SceneVis] Prompt ready for generation');
}

function getCurrentPrompt(): { prompt: string; negativePrompt: string } | null {
  return currentPromptData;
}

// ============================================================================
// CHARACTER LOREBOOK INTEGRATION
// ============================================================================

/**
 * Scans lorebook entries for character appearance descriptions.
 * Looks for entries that contain appearance-related keywords.
 */
async function getCharacterAppearances(): Promise<CharacterAppearance[]> {
  const characters: CharacterAppearance[] = [];

  try {
    const entries = await api.v1.lorebook.entries();

    for (const entry of entries) {
      // Skip disabled entries
      if (!entry.enabled) continue;

      const text = entry.text || '';
      const displayName = entry.displayName || '';
      const keys = entry.keys || [];

      // Look for appearance-related content in the entry
      // Common patterns: "Appearance:", "Physical:", "Looks like:", etc.
      const appearancePatterns = [
        /appearance[:\s]+([^.]+(?:\.[^.]+){0,3})/i,
        /physical(?:\s+description)?[:\s]+([^.]+(?:\.[^.]+){0,3})/i,
        /looks?\s+like[:\s]+([^.]+(?:\.[^.]+){0,2})/i,
        /(?:has|with)\s+([\w\s,]+(?:hair|eyes|skin|build|height)[^.]*)/i,
        /description[:\s]+([^.]+(?:\.[^.]+){0,3})/i,
      ];

      let appearance = '';

      // Try to extract appearance from the entry text
      for (const pattern of appearancePatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          appearance = match[1].trim();
          break;
        }
      }

      // If no specific appearance section, check if entry looks like a character description
      // (contains visual descriptors but is reasonably short)
      if (!appearance && text.length < 500) {
        const visualKeywords = ['hair', 'eyes', 'tall', 'short', 'wears', 'wearing', 'dressed', 'skin', 'face', 'build'];
        const hasVisualContent = visualKeywords.some(kw => text.toLowerCase().includes(kw));

        if (hasVisualContent) {
          // Use the whole entry as appearance (it's likely a character card)
          appearance = text;
        }
      }

      if (appearance) {
        // Use display name or first key as character name
        const name = displayName || (keys.length > 0 ? keys[0] : '');

        if (name) {
          characters.push({
            name: name,
            appearance: appearance.slice(0, 300) // Limit length
          });
        }
      }
    }

    api.v1.log(`[SceneVis] Found ${characters.length} character appearances in lorebook`);
  } catch (e) {
    api.v1.error('[SceneVis] Error reading lorebook:', e);
  }

  return characters;
}

/**
 * Detects which characters from the lorebook are mentioned in the given text.
 */
function detectCharactersInText(text: string, characters: CharacterAppearance[]): CharacterAppearance[] {
  const mentioned: CharacterAppearance[] = [];
  const lowerText = text.toLowerCase();

  for (const char of characters) {
    // Check if character name appears in the text
    if (lowerText.includes(char.name.toLowerCase())) {
      mentioned.push(char);
    }
  }

  return mentioned;
}

/**
 * Builds a character reference string for the image prompt.
 */
function buildCharacterReference(characters: CharacterAppearance[]): string {
  if (characters.length === 0) return '';

  const refs = characters.map(c => `[${c.name}: ${c.appearance}]`);
  return '\n\nCharacter References:\n' + refs.join('\n');
}

// ============================================================================
// SCENE ANALYSIS
// ============================================================================

async function analyzeSceneForImage(storyText: string, characterRefs: string = ''): Promise<{
  prompt: string;
  negativePrompt: string;
}> {
  const storage = await getStorage();

  // Build the system prompt with character reference instructions if available
  let systemContent = `You are an expert at creating image generation prompts. Analyze story text and create a vivid visual prompt that captures the current scene.

Output ONLY a JSON object with this format:
{"prompt": "detailed visual description", "negativePrompt": "things to avoid"}

Guidelines:
- Focus on the CURRENT scene, not backstory
- Describe characters' appearance, poses, expressions
- Include setting details (location, lighting, atmosphere)
- Use comma-separated tags/descriptors
- Add style tags: ${storage.settings.artStyle}
- Keep prompts under 200 words
- For negativePrompt: list common image generation issues to avoid`;

  if (characterRefs) {
    systemContent += `

IMPORTANT: Use the provided Character References for accurate character appearances. Include their visual details (hair color, eye color, clothing, etc.) in the prompt when they appear in the scene.`;
  }

  let userContent = `Create an image prompt for this scene:

${storyText.slice(-2000)}`;

  if (characterRefs) {
    userContent += characterRefs;
  }

  userContent += `

Remember: Output ONLY valid JSON with "prompt" and "negativePrompt" keys.`;

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent }
  ];

  try {
    const response = await api.v1.generate(messages, {
      model: 'glm-4-6',
      max_tokens: 400,
      temperature: 0.7,
    });

    if (response.choices && response.choices.length > 0) {
      const content = response.choices[0].text || '';

      // Parse JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          prompt: parsed.prompt || '',
          negativePrompt: parsed.negativePrompt || 'lowres, bad anatomy, bad hands, text, error, missing fingers',
        };
      }
    }
  } catch (e) {
    api.v1.error('[SceneVis] Error analyzing scene:', e);
  }

  return {
    prompt: '',
    negativePrompt: 'lowres, bad anatomy, bad hands, text, error',
  };
}

// ============================================================================
// MAIN PROCESSING
// ============================================================================

async function processNewContent(): Promise<void> {
  if (isProcessing) {
    api.v1.log('[SceneVis] Already processing, skipping...');
    return;
  }

  const storage = await getStorage();
  if (!storage.settings.autoGenerate) return;

  isProcessing = true;

  try {
    // Get document content
    let storyText = '';
    const sectionIds = await api.v1.document.sectionIds();

    if (sectionIds.length === 0) {
      isProcessing = false;
      return;
    }

    // Collect recent story text
    const scanResults = await api.v1.document.scan();
    for (const { section } of scanResults) {
      if (section.text) {
        storyText += section.text + '\n';
      }
    }

    // Check if we have enough new content
    if (storyText.length < storage.settings.minTextLength) {
      isProcessing = false;
      return;
    }

    // Get character references from lorebook if enabled
    let characterRefs = '';
    if (storage.settings.useCharacterLore) {
      api.v1.log('[SceneVis] Scanning lorebook for characters...');
      const allCharacters = await getCharacterAppearances();
      const recentText = storyText.slice(-3000); // Check recent text for character mentions
      const mentionedCharacters = detectCharactersInText(recentText, allCharacters);

      if (mentionedCharacters.length > 0) {
        api.v1.log(`[SceneVis] Found ${mentionedCharacters.length} characters in scene: ${mentionedCharacters.map(c => c.name).join(', ')}`);
        characterRefs = buildCharacterReference(mentionedCharacters);
      }
    }

    // Analyze scene and generate prompt
    api.v1.log('[SceneVis] Analyzing scene...');
    const { prompt, negativePrompt } = await analyzeSceneForImage(storyText, characterRefs);

    if (!prompt) {
      api.v1.log('[SceneVis] Could not generate prompt');
      isProcessing = false;
      return;
    }

    // Save the prompt for Electron to access
    storage.lastPrompt = prompt;
    await saveStorage(storage);
    setCurrentPrompt(prompt, negativePrompt);

    // Update panel to show new prompt
    if (panelUpdateFn) await panelUpdateFn();

    api.v1.ui.toast('Scene prompt ready! Click Generate in Electron toolbar.', { autoClose: 3000 });

  } catch (e) {
    api.v1.error('[SceneVis] Error processing:', e);
  } finally {
    isProcessing = false;
  }
}

async function forceGenerate(): Promise<void> {
  isProcessing = false;
  const storage = await getStorage();
  storage.settings.autoGenerate = true;
  await saveStorage(storage);
  await processNewContent();
}

// ============================================================================
// UI PANEL
// ============================================================================

let panelUpdateFn: (() => Promise<void>) | null = null;

async function createUIPanel(): Promise<void> {
  const buildPanel = async () => {
    const storage = await getStorage();
    const hasPrompt = storage.lastPrompt.length > 0;

    const content: any[] = [
      // Header
      api.v1.ui.part.text({
        text: 'Scene Visualizer',
        style: { fontWeight: 'bold', fontSize: '16px', marginBottom: '8px' }
      }),

      // Instructions
      api.v1.ui.part.text({
        text: 'Prompts are generated automatically. Use the Electron toolbar to generate images.',
        style: { fontSize: '12px', color: '#888', marginBottom: '12px' }
      }),
    ];

    // Current prompt display (with special ID for Electron to find)
    content.push(
      api.v1.ui.part.text({
        text: 'Current Prompt:',
        style: { fontWeight: 'bold', marginBottom: '4px', fontSize: '12px' }
      })
    );

    // Prompt text area - Electron will read this
    content.push(
      api.v1.ui.part.multilineTextInput({
        initialValue: storage.lastPrompt || '(No prompt yet - generate some story content)',
        placeholder: 'Scene prompt will appear here...',
        style: {
          marginBottom: '12px',
          fontFamily: 'monospace',
          fontSize: '11px',
          minHeight: '100px'
        }
      })
    );

    // Generate Prompt button
    content.push(
      api.v1.ui.part.button({
        text: hasPrompt ? 'Regenerate Prompt' : 'Generate Prompt',
        callback: async () => {
          await forceGenerate();
        },
        style: { marginBottom: '12px' }
      })
    );

    // Settings
    content.push(
      api.v1.ui.part.collapsibleSection({
        title: 'Settings',
        initialCollapsed: true,
        content: [
          api.v1.ui.part.row({
            content: [
              api.v1.ui.part.text({
                text: 'Auto-generate prompts:',
                style: { flex: '1' }
              }),
              api.v1.ui.part.checkboxInput({
                initialValue: storage.settings.autoGenerate,
                onChange: async (checked: boolean) => {
                  const s = await getStorage();
                  s.settings.autoGenerate = checked;
                  await saveStorage(s);
                  api.v1.ui.toast(checked ? 'Auto-generate enabled' : 'Auto-generate disabled', { autoClose: 2000 });
                }
              }),
            ],
            style: { marginBottom: '8px' }
          }),
          api.v1.ui.part.row({
            content: [
              api.v1.ui.part.text({
                text: 'Use character lore:',
                style: { flex: '1' }
              }),
              api.v1.ui.part.checkboxInput({
                initialValue: storage.settings.useCharacterLore,
                onChange: async (checked: boolean) => {
                  const s = await getStorage();
                  s.settings.useCharacterLore = checked;
                  await saveStorage(s);
                  api.v1.ui.toast(checked ? 'Character lore enabled' : 'Character lore disabled', { autoClose: 2000 });
                }
              }),
            ],
            style: { marginBottom: '8px' }
          }),
          api.v1.ui.part.text({
            text: 'Pulls character appearance from lorebook entries for consistent visuals.',
            style: { fontSize: '10px', color: '#666', marginBottom: '12px', marginLeft: '4px' }
          }),
          api.v1.ui.part.text({
            text: 'Art Style Tags:',
            style: { marginBottom: '4px', fontSize: '12px' }
          }),
          api.v1.ui.part.textInput({
            initialValue: storage.settings.artStyle,
            placeholder: 'e.g., anime style, oil painting, watercolor',
            onChange: async (value: string) => {
              const s = await getStorage();
              s.settings.artStyle = value;
              await saveStorage(s);
            },
            style: { marginBottom: '8px' }
          }),
          api.v1.ui.part.text({
            text: 'Min text length for auto-generate:',
            style: { marginBottom: '4px', fontSize: '12px' }
          }),
          api.v1.ui.part.sliderInput({
            initialValue: storage.settings.minTextLength,
            min: 50,
            max: 500,
            step: 50,
            label: `${storage.settings.minTextLength} characters`,
            onChange: async (value: number) => {
              const s = await getStorage();
              s.settings.minTextLength = value;
              await saveStorage(s);
            }
          }),
        ]
      })
    );

    return api.v1.ui.part.column({
      content,
      style: { padding: '12px' }
    });
  };

  const updatePanel = async () => {
    try {
      const panel = await buildPanel();
      await api.v1.ui.update([
        {
          type: 'scriptPanel' as const,
          id: 'sceneVisualizerPanel',
          name: 'Scene Visualizer',
          content: [panel]
        }
      ]);
    } catch (e) {
      api.v1.error('[SceneVis] Error updating panel:', e);
    }
  };

  panelUpdateFn = updatePanel;

  // Register panel
  try {
    const initialPanel = await buildPanel();
    await api.v1.ui.register([
      api.v1.ui.extension.scriptPanel({
        id: 'sceneVisualizerPanel',
        name: 'Scene Visualizer',
        content: [initialPanel]
      })
    ]);
  } catch (e) {
    api.v1.error('[SceneVis] Error creating panel:', e);
  }
}

// ============================================================================
// HOOK REGISTRATION
// ============================================================================

function registerHooks(): void {
  api.v1.hooks.register('onGenerationEnd', async () => {
    try {
      await processNewContent();
      if (panelUpdateFn) await panelUpdateFn();
    } catch (e) {
      api.v1.error('[SceneVis] Error in hook:', e);
    }
  });
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initialize(): Promise<void> {
  try {
    api.v1.log('[SceneVis] Initializing Scene Visualizer...');

    await getStorage();
    await createUIPanel();
    registerHooks();

    api.v1.ui.toast('Scene Visualizer loaded', { autoClose: 3000, type: 'success' });
    api.v1.log('[SceneVis] Initialization complete');

  } catch (e) {
    api.v1.error('[SceneVis] Initialization failed:', e);
    api.v1.ui.toast('Scene Visualizer failed to load', { autoClose: 5000, type: 'error' });
  }
}

// Start
initialize();
