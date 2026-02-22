// automate_trading/shared/steam_api_client.js
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { SocksProxyAgent } = require('socks-proxy-agent');
const config = require('../config/config');

class SteamApiClient {
  constructor() {
    this.baseUrl = config.steam.baseUrl;
    this.proxyConfig = null;
    this.loadProxyConfig();
  }

  loadProxyConfig() {
    try {
      // Look for config_proxies.json in project root (two levels up from automate_trading/shared/)
      const configPath = path.join(__dirname, '../../config_proxies.json');
      
      if (fs.existsSync(configPath)) {
        this.proxyConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } else {
        this.proxyConfig = null;
      }
    } catch (error) {
      console.warn(`Error loading proxy configuration: ${error.message}`);
      this.proxyConfig = null;
    }
  }

  getConnectionsWithKeys() {
    const connections = [];
    
    if (this.proxyConfig && this.proxyConfig.connections) {
      // Use connections from proxy config
      for (const conn of this.proxyConfig.connections) {
        const apiKey = conn.api_key || config.steam.apiKey;
        if (apiKey) {
          connections.push({
            connection: conn,
            apiKey: apiKey
          });
        }
      }
    }
    
    // Fallback: if no connections found or no proxy config, use direct connection with global key
    if (connections.length === 0 && config.steam.apiKey) {
      connections.push({
        connection: { type: 'direct', url: null },
        apiKey: config.steam.apiKey
      });
    }
    
    return connections;
  }

  createAxiosInstance(connection) {
    const axiosConfig = {
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36'
      }
    };

    // Configure proxy if needed
    if (connection.type === 'socks5' && connection.url) {
      try {
        const socksAgent = new SocksProxyAgent(connection.url);
        axiosConfig.httpsAgent = socksAgent;
        axiosConfig.httpAgent = socksAgent;
      } catch (error) {
        console.error(`Error creating SOCKS5 proxy configuration: ${error.message}`);
        throw error;
      }
    }

    return axios.create(axiosConfig);
  }

  async makeRequestWithRotation(endpoint, params) {
    const connections = this.getConnectionsWithKeys();
    
    if (connections.length === 0) {
      throw new Error('No Steam API keys or connections available');
    }

    let lastError = null;

    for (let i = 0; i < connections.length; i++) {
      const { connection, apiKey } = connections[i];
      
      try {
        // Create axios instance for this connection
        const client = this.createAxiosInstance(connection);
        
        // Add API key to params
        const requestParams = {
          ...params,
          key: apiKey
        };
        
        // Make the request
        const response = await client.get(endpoint, { params: requestParams });
        
        if (response.status === 200) {
          return response;
        }
        
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        const connectionDesc = `${connection.type} ${connection.url ? '[proxy]' : '[direct]'}`;
        
        if (status === 429) {
          console.warn(`Rate limited (429) on connection ${i + 1}/${connections.length}: ${connectionDesc}`);
        } else if (status) {
          console.warn(`HTTP ${status} error on connection ${i + 1}/${connections.length}: ${connectionDesc} - ${error.message}`);
        } else {
          console.warn(`Network error on connection ${i + 1}/${connections.length}: ${connectionDesc} - ${error.message}`);
        }
        
        // Continue to next connection
        continue;
      }
    }

    // All connections failed
    console.error(`All ${connections.length} connection(s) failed. Last error: ${lastError?.message}`);
    throw lastError || new Error('All connections failed');
  }

  async getPlayerSummaries(steamIds) {
    try {
      // Steam API accepts up to 100 steam IDs
      const steamIdsString = steamIds.join(',');
      
      const response = await this.makeRequestWithRotation('/ISteamUser/GetPlayerSummaries/v0002/', {
        steamids: steamIdsString
      });

      if (response.data && response.data.response && response.data.response.players) {
        return response.data.response.players;
      } else {
        throw new Error('Invalid response format from Steam API');
      }
    } catch (error) {
      console.error(`Failed to get player summaries: ${error.message}`);
      throw new Error(`Failed to get player summaries: ${error.message}`);
    }
  }

  enrichBatchWithPlayerData(batch) {
    const steamIds = batch.map(item => item.slug);
    
    return this.getPlayerSummaries(steamIds).then(players => {
      // Create a map for quick lookup
      const playerMap = {};
      players.forEach(player => {
        playerMap[player.steamid] = player;
      });

      // Enrich batch items with player data
      return batch.map(item => {
        const playerData = playerMap[item.slug] || {};
        
        return {
          ...item,
          communityvisibilitystate: playerData.communityvisibilitystate || 1,
          personastate: playerData.personastate || 0,
          personastateflags: playerData.personastateflags || 0,
          timecreated: playerData.timecreated || null
        };
      });
    });
  }
}

module.exports = SteamApiClient;