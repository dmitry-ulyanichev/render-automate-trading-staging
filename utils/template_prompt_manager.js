// automate_trading/utils/template_prompt_manager.js


/**
 * TemplatePromptManager - Centralized management of templates and prompts
 * Handles loading, caching, and retrieval of message templates and AI prompts
 */
class TemplatePromptManager {
  constructor(config, logger, httpClient) {
    this.config = config;
    this.logger = logger;
    this.httpClient = httpClient;
    
    // Templates cache
    this.templates = null;
    this.templatesLoadedAt = null;

    // Prompts cache
    this.prompts = null;
    this.promptsLoadedAt = null;
  }

  /**
   * Initialize templates and prompts loading
   */
  async initializeTemplatesPrompts() {
    await this.loadTemplates();
    await this.loadPrompts();
  }

  /**
   * Load templates from API and store in memory
   */
  async loadTemplates() {
    try {
      this.logger.info('TemplatePromptManager: Loading message templates from API...');
      
      const response = await this.httpClient.get('/templates');
      
      if (response.success) {
        this.templates = response.data;
        this.templatesLoadedAt = new Date().toISOString();
        
        this.logger.info(`TemplatePromptManager: Successfully loaded ${response.scenarios_count} template scenarios`);
        
        // Log available scenarios for debugging
        // const scenarios = Object.keys(this.templates);
        // this.logger.info(`TemplatePromptManager: Available scenarios: ${scenarios.join(', ')}`);
      } else {
        this.logger.error(`TemplatePromptManager: Failed to load templates: ${response.error}`);
        this.templates = {}; // Fallback to empty object
      }
      
    } catch (error) {
      this.logger.error(`TemplatePromptManager: Error loading templates: ${error.message}`);
      this.templates = {}; // Fallback to empty object
    }
  }

  /**
   * Load prompts from API and store in memory
   */
  async loadPrompts() {
    try {
      this.logger.info('TemplatePromptManager: Loading AI prompts from API...');
      
      const response = await this.httpClient.get('/prompts');
      
      if (response.success) {
        this.prompts = response.data;
        this.promptsLoadedAt = new Date().toISOString();
        
        this.logger.info(`TemplatePromptManager: Successfully loaded ${response.scenarios_count} prompt scenarios`);
        
        // Log available scenarios for debugging
        // const scenarios = Object.keys(this.prompts).filter(key => key !== 'general_guidelines');
        // this.logger.info(`TemplatePromptManager: Available prompt scenarios: ${scenarios.join(', ')}`);
      } else {
        this.logger.error(`TemplatePromptManager: Failed to load prompts: ${response.error}`);
        this.prompts = {}; // Fallback to empty object
      }
      
    } catch (error) {
      this.logger.error(`TemplatePromptManager: Error loading prompts: ${error.message}`);
      this.prompts = {}; // Fallback to empty object
    }
  }

  /**
   * Get template for specific scenario and language
   * @param {string} scenario - Template scenario name
   * @param {string} language - Target language (defaults to 'English')
   * @returns {Object} Template result with messages, variables, and metadata
   */
  getTemplate(scenario, language = 'English') {
    if (!this.templates) {
      this.logger.warn('TemplatePromptManager: Templates not loaded yet');
      return {
        found: false,
        reason: 'templates_not_loaded',
        fallbackMessages: null,
        targetLanguage: language
      };
    }

    // Check if scenario exists
    if (!this.templates[scenario]) {
      this.logger.warn(`TemplatePromptManager: Template scenario '${scenario}' not found`);
      return {
        found: false,
        reason: 'scenario_not_found',
        fallbackMessages: null,
        targetLanguage: language,
        availableScenarios: Object.keys(this.templates)
      };
    }

    // Check if language exists for this scenario
    if (!this.templates[scenario][language]) {
      this.logger.info(`TemplatePromptManager: Template for scenario '${scenario}' and language '${language}' not found, using English fallback`);
      
      // Return English fallback if available
      const englishTemplate = this.templates[scenario]['English'];
      return {
        found: false,
        reason: 'language_not_found',
        fallbackMessages: englishTemplate || null,
        fallbackLanguage: 'English',
        targetLanguage: language,
        variables: this.templates[scenario].variables || [],
        availableLanguages: Object.keys(this.templates[scenario]).filter(key => key !== 'variables')
      };
    }

    // Return requested template
    return {
      found: true,
      scenario: scenario,
      language: language,
      messages: this.templates[scenario][language],
      variables: this.templates[scenario].variables || []
    };
  }

