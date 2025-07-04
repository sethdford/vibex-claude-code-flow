/**
 * Enterprise Configuration Management for Claude-Flow
 * Features: Security masking, change tracking, multi-format support, credential management
 */

import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes, createCipheriv, createDecipheriv, scrypt } from "crypto";
import { Config } from "../utils/types.js";
import { deepMerge, safeParseJSON } from "../utils/helpers.js";
import { ConfigError, ValidationError } from "../utils/errors.js";
import { promisify } from "util";
import { existsSync } from "fs";

const scryptAsync = promisify(scrypt);

// Format parsers
interface FormatParser {
  parse(content: string): Partial<Config>;
  stringify(obj: Partial<Config>): string;
  extension: string;
}

// Configuration change record
interface ConfigChange {
  timestamp: string;
  path: string;
  oldValue: unknown;
  newValue: unknown;
  user?: string;
  reason?: string;
  source: "cli" | "api" | "file" | "env";
}

// Security classification
interface SecurityClassification {
  level: "public" | "internal" | "confidential" | "secret";
  maskPattern?: string;
  encrypted?: boolean;
}

// Validation rule
interface ValidationRule {
  type: string;
  required?: boolean;
  min?: number;
  max?: number;
  values?: string[];
  pattern?: RegExp;
  validator?: (value: unknown, config: Config) => string | null;
  dependencies?: string[];
}

// Add this interface near the top after other interfaces
interface ConfigExport {
  version: string;
  exported: string;
  profile?: string;
  config: Config;
  diff?: any;
}

/**
 * Security classifications for configuration paths
 */
const SECURITY_CLASSIFICATIONS: Record<string, SecurityClassification> = {
  "credentials": { level: "secret", encrypted: true },
  "credentials.apiKey": { level: "secret", maskPattern: "****...****", encrypted: true },
  "credentials.token": { level: "secret", maskPattern: "****...****", encrypted: true },
  "credentials.password": { level: "secret", maskPattern: "********", encrypted: true },
  "mcp.apiKey": { level: "confidential", maskPattern: "****...****" },
  "logging.destination": { level: "internal" },
  "orchestrator": { level: "internal" },
  "terminal": { level: "public" },
};

/**
 * Sensitive configuration paths that should be masked in output
 */
const SENSITIVE_PATHS = [
  "credentials",
  "apiKey",
  "token",
  "password",
  "secret",
  "key",
  "auth",
];

/**
 * Format parsers for different configuration file types
 */
const FORMAT_PARSERS: Record<string, FormatParser> = {
  json: {
    parse: JSON.parse,
    stringify: (obj) => JSON.stringify(obj, null, 2),
    extension: ".json",
  },
  yaml: {
    parse: (content) => {
      // Simple YAML parser for basic key-value pairs
      const lines = content.split("\n");
      const result: any = {};
      const current = result;
      const stack: any[] = [result];
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        
        const indent = line.length - line.trimStart().length;
        const colonIndex = trimmed.indexOf(":");
        
        if (colonIndex === -1) continue;
        
        const key = trimmed.substring(0, colonIndex).trim();
        const value = trimmed.substring(colonIndex + 1).trim();
        
        // Simple value parsing
        let parsedValue: string | number | boolean = value;
        if (value === "true") parsedValue = true;
        else if (value === "false") parsedValue = false;
        else if (!isNaN(Number(value)) && value !== "") parsedValue = Number(value);
        else if (value.startsWith("\"") && value.endsWith("\"")) {
          parsedValue = value.slice(1, -1);
        }
        
        current[key] = parsedValue;
      }
      
      return result;
    },
    stringify: (obj) => {
      const stringify = (obj: any, indent = 0): string => {
        const spaces = "  ".repeat(indent);
        let result = "";
        
        for (const [key, value] of Object.entries(obj)) {
          if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            result += `${spaces}${key}:\n${stringify(value, indent + 1)}`;
          } else {
            const formattedValue = typeof value === "string" ? `"${value}"` : String(value);
            result += `${spaces}${key}: ${formattedValue}\n`;
          }
        }
        
        return result;
      };
      
      return stringify(obj);
    },
    extension: ".yaml",
  },
  toml: {
    parse: (content) => {
      // Simple TOML parser for basic sections and key-value pairs
      const lines = content.split("\n");
      const result: any = {};
      let currentSection = result;
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        
        // Section header
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          const sectionName = trimmed.slice(1, -1);
          currentSection = result[sectionName] = {};
          continue;
        }
        
        // Key-value pair
        const equalsIndex = trimmed.indexOf("=");
        if (equalsIndex === -1) continue;
        
        const key = trimmed.substring(0, equalsIndex).trim();
        const value = trimmed.substring(equalsIndex + 1).trim();
        
        // Simple value parsing
        let parsedValue: string | number | boolean = value;
        if (value === "true") parsedValue = true;
        else if (value === "false") parsedValue = false;
        else if (!isNaN(Number(value)) && value !== "") parsedValue = Number(value);
        else if (value.startsWith("\"") && value.endsWith("\"")) {
          parsedValue = value.slice(1, -1);
        }
        
        currentSection[key] = parsedValue;
      }
      
      return result;
    },
    stringify: (obj) => {
      let result = "";
      
      for (const [section, values] of Object.entries(obj)) {
        if (typeof values === "object" && values !== null && !Array.isArray(values)) {
          result += `[${section}]\n`;
          for (const [key, value] of Object.entries(values)) {
            const formattedValue = typeof value === "string" ? `"${value}"` : String(value);
            result += `${key} = ${formattedValue}\n`;
          }
          result += "\n";
        }
      }
      
      return result;
    },
    extension: ".toml",
  },
};

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Config = {
  orchestrator: {
    maxConcurrentAgents: 10,
    taskQueueSize: 100,
    healthCheckInterval: 30000, // 30 seconds
    shutdownTimeout: 30000, // 30 seconds
  },
  terminal: {
    type: "auto",
    poolSize: 5,
    recycleAfter: 10, // recycle after 10 uses
    healthCheckInterval: 60000, // 1 minute
    commandTimeout: 300000, // 5 minutes
  },
  memory: {
    backend: "hybrid",
    cacheSizeMB: 100,
    syncInterval: 5000, // 5 seconds
    conflictResolution: "crdt",
    retentionDays: 30,
  },
  coordination: {
    maxRetries: 3,
    retryDelay: 1000, // 1 second
    deadlockDetection: true,
    resourceTimeout: 60000, // 1 minute
    messageTimeout: 30000, // 30 seconds
  },
  mcp: {
    transport: "stdio",
    port: 3000,
    tlsEnabled: false,
  },
  logging: {
    level: "info",
    format: "json",
    destination: "console",
  },
  credentials: {
    // Encrypted credentials storage
  },
  security: {
    encryptionEnabled: true,
    auditLogging: true,
    maskSensitiveValues: true,
    allowEnvironmentOverrides: true,
  },
};

