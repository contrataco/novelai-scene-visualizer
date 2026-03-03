// dom-refs.js — All document.getElementById() calls and constants

// Main elements
export const webview = document.getElementById('novelai');
export const status = document.getElementById('status');
export const settingsModal = document.getElementById('settingsModal');
export const imagePanel = document.getElementById('imagePanel');
export const imageContainer = document.getElementById('imageContainer');
export const loadingIndicator = document.getElementById('loadingIndicator');
export const promptDisplay = document.getElementById('promptDisplay');

// Buttons
export const generateBtn = document.getElementById('generateBtn');
export const sidebarGenerateBtn = document.getElementById('sidebarGenerateBtn');
export const togglePanelBtn = document.getElementById('togglePanelBtn');
export const settingsBtn = document.getElementById('settingsBtn');
export const reloadBtn = document.getElementById('reloadBtn');
export const closePanelBtn = document.getElementById('closePanelBtn');
export const cancelBtn = document.getElementById('cancelBtn');
export const saveBtn = document.getElementById('saveBtn');

// Settings elements -- Provider
export const providerSelect = document.getElementById('provider');

// Settings elements -- NovelAI
export const modelSelect = document.getElementById('model');
export const resolutionPreset = document.getElementById('resolutionPreset');
export const imgWidth = document.getElementById('imgWidth');
export const imgHeight = document.getElementById('imgHeight');
export const samplerSelect = document.getElementById('sampler');
export const noiseScheduleSelect = document.getElementById('noiseSchedule');
export const stepsInput = document.getElementById('steps');
export const scaleInput = document.getElementById('scale');
export const cfgRescaleSlider = document.getElementById('cfgRescale');
export const cfgRescaleValue = document.getElementById('cfgRescaleValue');
export const smeaCheckbox = document.getElementById('smea');
export const smeaDynCheckbox = document.getElementById('smeaDyn');
export const ucPresetSelect = document.getElementById('ucPreset');
export const qualityTagsCheckbox = document.getElementById('qualityTags');
export const v3Options = document.getElementById('v3Options');

// Settings elements -- NovelAI art style
export const novelaiArtStyleSelect = document.getElementById('novelaiArtStyle');

// Settings elements -- Perchance
export const extractKeyBtn = document.getElementById('extractKeyBtn');
export const perchanceKeyDot = document.getElementById('perchanceKeyDot');
export const perchanceKeyText = document.getElementById('perchanceKeyText');
export const perchanceArtStyleSelect = document.getElementById('perchanceArtStyle');
export const perchanceGuidanceSlider = document.getElementById('perchanceGuidance');
export const perchanceGuidanceValue = document.getElementById('perchanceGuidanceValue');

// Settings elements -- Venice AI
export const veniceKeyDot = document.getElementById('veniceKeyDot');
export const veniceKeyText = document.getElementById('veniceKeyText');
export const veniceApiKeyInput = document.getElementById('veniceApiKeyInput');
export const saveVeniceKeyBtn = document.getElementById('saveVeniceKeyBtn');
export const veniceModelSelect = document.getElementById('veniceModel');
export const veniceStepsInput = document.getElementById('veniceSteps');
export const veniceCfgScaleInput = document.getElementById('veniceCfgScale');
export const veniceStylePresetSelect = document.getElementById('veniceStylePreset');
export const veniceSafeModeCheckbox = document.getElementById('veniceSafeMode');
export const veniceHideWatermarkCheckbox = document.getElementById('veniceHideWatermark');

// Settings elements -- Pollo AI
export const polloLoginDot = document.getElementById('polloLoginDot');
export const polloLoginText = document.getElementById('polloLoginText');
export const polloLoginBtn = document.getElementById('polloLoginBtn');
export const polloExtractBtn = document.getElementById('polloExtractBtn');
export const polloModelSelect = document.getElementById('polloModel');
export const polloAspectRatioSelect = document.getElementById('polloAspectRatio');

