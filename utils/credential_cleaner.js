// automate_trading/utils/credential_cleaner.js

/**
 * Utility functions for cleaning Steam credentials from environment variables
 */
class CredentialCleaner {
  
  /**
   * Clean password value - removes comments after whitespace
   * Expected format: PASSWORD_VALUE # optional comment
   * @param {string} rawPassword - Raw password value from environment
   * @returns {string} - Cleaned password without comments
   */
  static cleanPassword(rawPassword) {
    if (!rawPassword) {
      throw new Error('Password value is empty or undefined');
    }
    
    // Take only the part before the first whitespace (handles comments)
    const cleanPassword = rawPassword.split(/\s+/)[0];
    
    if (!cleanPassword) {
      throw new Error('Password value is empty after cleaning');
    }
    
    return cleanPassword;
  }

  /**
   * Load and clean credentials for a Steam account
   * @param {string} steamLogin - Steam login username
   * @param {string} envFilePath - Path to environment file (default: .env.steam.portion)
   * @returns {Object} - Object with cleaned username, password, and sharedSecret
   */
  static loadCleanCredentials(steamLogin, envFilePath = '.env.steam.portion') {
    // Load environment variables from specified file
    require('dotenv').config({ path: envFilePath });
    
    const passwordKey = `STEAM_PASSWORD_${steamLogin.toUpperCase()}`;
    const sharedSecretKey = `STEAM_SHAREDSECRET_${steamLogin.toUpperCase()}`;
    
    const rawPassword = process.env[passwordKey];
    const rawSharedSecret = process.env[sharedSecretKey];
    
    if (!rawPassword) {
      throw new Error(`Password not found for key: ${passwordKey} in ${envFilePath}`);
    }
    
    if (!rawSharedSecret) {
      throw new Error(`Shared secret not found for key: ${sharedSecretKey} in ${envFilePath}`);
    }
    
    // Clean password (remove comments) but shared secret is already clean from dotenv
    const cleanPassword = this.cleanPassword(rawPassword);

    // Validate shared secret is not empty (dotenv already handled quotes)
    if (!rawSharedSecret.trim()) {
      throw new Error('Shared secret value is empty');
    }

    // Load identity secret (optional - needed for trade offer confirmation)
    const identitySecretKey = `STEAM_IDENTITYSECRET_${steamLogin.toUpperCase()}`;
    const rawIdentitySecret = process.env[identitySecretKey];

    return {
      username: steamLogin,
      password: cleanPassword,
      sharedSecret: rawSharedSecret.trim(),
      identitySecret: rawIdentitySecret ? rawIdentitySecret.trim() : null
    };
  }
}

module.exports = CredentialCleaner;