  /**
   * Build complete AI prompt for specific scenario with variable substitution
   * Supports both legacy (text-based) and new (assembly-based) prompt formats
   * @param {string} scenario - Prompt scenario name
   * @param {Object} variables - Variables to substitute in prompt (e.g., {LANGUAGE: 'Spanish'})
   * @returns {Object} Complete prompt result with text and metadata
   */
  buildPrompt(scenario, variables = {}) {
    if (!this.prompts) {
      this.logger.warn('TemplatePromptManager: Prompts not loaded yet');
      return {
        success: false,
        reason: 'prompts_not_loaded',
        prompt: null
      };
    }

    // Check if scenario exists
    if (!this.prompts[scenario]) {
      this.logger.warn(`TemplatePromptManager: Prompt scenario '${scenario}' not found`);
      return {
        success: false,
        reason: 'scenario_not_found',
        prompt: null,
        availableScenarios: Object.keys(this.prompts).filter(key => !['general_guidelines', 'context_parts'].includes(key))
      };
    }

    try {
      const scenarioData = this.prompts[scenario];
      
      // Check if this is an assembly-based scenario
      if (scenarioData.assembly && Array.isArray(scenarioData.assembly)) {
        return this.buildAssemblyPrompt(scenario, scenarioData, variables);
      }
      
      // Legacy text-based scenario (backwards compatibility)
      return this.buildLegacyPrompt(scenario, scenarioData, variables);
      
    } catch (error) {
      this.logger.error(`TemplatePromptManager: Error building prompt: ${error.message}`);
      return {
        success: false,
        reason: 'build_error',
        error: error.message,
        prompt: null
      };
    }
  }

  /**
   * Build prompt using assembly-based format (new modular approach)
   * @private
   */
  buildAssemblyPrompt(scenario, scenarioData, variables) {
    const parts = [];
    
    for (const partRef of scenarioData.assembly) {
      try {
        const partText = this.resolvePromptPart(partRef, variables);
        if (partText) {
          parts.push(partText);
        }
      } catch (error) {
        this.logger.warn(`TemplatePromptManager: Failed to resolve part '${partRef}': ${error.message}`);
        // Continue with other parts even if one fails
      }
    }
    
    if (parts.length === 0) {
      return {
        success: false,
        reason: 'no_parts_resolved',
        prompt: null
      };
    }
    
    // Join all parts with double newlines for readability
    const completePrompt = parts.join('\n\n');
    
    this.logger.info(`TemplatePromptManager: Built assembly-based prompt for scenario '${scenario}' with ${parts.length} parts`);
    
    return {
      success: true,
      scenario: scenario,
      prompt: completePrompt,
      variables: variables,
      parts_count: parts.length,
      assembly_based: true
    };
  }

  /**
   * Build prompt using legacy text-based format (backwards compatibility)
   * @private
   */
  buildLegacyPrompt(scenario, scenarioData, variables) {
    const parts = [];
    
    // Add scenario-specific part first
    let scenarioText = scenarioData.text;
    
    // Replace variables in scenario text
    for (const [key, value] of Object.entries(variables)) {
      scenarioText = scenarioText.replace(new RegExp(`<${key}>`, 'g'), value);
    }
    
    parts.push(scenarioText);
    
    // Add general guidelines parts
    if (this.prompts.general_guidelines) {
      if (this.prompts.general_guidelines.response_format) {
        parts.push(this.prompts.general_guidelines.response_format.text);
      }
      
      if (this.prompts.general_guidelines.message_guidelines) {
        parts.push(this.prompts.general_guidelines.message_guidelines.text);
      }
      
      if (this.prompts.general_guidelines.important_rules) {
        parts.push(this.prompts.general_guidelines.important_rules.text);
      }
    }
    
    // Join all parts with newlines
    const completePrompt = parts.join('\n');
    
    this.logger.info(`TemplatePromptManager: Built legacy prompt for scenario '${scenario}' with variables: ${Object.keys(variables).join(', ')}`);
    
    return {
      success: true,
      scenario: scenario,
      prompt: completePrompt,
      variables: variables,
      parts_count: parts.length,
      assembly_based: false
    };
  }

  /**
   * Resolve a single prompt part reference
   * Supports: "context_parts.X", "template:X", "general_guidelines.X"
   * Now also supports variable substitution in part references (e.g., "template:follow_up_<FOLLOW_UP_NUMBER>")
   * @private
   */
  resolvePromptPart(partRef, variables) {
    // First, substitute any variables in the partRef itself
    // This allows dynamic part references like "template:follow_up_private_inventory_<FOLLOW_UP_NUMBER>"
    const resolvedPartRef = this.substituteVariables(partRef, variables);
    
    // Handle context_parts references
    if (resolvedPartRef.startsWith('context_parts.')) {
      const partName = resolvedPartRef.substring('context_parts.'.length);
      if (this.prompts.context_parts && this.prompts.context_parts[partName]) {
        return this.substituteVariables(this.prompts.context_parts[partName].text, variables);
      }
      throw new Error(`Context part '${partName}' not found`);
    }
    
    // Handle template references
    if (resolvedPartRef.startsWith('template:')) {
      const templateName = resolvedPartRef.substring('template:'.length);
      return this.formatTemplateForPrompt(templateName, variables);
    }
    
    // Handle general_guidelines references
    if (resolvedPartRef.startsWith('general_guidelines.')) {
      const guidelineName = resolvedPartRef.substring('general_guidelines.'.length);
      if (this.prompts.general_guidelines && this.prompts.general_guidelines[guidelineName]) {
        return this.substituteVariables(this.prompts.general_guidelines[guidelineName].text, variables);
      }
      throw new Error(`Guideline '${guidelineName}' not found`);
    }
    
    throw new Error(`Unknown part reference format: '${resolvedPartRef}'`);
  }