// Auto-generate toggle
export const autoGenerateToggle = document.getElementById('autoGenerateToggle');

// NovelAI token status elements
export const novelaiTokenDot = document.getElementById('novelaiTokenDot');
export const novelaiTokenText = document.getElementById('novelaiTokenText');

// NovelAI credential elements
export const novelaiEmailInput = document.getElementById('novelaiEmail');
export const novelaiPasswordInput = document.getElementById('novelaiPassword');

// Storyboard elements
export const storyboardBtn = document.getElementById('storyboardBtn');
export const storyboardModal = document.getElementById('storyboardModal');
export const storyboardSelect = document.getElementById('storyboardSelect');
export const sceneList = document.getElementById('sceneList');
export const storyboardCloseBtn = document.getElementById('storyboardCloseBtn');
export const sbNewBtn = document.getElementById('sbNewBtn');
export const sbDeleteBtn = document.getElementById('sbDeleteBtn');
export const sbRenameBtn = document.getElementById('sbRenameBtn');
export const commitBtn = document.getElementById('commitBtn');
export const commitConfirm = document.getElementById('commitConfirm');
export const commitSbName = document.getElementById('commitSbName');
export const commitNoteInput = document.getElementById('commitNoteInput');
export const commitConfirmBtn = document.getElementById('commitConfirmBtn');
export const commitCancelBtn = document.getElementById('commitCancelBtn');
export const commitStoryLabel = document.getElementById('commitStoryLabel');
export const storyIndicator = document.getElementById('storyIndicator');
export const sbLinkBtn = document.getElementById('sbLinkBtn');
export const toastEl = document.getElementById('toast');

// Suggestions elements
export const suggestionsBtn = document.getElementById('suggestionsBtn');
export const suggestionsBadge = document.getElementById('suggestionsBadge');
export const suggestionsPopover = document.getElementById('suggestionsPopover');
export const popoverCloseBtn = document.getElementById('popoverCloseBtn');
export const popoverRegenBtn = document.getElementById('popoverRegenBtn');
export const popoverSettingsBtn = document.getElementById('popoverSettingsBtn');
export const popoverSettings = document.getElementById('popoverSettings');
export const popoverBody = document.getElementById('popoverBody');
export const popoverSuggestionsContainer = document.getElementById('popoverSuggestionsContainer');
export const popoverLoading = document.getElementById('popoverLoading');
export const popoverStatus = document.getElementById('popoverStatus');
export const suggestionsEnabledCheckbox = document.getElementById('suggestionsEnabled');
export const suggestionsAutoShowCheckbox = document.getElementById('suggestionsAutoShow');