/**
 * Configuration manager
 */
export class ConfigManager {
  private static instance: ConfigManager;
  private config: Config;
  private configPath?: string;
  private profiles: Map<string, Partial<Config>> = new Map();
  private currentProfile?: string;
  private userConfigDir: string;
  private changeHistory: ConfigChange[] = [];
  private encryptionKey?: Buffer;
  private validationRules: Map<string, ValidationRule> = new Map();
  private formatParsers = FORMAT_PARSERS;

  private constructor() {
    this.config = deepClone(DEFAULT_CONFIG);
    this.userConfigDir = this.getUserConfigDir();
    this.initializeEncryption();
    this.setupValidationRules();
  }

  /**
   * Gets the singleton instance
   */
  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * Initializes encryption key for sensitive configuration values
   */
  private initializeEncryption(): void {
    try {
      const keyFile = join(this.userConfigDir, ".encryption-key");
      // Check if key file exists using ES module import
      if (existsSync(keyFile)) {
        // In a real implementation, this would be more secure
        this.encryptionKey = randomBytes(32);
      } else {
        this.encryptionKey = randomBytes(32);
        // Store key securely (in production, use proper key management)
      }
    } catch (error) {
      console.warn("Failed to initialize encryption:", (error as Error).message);
    }
  }

  /**
   * Sets up validation rules for configuration paths
   */
  private setupValidationRules(): void {
    // Orchestrator validation rules
    this.validationRules.set("orchestrator.maxConcurrentAgents", {
      type: "number",
      required: true,
      min: 1,
      max: 100,
      validator: (value, config) => {
        const numValue = value as number;
        if (numValue > (config.terminal?.poolSize ?? 1) * 2) {
          return "maxConcurrentAgents should not exceed 2x terminal pool size";
        }
        return null;
      },
    });

    this.validationRules.set("orchestrator.taskQueueSize", {
      type: "number",
      required: true,
      min: 1,
      max: 10000,
      dependencies: ["orchestrator.maxConcurrentAgents"],
      validator: (value, config) => {
        const numValue = value as number;
        const maxAgents = config.orchestrator?.maxConcurrentAgents ?? 1;
        if (numValue < maxAgents * 10) {
          return "taskQueueSize should be at least 10x maxConcurrentAgents";
        }
        return null;
      },
    });

    // Terminal validation rules
    this.validationRules.set("terminal.type", {
      type: "string",
      required: true,
      values: ["auto", "vscode", "native"],
    });

    this.validationRules.set("terminal.poolSize", {
      type: "number",
      required: true,
      min: 1,
      max: 50,
    });

    // Memory validation rules
    this.validationRules.set("memory.backend", {
      type: "string",
      required: true,
      values: ["sqlite", "markdown", "hybrid"],
    });

    this.validationRules.set("memory.cacheSizeMB", {
      type: "number",
      required: true,
      min: 1,
      max: 10000,
      validator: (value) => {
        const numValue = value as number;
        if (numValue > 1000) {
          return "Large cache sizes may impact system performance";
        }
        return null;
      },
    });

    // Security validation rules
    this.validationRules.set("security.encryptionEnabled", {
      type: "boolean",
      required: true,
    });

    // Credentials validation
    this.validationRules.set("credentials.apiKey", {
      type: "string",
      pattern: /^[a-zA-Z0-9_-]+$/,
      validator: (value) => {
        const strValue = value as string;
        if (strValue && strValue.length < 16) {
          return "API key should be at least 16 characters long";
        }
        return null;
      },
    });
  }

  /**
   * Loads configuration from file and environment
   */
  async load(configPath?: string): Promise<void> {
    try {
      let config: Partial<Config> = {};

      // Load from file if provided
      if (configPath) {
        const fileConfig = await this.loadFromFile(configPath);
        config = this.mergeConfigs(config, fileConfig);
      }

      // Load from environment variables
      const envConfig = await this.loadFromEnv();
      config = this.mergeConfigs(config, envConfig);

      // Merge with default configuration
      this.config = deepMergeConfig(DEFAULT_CONFIG, config);

      // Validate the final configuration
      this.validate(this.config);
    } catch (error) {
      throw new ConfigError(`Failed to load configuration: ${(error as Error).message}`);
    }
  }