  /**
   * Format a template for inclusion in a prompt
   * Substitutes template variables (e.g., {skinName}) before returning
   * @private
   */
  formatTemplateForPrompt(templateName, variables) {
    if (!this.templates || !this.templates[templateName]) {
      throw new Error(`Template '${templateName} not found`);
    }

    const template = this.templates[templateName];

    // Get English version (the base template to show as example)
    let englishMessages = template.English;
    if (!englishMessages || !Array.isArray(englishMessages)) {
      throw new Error(`Template '${templateName}' has no English version`);
    }

    // Substitute template variables in each message
    // Template variables use {varName} format (curly braces)
    if (variables && Object.keys(variables).length > 0) {
      englishMessages = englishMessages.map(message => {
        let processedMessage = message;
        for (const [key, value] of Object.entries(variables)) {
          // Convert UPPER_CASE keys to camelCase for template matching
          // e.g., SKIN_NAME -> skinName
          const camelKey = this.convertToCamelCase(key);
          processedMessage = processedMessage.replace(new RegExp(`\\{${camelKey}\\}`, 'g'), value);
        }
        return processedMessage;
      });
    }

    // Format the messages as they would appear in the prompt
    const formattedMessages = englishMessages.join('\n');

    return formattedMessages;
  }

  /**
   * Convert UPPER_CASE or snake_case to camelCase
   * @private
   */
  convertToCamelCase(str) {
    // If no underscores and not all uppercase, assume already camelCase
    if (!str.includes('_') && str !== str.toUpperCase()) {
      return str;
    }

    // Convert UPPER_CASE or snake_case to camelCase
    return str.toLowerCase().replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
  }

  /**
   * Substitute variables in text
   * @private
   */
  substituteVariables(text, variables) {
    let result = text;
    for (const [key, value] of Object.entries(variables)) {
      result = result.replace(new RegExp(`<${key}>`, 'g'), value);
    }
    return result;
  }

  /**
   * Map template name to its corresponding translation scenario
   * This allows different templates to use different translation prompts
   * @param {string} templateName - Name of the template to translate
   * @returns {string|null} Translation scenario name or null if not mapped
   */
  getTranslationScenario(templateName) {
    // Map template names to their translation scenarios
    const templateToScenarioMap = {
      'ask_open_inventory': 'translate_ask_open_inventory_first_contact',
      'ask_open_inventory_gameinvite': 'translate_ask_open_inventory_first_contact',
      'follow_up_private_inventory': 'translate_ask_open_inventory_follow_up',
      'request_cases_as_gift': 'translate_request_cases_as_gift_first_contact',
      'follow_up_request_cases_as_gift': 'translate_request_cases_as_gift_follow_up',
      'request_skins_as_gift': 'translate_request_skins_as_gift_first_contact',
      'follow_up_request_skins_as_gift': 'translate_request_skins_as_gift_follow_up',
      'redirect_to_base': 'translate_redirect_to_base_first_contact',
      'redirect_to_base_gameinvite': 'translate_redirect_to_base_first_contact',
      'follow_up_redirect_to_base': 'translate_redirect_to_base_follow_up',
      'trade_initiation_match': 'translate_trade_initiation_match',
      'trade_initiation_match_gameinvite': 'translate_trade_initiation_match',
      'trade_initiation_reserve_pipeline': 'translate_trade_initiation_reserve_pipeline',
      'trade_initiation_reserve_pipeline_gameinvite': 'translate_trade_initiation_reserve_pipeline',
      'no_inventory_but_interested': 'translate_no_inventory_but_interested',
      'no_inventory_but_interested_gameinvite': 'translate_no_inventory_but_interested',
      'follow_up_trade': 'translate_trade_follow_up',
      // Add more mappings as you create more translation scenarios
    };

    // Strip numeric suffix from follow-up templates (e.g., follow_up_trade_2 → follow_up_trade)
    const normalizedName = templateName.startsWith('follow_up')
      ? templateName.replace(/_[0-3]$/, '')
      : templateName;

    return templateToScenarioMap[normalizedName] || null;
  }

  /**
   * Get cache status information
   */
  getCacheStatus() {
    return {
      templates: {
        loaded: !!this.templates,
        loadedAt: this.templatesLoadedAt,
        scenarioCount: this.templates ? Object.keys(this.templates).length : 0
      },
      prompts: {
        loaded: !!this.prompts,
        loadedAt: this.promptsLoadedAt,
        scenarioCount: this.prompts ? Object.keys(this.prompts).filter(key => key !== 'general_guidelines').length : 0
      }
    };
  }

  /**
   * Clear cache and force reload
   */
  async clearCache() {
    this.templates = null;
    this.templatesLoadedAt = null;
    this.prompts = null;
    this.promptsLoadedAt = null;
    
    this.logger.info('TemplatePromptManager: Cache cleared');
  }

  /**
   * Reload templates and prompts
   */
  async reload() {
    await this.clearCache();
    await this.initializeTemplatesPrompts();
  }
}

module.exports = TemplatePromptManager;