// Lore Creator elements
export const sceneTab = document.getElementById('sceneTab');
export const loreTab = document.getElementById('loreTab');
export const memoryTab = document.getElementById('memoryTab');
export const sceneContent = document.getElementById('sceneContent');
export const loreContent = document.getElementById('loreContent');
export const memoryContent = document.getElementById('memoryContent');
export const loreScanBtn = document.getElementById('loreScanBtn');
export const loreOrganizeBtn = document.getElementById('loreOrganizeBtn');
export const loreAcceptAllBtn = document.getElementById('loreAcceptAllBtn');
export const loreClearBtn = document.getElementById('loreClearBtn');
export const loreCleanupSection = document.getElementById('loreCleanupSection');
export const loreCleanupList = document.getElementById('loreCleanupList');
export const loreCleanupCount = document.getElementById('loreCleanupCount');
export const loreCleanupApplyAllBtn = document.getElementById('loreCleanupApplyAllBtn');
export const loreScanStatus = document.getElementById('loreScanStatus');
export const loreScanPhase = document.getElementById('loreScanPhase');
export const loreScanProgressFill = document.getElementById('loreScanProgressFill');
export const loreError = document.getElementById('loreError');
export const lorePendingList = document.getElementById('lorePendingList');
export const lorePendingCount = document.getElementById('lorePendingCount');
export const loreMergesSection = document.getElementById('loreMergesSection');
export const loreMergesList = document.getElementById('loreMergesList');
export const loreMergesCount = document.getElementById('loreMergesCount');
export const loreUpdatesSection = document.getElementById('loreUpdatesSection');
export const loreUpdatesList = document.getElementById('loreUpdatesList');
export const loreUpdatesCount = document.getElementById('loreUpdatesCount');
export const loreLlmIndicator = document.getElementById('loreLlmIndicator');
export const loreCreateInput = document.getElementById('loreCreateInput');
export const loreCreateBtn = document.getElementById('loreCreateBtn');
export const loreCreateCategory = document.getElementById('loreCreateCategory');
export const loreCreatePreview = document.getElementById('loreCreatePreview');
export const loreEnrichInput = document.getElementById('loreEnrichInput');
export const loreEnrichBtn = document.getElementById('loreEnrichBtn');
export const loreEnrichPreview = document.getElementById('loreEnrichPreview');
export const loreEnrichTarget = document.getElementById('loreEnrichTarget');
export const loreEnrichOld = document.getElementById('loreEnrichOld');
export const loreEnrichNew = document.getElementById('loreEnrichNew');
export const loreEnrichAcceptBtn = document.getElementById('loreEnrichAcceptBtn');
export const loreEnrichEditBtn = document.getElementById('loreEnrichEditBtn');
export const loreEnrichRejectBtn = document.getElementById('loreEnrichRejectBtn');

// Lore settings elements
export const loreAutoScan = document.getElementById('loreAutoScan');
export const loreAutoUpdates = document.getElementById('loreAutoUpdates');
export const loreMinChars = document.getElementById('loreMinChars');
export const loreMinCharsValue = document.getElementById('loreMinCharsValue');
export const loreTemp = document.getElementById('loreTemp');
export const loreTempValue = document.getElementById('loreTempValue');
export const loreDetailLevel = document.getElementById('loreDetailLevel');
export const loreLlmSelect = document.getElementById('loreLlmSelect');
export const loreOllamaSettings = document.getElementById('loreOllamaSettings');
export const loreOllamaModelSelect = document.getElementById('loreOllamaModelSelect');
export const loreOllamaRefreshBtn = document.getElementById('loreOllamaRefreshBtn');
export const loreHybridToggle = document.getElementById('loreHybridToggle');

// Lore scan menu
export const loreScanMenu = document.getElementById('loreScanMenu');

// Comprehension elements
export const startProgressiveScanBtn = document.getElementById('startProgressiveScanBtn');
export const pauseProgressiveScanBtn = document.getElementById('pauseProgressiveScanBtn');
export const cancelProgressiveScanBtn = document.getElementById('cancelProgressiveScanBtn');
export const comprehensionStatusText = document.getElementById('comprehensionStatusText');
export const comprehensionProgressFill = document.getElementById('comprehensionProgressFill');
export const masterSummaryDisplay = document.getElementById('masterSummaryDisplay');
export const masterSummaryText = document.getElementById('masterSummaryText');
export const entityProfilesList = document.getElementById('entityProfilesList');
export const entityCount = document.getElementById('entityCount');
export const entityProfileCards = document.getElementById('entityProfileCards');