  /**
   * Helper method to safely merge partial configs
   */
  private mergeConfigs(target: Partial<Config>, source: Partial<Config>): Partial<Config> {
    return deepMerge(target, source);
  }

  /**
   * Gets the current configuration with optional security masking
   */
  get(maskSensitive = false): Config {
    const config = deepClone(this.config);
    
    if (maskSensitive && this.config.security?.maskSensitiveValues) {
      return this.maskSensitiveValues(config) as Config;
    }
    
    return config;
  }

  /**
   * Gets configuration with security masking applied
   */
  getSecure(): Config {
    return this.get(true);
  }

  /**
   * Updates configuration values with change tracking
   */
  update(updates: Partial<Config>, options: { user?: string, reason?: string, source?: "cli" | "api" | "file" | "env" } = {}): Config {
    const oldConfig = deepClone(this.config);
    
    // Track changes before applying
    this.trackConfigChanges(oldConfig, updates, options);
    
    // Apply updates
    this.config = deepMergeConfig(this.config, updates);
    
    // Validate the updated configuration
    this.validateWithDependencies(this.config);
    
    return this.get();
  }

  /**
   * Loads default configuration
   */
  loadDefault(): void {
    this.config = deepClone(DEFAULT_CONFIG);
  }

  /**
   * Saves configuration to file with format support
   */
  async save(path?: string, format?: string): Promise<void> {
    const savePath = path ?? this.configPath;
    if (!savePath) {
      throw new ConfigError("No configuration file path specified");
    }

    const detectedFormat = format ?? this.detectFormat(savePath);
    const parser = this.formatParsers[detectedFormat];
    
    if (!parser) {
      throw new ConfigError(`Unsupported format for saving: ${detectedFormat}`);
    }
    
    // Get configuration without sensitive values for saving
    const configToSave = this.getConfigForSaving();
    const content = parser.stringify(configToSave);
    
    await fs.writeFile(savePath, content, "utf8");
    
    // Record the save operation
    this.recordChange("CONFIG_SAVED", null, savePath, { source: "file" });
  }
  
  /**
   * Gets configuration suitable for saving (excludes runtime-only values)
   */
  private getConfigForSaving(): Partial<Config> {
    const config = deepClone(this.config);
    
    // Remove encrypted credentials from the saved config
    // They should be stored separately in a secure location
    if (config.credentials) {
      delete config.credentials;
    }
    
    return config;
  }

  /**
   * Gets user configuration directory
   */
  private getUserConfigDir(): string {
    const home = homedir();
    return join(home, ".claude-flow");
  }

