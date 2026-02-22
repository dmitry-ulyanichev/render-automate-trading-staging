// automate_trading/utils/language_utils.js

/**
 * Utility class for handling language object operations
 * Provides common methods for reading/checking language detection objects
 */
class LanguageUtils {
  /**
   * Extract current language string from language object
   * @param {Object|null} languageObj - Language object
   * @returns {string|null} Current language or null if not detected
   */
  static getCurrentLanguage(languageObj) {
    if (!languageObj || typeof languageObj !== 'object') {
      return null;
    }
    
    return languageObj.current_language || null;
  }

  /**
   * Check if language is detected/known
   * @param {Object|null} languageObj - Language object
   * @returns {boolean} True if language is detected
   */
  static isLanguageKnown(languageObj) {
    const current = this.getCurrentLanguage(languageObj);
    return current !== null && current.trim() !== '';
  }

  /**
   * Check if specific language detection method was used
   * @param {Object|null} languageObj - Language object
   * @param {string} method - Method to check ('country', 'friends_analysis', etc.)
   * @returns {boolean} True if method was used
   */
  static wasMethodUsed(languageObj, method) {
    if (!languageObj || typeof languageObj !== 'object') {
      return false;
    }
    
    return Array.isArray(languageObj.methods_used) && 
           languageObj.methods_used.includes(method);
  }

  /**
   * Get all candidates with their scores
   * @param {Object|null} languageObj - Language object
   * @returns {Array} Array of {language, score} objects
   */
  static getCandidates(languageObj) {
    if (!languageObj || typeof languageObj !== 'object') {
      return [];
    }
    
    return Array.isArray(languageObj.candidates) ? languageObj.candidates : [];
  }

  /**
   * Get methods used for language detection
   * @param {Object|null} languageObj - Language object
   * @returns {Array} Array of method strings
   */
  static getMethodsUsed(languageObj) {
    if (!languageObj || typeof languageObj !== 'object') {
      return [];
    }
    
    return Array.isArray(languageObj.methods_used) ? languageObj.methods_used : [];
  }

  /**
   * Create default language object structure
   * @returns {Object} Empty language object with proper structure
   */
  static createDefaultLanguageObject() {
    return {
      current_language: null,
      candidates: [],
      methods_used: [],
      last_updated: null
    };
  }

  /**
   * Validate language object structure
   * @param {any} languageObj - Object to validate
   * @returns {boolean} True if valid structure
   */
  static isValidLanguageObject(languageObj) {
    if (!languageObj || typeof languageObj !== 'object') {
      return false;
    }
    
    return (
      'current_language' in languageObj &&
      'candidates' in languageObj &&
      'methods_used' in languageObj &&
      'last_updated' in languageObj &&
      Array.isArray(languageObj.candidates) &&
      Array.isArray(languageObj.methods_used)
    );
  }
}

module.exports = LanguageUtils;