// Memory DOM refs
export const memoryProxyDot = document.getElementById('memoryProxyDot');
export const memoryProxyText = document.getElementById('memoryProxyText');
export const memoryTokenCount = document.getElementById('memoryTokenCount');
export const memoryTokenPercent = document.getElementById('memoryTokenPercent');
export const memoryTokenBar = document.getElementById('memoryTokenBar');
export const memoryUpdateBtn = document.getElementById('memoryUpdateBtn');
export const memoryRefreshBtn = document.getElementById('memoryRefreshBtn');
export const memoryClearBtn = document.getElementById('memoryClearBtn');
export const memoryProgress = document.getElementById('memoryProgress');
export const memoryProgressText = document.getElementById('memoryProgressText');
export const memoryPreview = document.getElementById('memoryPreview');
export const memoryEventList = document.getElementById('memoryEventList');
export const memoryEventCount = document.getElementById('memoryEventCount');
export const memoryCharList = document.getElementById('memoryCharList');
export const memoryCharCount = document.getElementById('memoryCharCount');
export const memoryAutoUpdate = document.getElementById('memoryAutoUpdate');
export const memoryTokenLimit = document.getElementById('memoryTokenLimit');
export const memoryTokenLimitValue = document.getElementById('memoryTokenLimitValue');
export const memoryCompression = document.getElementById('memoryCompression');
export const memoryCompressionValue = document.getElementById('memoryCompressionValue');
export const memoryKeywords = document.getElementById('memoryKeywords');

// Perchance manual key elements
export const saveManualKeyBtn = document.getElementById('saveManualKeyBtn');
export const perchanceManualKeyInput = document.getElementById('perchanceManualKey');

// Family tree elements
export const familyTreeSection = document.getElementById('familyTreeSection');
export const familyTreeContainer = document.getElementById('familyTreeContainer');
export const familyTreeCount = document.getElementById('familyTreeCount');

// Resolution presets
export const RESOLUTION_PRESETS = {
  'square-sm': { width: 640, height: 640 },
  'square': { width: 832, height: 832 },
  'portrait-sm': { width: 512, height: 768 },
  'portrait': { width: 832, height: 1216 },
  'landscape-sm': { width: 768, height: 512 },
  'landscape': { width: 1216, height: 832 },
};

// V4 models list (for disabling SMEA)
export const V4_MODELS = [
  'nai-diffusion-4-curated-preview',
  'nai-diffusion-4-full',
  'nai-diffusion-4-5-curated',
  'nai-diffusion-4-5-full'
];

// LitRPG elements
export const rpgTab = document.getElementById('rpgTab');
export const rpgContent = document.getElementById('rpgContent');
export const rpgDetectionBanner = document.getElementById('rpgDetectionBanner');
export const rpgEnableBtn = document.getElementById('rpgEnableBtn');
export const rpgDismissBtn = document.getElementById('rpgDismissBtn');
export const rpgSystemIndicator = document.getElementById('rpgSystemIndicator');
export const rpgSystemType = document.getElementById('rpgSystemType');
export const rpgScanBtn = document.getElementById('rpgScanBtn');
export const rpgSyncLorebookBtn = document.getElementById('rpgSyncLorebookBtn');
export const rpgScanStatus = document.getElementById('rpgScanStatus');
export const rpgScanPhase = document.getElementById('rpgScanPhase');
export const rpgPartyList = document.getElementById('rpgPartyList');
export const rpgPartyCount = document.getElementById('rpgPartyCount');
export const rpgQuestListActive = document.getElementById('rpgQuestListActive');
export const rpgQuestListDone = document.getElementById('rpgQuestListDone');
export const rpgQuestCount = document.getElementById('rpgQuestCount');
export const rpgNpcList = document.getElementById('rpgNpcList');
export const rpgNpcCount = document.getElementById('rpgNpcCount');
export const rpgUpdatesList = document.getElementById('rpgUpdatesList');
export const rpgUpdatesSection = document.getElementById('rpgUpdatesSection');
export const rpgUpdatesCount = document.getElementById('rpgUpdatesCount');
export const rpgAutoScan = document.getElementById('rpgAutoScan');
export const rpgAutoSync = document.getElementById('rpgAutoSync');
export const rpgDisableBtn = document.getElementById('rpgDisableBtn');

// Lore categories
export const LORE_CATEGORIES = ['character', 'location', 'item', 'faction', 'concept'];

// Category naming map: entry type -> lorebook category name
export const CATEGORY_NAMES = {
  character: 'Characters',
  location: 'Locations',
  item: 'Items',
  faction: 'Factions',
  concept: 'Concepts',
};