  /**
   * Creates user config directory if it doesn't exist
   */
  private async ensureUserConfigDir(): Promise<void> {
    try {
      await fs.mkdir(this.userConfigDir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ConfigError(`Failed to create config directory: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Loads all profiles from the profiles directory
   */
  async loadProfiles(): Promise<void> {
    const profilesDir = join(this.userConfigDir, "profiles");
    
    try {
      const entries = await fs.readdir(profilesDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          const profileName = entry.name.replace(".json", "");
          const profilePath = join(profilesDir, entry.name);
          
          try {
            const content = await fs.readFile(profilePath, "utf8");
            const profileConfig = safeParseJSON<Partial<Config>>(content);
            
            if (profileConfig) {
              this.profiles.set(profileName, profileConfig);
            }
          } catch (error) {
            console.warn(`Failed to load profile ${profileName}: ${(error as Error).message}`);
          }
        }
      }
    } catch (error) {
      // Profiles directory doesn't exist - this is okay
    }
  }

  /**
   * Applies a named profile
   */
  async applyProfile(profileName: string): Promise<void> {
    await this.loadProfiles();
    
    const profile = this.profiles.get(profileName);
    if (!profile) {
      throw new ConfigError(`Profile "${profileName}" not found`);
    }

    this.config = deepMergeConfig(this.config, profile);
    this.currentProfile = profileName;
    this.validate(this.config);
  }

  /**
   * Saves current configuration as a profile
   */
  async saveProfile(profileName: string, config?: Partial<Config>): Promise<void> {
    await this.ensureUserConfigDir();
    
    const profilesDir = join(this.userConfigDir, "profiles");
    await fs.mkdir(profilesDir, { recursive: true });
    
    const profileConfig = config ?? this.config;
    const profilePath = join(profilesDir, `${profileName}.json`);
    
    const content = JSON.stringify(profileConfig, null, 2);
    await fs.writeFile(profilePath, content, "utf8");
    
    this.profiles.set(profileName, profileConfig);
  }

  /**
   * Deletes a profile
   */
  async deleteProfile(profileName: string): Promise<void> {
    const profilePath = join(this.userConfigDir, "profiles", `${profileName}.json`);
    
    try {
      await fs.unlink(profilePath);
      this.profiles.delete(profileName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ConfigError(`Profile "${profileName}" not found`);
      }
      throw new ConfigError(`Failed to delete profile: ${(error as Error).message}`);
    }
  }

  /**
   * Lists all available profiles
   */
  async listProfiles(): Promise<string[]> {
    await this.loadProfiles();
    return Array.from(this.profiles.keys());
  }

  /**
   * Gets a specific profile configuration
   */
  async getProfile(profileName: string): Promise<Partial<Config> | undefined> {
    await this.loadProfiles();
    return this.profiles.get(profileName);
  }

  /**
   * Gets the current active profile name
   */
  getCurrentProfile(): string | undefined {
    return this.currentProfile;
  }

  /**
   * Sets a configuration value by path with change tracking and validation
   */
  set(path: string, value: unknown, options: { user?: string, reason?: string, source?: "cli" | "api" | "file" | "env" } = {}): void {
    const oldValue = this.getValue(path);
    
    // Record the change
    this.recordChange(path, oldValue, value, {
      user: options.user,
      reason: options.reason,
      source: options.source ?? "cli",
    });
    
    // Encrypt sensitive values
    if (this.isSensitivePath(path) && this.config.security?.encryptionEnabled) {
      value = this.encryptValue(value as string);
    }
    
    const keys = path.split(".");
    let current: any = this.config;
    
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current)) {
        current[key] = {};
      }
      current = current[key];
    }
    
    current[keys[keys.length - 1]] = value;
    
    // Validate the path-specific rule and dependencies
    this.validatePath(path, value, this.config);
    this.validateWithDependencies(this.config);
  }

  /**
   * Gets a configuration value by path with decryption for sensitive values
   */
  getValue(path: string, decrypt = true): unknown {
    const keys = path.split(".");
    let current: unknown = this.config;
    
    for (const key of keys) {
      if (current && typeof current === "object" && key in current) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }
    
    // Decrypt sensitive values if requested
    if (decrypt && this.isSensitivePath(path) && this.isEncryptedValue(current)) {
      try {
        return this.decryptValue(current as string);
      } catch (error) {
        console.warn(`Failed to decrypt value at path ${path}:`, (error as Error).message);
        return current;
      }
    }
    
    return current;
  }

  /**
   * Resets configuration to defaults
   */
  reset(): void {
    this.config = deepClone(DEFAULT_CONFIG);
    delete this.currentProfile;
  }

  /**
   * Gets configuration schema for validation
   */
  getSchema(): any {
    return {
      orchestrator: {
        maxConcurrentAgents: { type: "number", min: 1, max: 100 },
        taskQueueSize: { type: "number", min: 1, max: 10000 },
        healthCheckInterval: { type: "number", min: 1000, max: 300000 },
        shutdownTimeout: { type: "number", min: 1000, max: 300000 },
      },
      terminal: {
        type: { type: "string", values: ["auto", "vscode", "native"] },
        poolSize: { type: "number", min: 1, max: 50 },
        recycleAfter: { type: "number", min: 1, max: 1000 },
        healthCheckInterval: { type: "number", min: 1000, max: 3600000 },
        commandTimeout: { type: "number", min: 1000, max: 3600000 },
      },
      memory: {
        backend: { type: "string", values: ["sqlite", "markdown", "hybrid"] },
        cacheSizeMB: { type: "number", min: 1, max: 10000 },
        syncInterval: { type: "number", min: 1000, max: 300000 },
        conflictResolution: { type: "string", values: ["crdt", "timestamp", "manual"] },
        retentionDays: { type: "number", min: 1, max: 3650 },
      },
      coordination: {
        maxRetries: { type: "number", min: 0, max: 100 },
        retryDelay: { type: "number", min: 100, max: 60000 },
        deadlockDetection: { type: "boolean" },
        resourceTimeout: { type: "number", min: 1000, max: 3600000 },
        messageTimeout: { type: "number", min: 1000, max: 300000 },
      },
      mcp: {
        transport: { type: "string", values: ["stdio", "http", "websocket"] },
        port: { type: "number", min: 1, max: 65535 },
        tlsEnabled: { type: "boolean" },
      },
      logging: {
        level: { type: "string", values: ["debug", "info", "warn", "error"] },
        format: { type: "string", values: ["json", "text"] },
        destination: { type: "string", values: ["console", "file"] },
      },
    };
  }

  /**
   * Validates a value against schema
   */
  private validateValue(value: unknown, schema: ValidationRule, path: string): void {
    if (schema.type === "number") {
      if (typeof value !== "number" || isNaN(value)) {
        throw new ValidationError(`${path}: must be a number`);
      }
      if (schema.min !== undefined && value < schema.min) {
        throw new ValidationError(`${path}: must be at least ${schema.min}`);
      }
      if (schema.max !== undefined && value > schema.max) {
        throw new ValidationError(`${path}: must be at most ${schema.max}`);
      }
    } else if (schema.type === "string") {
      if (typeof value !== "string") {
        throw new ValidationError(`${path}: must be a string`);
      }
      if (schema.values && !schema.values.includes(value)) {
        throw new ValidationError(`${path}: must be one of [${schema.values.join(", ")}]`);
      }
    } else if (schema.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new ValidationError(`${path}: must be a boolean`);
      }
    }
  }

  /**
   * Gets configuration diff between current and default
   */
  getDiff(): any {
    const defaultConfig = DEFAULT_CONFIG;
    const diff: any = {};
    
    const findDifferences = (current: any, defaults: any, path: string = "") => {
      for (const key in current) {
        const currentValue = current[key];
        const defaultValue = defaults[key];
        const fullPath = path ? `${path}.${key}` : key;
        
        if (typeof currentValue === "object" && currentValue !== null && !Array.isArray(currentValue)) {
          if (typeof defaultValue === "object" && defaultValue !== null) {
            const nestedDiff = {};
            findDifferences(currentValue, defaultValue, fullPath);
            if (Object.keys(nestedDiff).length > 0) {
              if (!path) {
                diff[key] = nestedDiff;
              }
            }
          }
        } else if (currentValue !== defaultValue) {
          const pathParts = fullPath.split(".");
          let target = diff;
          for (let i = 0; i < pathParts.length - 1; i++) {
            if (!target[pathParts[i]]) {
              target[pathParts[i]] = {};
            }
            target = target[pathParts[i]];
          }
          target[pathParts[pathParts.length - 1]] = currentValue;
        }
      }
    };
    
    findDifferences(this.config as any, defaultConfig as any);
    return diff;
  }

  /**
   * Exports configuration with metadata
   */
  export(): ConfigExport {
    return {
      version: "1.0.0",
      exported: new Date().toISOString(),
      profile: this.currentProfile,
      config: this.config,
      diff: this.getDiff(),
    };
  }

  /**
   * Imports configuration from export
   */
  import(data: ConfigExport): void {
    if (!data.config) {
      throw new ConfigError("Invalid configuration export format");
    }
    
    this.validateWithDependencies(data.config);
    this.config = data.config;
    this.currentProfile = data.profile;
    
    // Record the import operation
    this.recordChange("CONFIG_IMPORTED", null, data.version || "unknown", { source: "file" });
  }

  /**
   * Loads configuration from file with format detection
   */
  private async loadFromFile(path: string): Promise<Partial<Config>> {
    try {
      const content = await fs.readFile(path, "utf8");
      const format = this.detectFormat(path, content);
      const parser = this.formatParsers[format];
      
      if (!parser) {
        throw new ConfigError(`Unsupported configuration format: ${format}`);
      }
      
      const config = parser.parse(content);
      
      if (!config) {
        throw new ConfigError(`Invalid ${format.toUpperCase()} in configuration file: ${path}`);
      }

      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist, use defaults
        return {};
      }
      throw new ConfigError(`Failed to load configuration from ${path}: ${(error as Error).message}`);
    }
  }
  
  /**
   * Detects configuration file format
   */
  private detectFormat(path: string, content?: string): string {
    const ext = path.split(".").pop()?.toLowerCase();
    
    if (ext === "yaml" || ext === "yml") return "yaml";
    if (ext === "toml") return "toml";
    if (ext === "json") return "json";
    
    // Try to detect from content
    if (content) {
      const trimmed = content.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
      if (trimmed.includes("=") && trimmed.includes("[")) return "toml";
      if (trimmed.includes(":") && !trimmed.includes("=")) return "yaml";
    }
    
    // Default to JSON
    return "json";
  }

  /**
   * Loads configuration from environment variables
   */
  private async loadFromEnv(): Promise<Partial<Config>> {
    const config: Partial<Config> = {};

    // Orchestrator settings
    const maxAgents = process.env.CLAUDE_FLOW_MAX_AGENTS;
    if (maxAgents) {
      if (!config.orchestrator) {
        config.orchestrator = {
          maxConcurrentAgents: parseInt(maxAgents, 10),
          taskQueueSize: DEFAULT_CONFIG.orchestrator.taskQueueSize,
          healthCheckInterval: DEFAULT_CONFIG.orchestrator.healthCheckInterval,
          shutdownTimeout: DEFAULT_CONFIG.orchestrator.shutdownTimeout,
        };
      }
    }

    // Terminal settings
    const terminalType = process.env.CLAUDE_FLOW_TERMINAL_TYPE;
    if (terminalType === "vscode" || terminalType === "native" || terminalType === "auto") {
      config.terminal = {
        ...DEFAULT_CONFIG.terminal,
        ...config.terminal,
        type: terminalType,
      };
    }

    // Memory settings
    const memoryBackend = process.env.CLAUDE_FLOW_MEMORY_BACKEND;
    if (memoryBackend === "sqlite" || memoryBackend === "markdown" || memoryBackend === "hybrid") {
      config.memory = {
        ...DEFAULT_CONFIG.memory,
        ...config.memory,
        backend: memoryBackend,
      };
    }

    // MCP settings
    const mcpTransport = process.env.CLAUDE_FLOW_MCP_TRANSPORT;
    if (mcpTransport === "stdio" || mcpTransport === "http" || mcpTransport === "websocket") {
      config.mcp = {
        ...DEFAULT_CONFIG.mcp,
        ...config.mcp,
        transport: mcpTransport,
      };
    }

    const mcpPort = process.env.CLAUDE_FLOW_MCP_PORT;
    if (mcpPort) {
      config.mcp = {
        ...DEFAULT_CONFIG.mcp,
        ...config.mcp,
        port: parseInt(mcpPort, 10),
      };
    }

    // Logging settings
    const logLevel = process.env.CLAUDE_FLOW_LOG_LEVEL;
    if (logLevel === "debug" || logLevel === "info" || logLevel === "warn" || logLevel === "error") {
      config.logging = {
        ...DEFAULT_CONFIG.logging,
        ...config.logging,
        level: logLevel,
      };
    }

    // AWS Bedrock settings for Claude Code integration
    // Auto-detect AWS credentials and enable Bedrock if available
    await this.detectAndConfigureAWS();

    // These environment variables are passed through to spawned Claude processes
    if (process.env.CLAUDE_CODE_USE_BEDROCK) {
      console.log("AWS Bedrock integration enabled for Claude Code", {
        region: process.env.AWS_REGION,
        model: process.env.ANTHROPIC_MODEL,
        smallFastModel: process.env.ANTHROPIC_SMALL_FAST_MODEL,
      });
    }

    return config;
  }

  /**
   * Auto-detect AWS credentials and configure Bedrock integration
   */
  private async detectAndConfigureAWS(): Promise<void> {
    // Skip if Bedrock is explicitly disabled
    if (process.env.CLAUDE_CODE_USE_BEDROCK === "false") {
      return;
    }

    // Skip if already explicitly configured
    if (process.env.CLAUDE_CODE_USE_BEDROCK === "true") {
      return;
    }

    try {
      // Check for AWS credentials in various sources
      const hasCredentials = await this.checkAWSCredentials();
      
      if (hasCredentials) {
        console.log("🔍 AWS credentials detected - enabling Bedrock integration");
        
        // Auto-configure Bedrock settings
        process.env.CLAUDE_CODE_USE_BEDROCK = "true";
        
        // Set default region if not specified
        if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
          process.env.AWS_REGION = "us-east-1";
        }
        
        // Set default Claude 4 models if not specified
        if (!process.env.ANTHROPIC_MODEL) {
          process.env.ANTHROPIC_MODEL = "anthropic.claude-opus-4-20250514-v1:0";
        }
        
        if (!process.env.ANTHROPIC_SMALL_FAST_MODEL) {
          process.env.ANTHROPIC_SMALL_FAST_MODEL = "anthropic.claude-sonnet-4-20250514-v1:0";
        }
        
        console.log("✅ Auto-configured AWS Bedrock with Claude 4 models");
      }
    } catch (error) {
      // Silently fail - don't break the application if AWS detection fails
      console.debug("AWS credential detection failed:", error);
    }
  }

  /**
   * Check if AWS credentials are available from various sources
   */
  private async checkAWSCredentials(): Promise<boolean> {
    // Check environment variables
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      return true;
    }

    // Check AWS profile
    if (process.env.AWS_PROFILE) {
      return true;
    }

    // Check for AWS config/credentials files
    try {
      const os = await import("node:os");
      const path = await import("node:path");
      const fs = await import("node:fs");
      
      const homeDir = os.homedir();
      const awsConfigPath = path.join(homeDir, ".aws", "config");
      const awsCredentialsPath = path.join(homeDir, ".aws", "credentials");
      
      if (fs.existsSync(awsConfigPath) || fs.existsSync(awsCredentialsPath)) {
        return true;
      }
    } catch {
      // Ignore file system errors
    }

    // Check for IAM role (EC2 instance profile or ECS task role)
    try {
      const response = await fetch("http://169.254.169.254/latest/meta-data/iam/security-credentials/", {
        method: "GET",
        signal: AbortSignal.timeout(2000), // 2 second timeout
      });
      
      if (response.ok) {
        return true;
      }
    } catch {
      // Ignore metadata service errors (not running on AWS or no role)
    }

    // Check if AWS CLI is configured and working
    try {
      const { spawn } = await import("node:child_process");
      
      return new Promise<boolean>((resolve) => {
        const child = spawn("aws", ["sts", "get-caller-identity", "--no-cli-pager"], {
          stdio: "ignore",
        });
        
        child.on("exit", (code) => {
          resolve(code === 0);
        });
        
        child.on("error", () => {
          resolve(false);
        });
        
        // Timeout after 3 seconds
        setTimeout(() => {
          child.kill();
          resolve(false);
        }, 3000);
      });
    } catch {
      return false;
    }
  }

  /**
   * Validates configuration with dependency checking
   */
  private validateWithDependencies(config: Config): void {
    this.validate(config);
    
    // Check dependencies between configuration sections
    for (const [path, rule] of Array.from(this.validationRules.entries())) {
      if (rule.dependencies) {
        const value = this.getValueByPath(config as unknown as Record<string, unknown>, path);
        for (const depPath of rule.dependencies) {
          const depValue = this.getValueByPath(config as unknown as Record<string, unknown>, depPath);
          if (value && !depValue) {
            throw new ConfigError(`Configuration dependency not met: ${path} requires ${depPath}`);
          }
        }
      }
    }
  }
  
  /**
   * Validates a specific configuration path
   */
  private validatePath(path: string, value: unknown, config?: Config): void {
    const rule = this.validationRules.get(path);
    if (!rule) return;

    // Type validation
    if (rule.type && typeof value !== rule.type) {
      throw new ConfigError(`Invalid type for ${path}: expected ${rule.type}, got ${typeof value}`);
    }

    // Required validation
    if (rule.required && (value === undefined || value === null)) {
      throw new ConfigError(`Required configuration missing: ${path}`);
    }

    // Range validation
    if (typeof value === "number") {
      if (rule.min !== undefined && value < rule.min) {
        throw new ConfigError(`Value for ${path} below minimum: ${value} < ${rule.min}`);
      }
      if (rule.max !== undefined && value > rule.max) {
        throw new ConfigError(`Value for ${path} above maximum: ${value} > ${rule.max}`);
      }
    }

    // Enum validation
    if (rule.values && !rule.values.includes(String(value))) {
      throw new ConfigError(`Invalid value for ${path}: ${value}. Valid values: ${rule.values.join(", ")}`);
    }

    // Pattern validation
    if (rule.pattern && typeof value === "string" && !rule.pattern.test(value)) {
      throw new ConfigError(`Invalid format for ${path}: ${value}`);
    }

    // Custom validation
    if (rule.validator && config) {
      const error = rule.validator(value, config);
      if (error) {
        throw new ConfigError(`Validation failed for ${path}: ${error}`);
      }
    }
  }
  
  /**
   * Gets a value from a configuration object by path
   */
  private getValueByPath(obj: Record<string, unknown>, path: string): unknown {
    const keys = path.split(".");
    let current: unknown = obj;
    
    for (const key of keys) {
      if (current && typeof current === "object" && key in current) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }
    
    return current;
  }
  
  /**
   * Legacy validate method for backward compatibility
   */
  private validate(config: Config): void {
    this.validateWithDependencies(config);
  }

  /**
   * Gets available configuration templates
   */
  getAvailableTemplates(): string[] {
    return ["minimal", "default", "development", "production"];
  }

  /**
   * Creates a configuration from a template
   */
  createTemplate(templateName: string): Config {
    const templates: Record<string, Partial<Config>> = {
      minimal: {
        orchestrator: {
          maxConcurrentAgents: 5,
          taskQueueSize: 50,
          healthCheckInterval: 60000,
          shutdownTimeout: 10000,
        },
        terminal: {
          type: "auto",
          poolSize: 2,
          recycleAfter: 5,
          healthCheckInterval: 120000,
          commandTimeout: 300000,
        },
      },
      development: {
        logging: {
          level: "debug",
          format: "text",
          destination: "console",
        },
        orchestrator: {
          maxConcurrentAgents: 20,
          taskQueueSize: 200,
          healthCheckInterval: 15000,
          shutdownTimeout: 5000,
        },
      },
      production: {
        logging: {
          level: "warn",
          format: "json",
          destination: "file",
        },
        memory: {
          backend: "markdown",
          cacheSizeMB: 500,
          syncInterval: 10000,
          conflictResolution: "last-write",
          retentionDays: 90,
        },
      },
    };

    const template = templates[templateName];
    if (!template) {
      throw new ConfigError(`Unknown template: ${templateName}`);
    }
    
    return deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, template as Record<string, unknown>) as unknown as Config;
  }

  /**
   * Gets format parsers for different config file formats
   */
  getFormatParsers(): Record<string, { stringify: (obj: Partial<Config>) => string; parse: (str: string) => Partial<Config> }> {
    return FORMAT_PARSERS;
  }

  /**
   * Validates a configuration file
   */
  async validateFile(configPath: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    
    try {
      const content = await fs.readFile(configPath, "utf8");
      const config = JSON.parse(content);
      
      // Run validation
      try {
        this.validate(config);
      } catch (error) {
        errors.push((error as Error).message);
      }
      
      // Additional validations
      if (!config.orchestrator) {
        errors.push("Missing required section: orchestrator");
      }
      if (!config.terminal) {
        errors.push("Missing required section: terminal");
      }
      if (!config.memory) {
        errors.push("Missing required section: memory");
      }
      
      return {
        valid: errors.length === 0,
        errors,
      };
    } catch (error) {
      errors.push(`Failed to read or parse file: ${(error as Error).message}`);
      return {
        valid: false,
        errors,
      };
    }
  }

  /**
   * Backs up the current configuration
   */
  async backup(backupPath?: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = backupPath || join(homedir(), ".claude-flow", "backups", `backup-${timestamp}.json`);
    
    await fs.mkdir(join(homedir(), ".claude-flow", "backups"), { recursive: true });
    await fs.writeFile(backupFile, JSON.stringify(this.config, null, 2), "utf8");
    
    return backupFile;
  }

  /**
   * Restores configuration from a backup
   */
  async restore(backupPath: string): Promise<void> {
    const content = await fs.readFile(backupPath, "utf8");
    const backupConfig = JSON.parse(content);
    
    // Validate the backup configuration
    this.validate(backupConfig);
    
    // Apply the backup
    this.config = backupConfig;
    
    // Save to current config file
    if (this.configPath) {
      await this.save();
    }
  }

  /**
   * Gets configuration path history
   */
  getPathHistory(): string[] {
    // In a real implementation, this would track all config paths used
    return this.configPath ? [this.configPath] : [];
  }

  /**
   * Gets configuration change history
   */
  getChangeHistory(): Array<{ timestamp: Date; path: string; oldValue: unknown; newValue: unknown }> {
    // Convert string timestamps to Date objects for compatibility
    return this.changeHistory.map(change => ({
      timestamp: new Date(change.timestamp),
      path: change.path,
      oldValue: change.oldValue,
      newValue: change.newValue,
    }));
  }

  /**
   * Masks sensitive values in configuration
   */
  private maskSensitiveValues(config: Partial<Config>): Partial<Config> {
    const masked = JSON.parse(JSON.stringify(config));
    
    const maskValue = (obj: any, path: string = ""): void => {
      for (const [key, value] of Object.entries(obj)) {
        const fullPath = path ? `${path}.${key}` : key;
        
        if (SENSITIVE_PATHS.some(sensitive => 
          fullPath.toLowerCase().includes(sensitive.toLowerCase()) ||
          key.toLowerCase().includes(sensitive.toLowerCase()),
        )) {
          obj[key] = typeof value === "string" ? "****...****" : "[REDACTED]";
        } else if (typeof value === "object" && value !== null) {
          maskValue(value, fullPath);
        }
      }
    };
    
    maskValue(masked);
    return masked;
  }

  /**
   * Tracks configuration changes
   */
  private trackChanges(path: string, oldValue: unknown, newValue: unknown, options: { user?: string; reason?: string; source?: "cli" | "api" | "file" | "env" } = {}): void {
    const change: ConfigChange = {
      timestamp: new Date().toISOString(),
      path,
      oldValue,
      newValue,
      user: options.user,
      reason: options.reason,
      source: options.source ?? "api",
    };
    
    this.changeHistory.push(change);
    
    // Keep only last 100 changes
    if (this.changeHistory.length > 100) {
      this.changeHistory = this.changeHistory.slice(-100);
    }
  }

  /**
   * Track changes from config updates
   */
  private trackConfigChanges(oldConfig: Config, updates: Partial<Config>, options: { user?: string; reason?: string; source?: "cli" | "api" | "file" | "env" } = {}): void {
    // For now, just track that an update occurred
    this.trackChanges("config", oldConfig, updates, options);
  }

  /**
   * Records a configuration change
   */
  private recordChange(path: string, oldValue: unknown, newValue: unknown, options: { user?: string; reason?: string; source?: "cli" | "api" | "file" | "env" } = {}): void {
    this.trackChanges(path, oldValue, newValue, options);
  }

  /**
   * Checks if a configuration path is sensitive
   */
  private isSensitivePath(path: string): boolean {
    return SENSITIVE_PATHS.some(sensitive => 
      path.toLowerCase().includes(sensitive.toLowerCase()),
    );
  }

  /**
   * Encrypts a value if encryption is enabled
   */
  private encryptValue(value: string): string {
    if (!this.encryptionKey) return value;
    
    try {
      const algorithm = "aes-256-gcm";
      const iv = randomBytes(16);
      const cipher = createCipheriv(algorithm, this.encryptionKey, iv);
      
      let encrypted = cipher.update(value, "utf8", "hex");
      encrypted += cipher.final("hex");
      
      const authTag = cipher.getAuthTag();
      
      // Return iv:authTag:encrypted format
      return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
    } catch (error) {
      console.warn("Failed to encrypt value:", error);
      return value;
    }
  }

  /**
   * Checks if a value is encrypted
   */
  private isEncryptedValue(value: unknown): boolean {
    if (typeof value !== "string") return false;
    // New format: iv:authTag:encrypted (3 parts separated by colons)
    const parts = value.split(":");
    return parts.length === 3 && 
           parts[0].length === 32 && // IV is 16 bytes = 32 hex chars
           parts[1].length === 32 && // Auth tag is 16 bytes = 32 hex chars
           parts[2].length > 0;      // Encrypted data
  }

  /**
   * Decrypts a value if it's encrypted
   */
  private decryptValue(value: string): string {
    if (!this.encryptionKey) return value;
    
    try {
      const algorithm = "aes-256-gcm";
      const parts = value.split(":");
      
      if (parts.length !== 3) {
        // Not encrypted format, return as-is
        return value;
      }
      
      const iv = Buffer.from(parts[0], "hex");
      const authTag = Buffer.from(parts[1], "hex");
      const encrypted = parts[2];
      
      const decipher = createDecipheriv(algorithm, this.encryptionKey, iv);
      decipher.setAuthTag(authTag);
      
      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");
      
      return decrypted;
    } catch (error) {
      console.warn("Failed to decrypt value:", error);
      return value;
    }
  }
}

// Export singleton instance
export const configManager = ConfigManager.getInstance();

// Helper function to load configuration
export async function loadConfig(path?: string): Promise<Config> {
  await configManager.load(path);
  return configManager.get();
}

function deepClone<T>(obj: T, visited = new WeakMap()): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  // Check for circular reference
  if (visited.has(obj as object)) {
    return visited.get(obj as object) as T;
  }

  if (obj instanceof Date) {
    return new Date(obj.getTime()) as T;
  }

  if (obj instanceof Array) {
    const clonedArray = [] as unknown as T;
    visited.set(obj as object, clonedArray);
    (obj as unknown as unknown[]).forEach((item, index) => {
      (clonedArray as unknown as unknown[])[index] = deepClone(item, visited);
    });
    return clonedArray;
  }

  if (obj instanceof Map) {
    const map = new Map();
    visited.set(obj as object, map as T);
    obj.forEach((value, key) => {
      map.set(key, deepClone(value, visited));
    });
    return map as T;
  }

  if (obj instanceof Set) {
    const set = new Set();
    visited.set(obj as object, set as T);
    obj.forEach((value) => {
      set.add(deepClone(value, visited));
    });
    return set as T;
  }

  const cloned = {} as T;
  visited.set(obj as object, cloned);
  
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepClone(obj[key], visited);
    }
  }

  return cloned;
}

// Export types for external use
export type {
  FormatParser,
  ConfigChange,
  SecurityClassification,
  ValidationRule,
};

export {
  SENSITIVE_PATHS,
  SECURITY_CLASSIFICATIONS,
};

// Custom deepMerge for Config type
function deepMergeConfig(target: Config, ...sources: Partial<Config>[]): Config {
  const result = deepClone(target);
  
  for (const source of sources) {
    if (!source) continue;
    
    // Merge each section
    if (source.orchestrator) {
      result.orchestrator = { ...result.orchestrator, ...source.orchestrator };
    }
    if (source.terminal) {
      result.terminal = { ...result.terminal, ...source.terminal };
    }
    if (source.memory) {
      result.memory = { ...result.memory, ...source.memory };
    }
    if (source.coordination) {
      result.coordination = { ...result.coordination, ...source.coordination };
    }
    if (source.mcp) {
      result.mcp = { ...result.mcp, ...source.mcp };
    }
    if (source.logging) {
      result.logging = { ...result.logging, ...source.logging };
    }
    if (source.credentials) {
      result.credentials = { ...result.credentials, ...source.credentials };
    }
    if (source.security) {
      result.security = { ...result.security, ...source.security };
    }
  }
  
  return result;
}